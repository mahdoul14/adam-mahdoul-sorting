// Sorter — scans a folder, classifies photos/videos on-device (Apple Vision),
// finds duplicates, streams progress to the UI over SSE, and copies into Sorted/.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8769);
const CACHE = path.join(ROOT, '.cache', 'thumbs');
const MINI = path.join(ROOT, '.cache', 'mini'); // tiny tiles for the animation, cheap to decode
const CLASSIFIER = path.join(ROOT, 'bin', 'classify');
const DEFAULT_DIR = path.join(os.homedir(), 'Downloads');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(MINI, { recursive: true });

const PHOTO_EXT = /\.(jpe?g|png|heic|heif|webp|gif|tiff?|bmp)$/i;
const VIDEO_EXT = /\.(mov|mp4|m4v|avi|mkv|webm)$/i;

let lastRun = null; // { dir, items } — what /api/apply acts on

// ---------- helpers ----------

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 30000 }, (err) => resolve(!err)));
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

async function makeThumb(item) {
  const out = path.join(CACHE, item.key + '.jpg');
  const mini = path.join(MINI, item.key + '.jpg');
  let ok = fs.existsSync(out);
  if (!ok && item.kind === 'video') {
    ok = await run('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', item.path, '-frames:v', '1',
      '-vf', 'scale=360:360:force_original_aspect_ratio=increase,crop=360:360', '-y', out]);
  } else if (!ok) {
    ok = await run('sips', ['-s', 'format', 'jpeg', '-Z', '360', item.path, '--out', out]);
  }
  if (ok && !fs.existsSync(mini)) {
    await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '80', out, '--out', mini]);
  }
  return ok;
}

async function sha1(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', () => resolve(null));
  });
}

// Keeps N Vision classifier processes open; push() feeds one image, onResult gets each answer.
function classifierPool(onResult, procs = 3) {
  const workers = Array.from({ length: procs }, () => {
    const p = spawn(CLASSIFIER, ['--no-text']);
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try { onResult(JSON.parse(line)); } catch {}
      }
    });
    return { p, closed: new Promise((r) => p.on('close', r)) };
  });
  let i = 0;
  return {
    push: (file) => workers[i++ % procs].p.stdin.write(file + '\n'),
    end: () => { workers.forEach((w) => w.p.stdin.end()); return Promise.all(workers.map((w) => w.closed)); },
  };
}

// Vision results survive restarts, so a second sort of the same folder is instant.
const VISION_CACHE = path.join(ROOT, '.cache', 'vision.json');
const visionCache = (() => { try { return JSON.parse(fs.readFileSync(VISION_CACHE, 'utf8')); } catch { return {}; } })();
const saveVisionCache = () => fsp.writeFile(VISION_CACHE, JSON.stringify(visionCache)).catch(() => {});

// File hashes, keyed by path+size+mtime, so re-checking duplicates is instant.
const HASH_CACHE = path.join(ROOT, '.cache', 'hashes.json');
const hashCache = (() => { try { return JSON.parse(fs.readFileSync(HASH_CACHE, 'utf8')); } catch { return {}; } })();

// ---------- categorisation ----------

const AI_NAME = /^(chatgpt|gen[-_ ]|gemini|magnific|hf[_-]|midjourney|mj[_-]|dall|firefly|ideogram|flux|leonardo|sora|kling|higgsfield|runway|veo)/i;
const SCREENSHOT_NAME = /(screenshot|screen shot|cleanshot|^simulator screen)/i;
const SCREENREC_NAME = /(screen recording|screenrecording|^rpreplay)/i;

const RULES = {
  'People & family': /^(people|adult|child|baby|portrait|selfie|crowd|bride|groom|wedding|celebration|birthday_cake|ceremony)$/,
  'Outfits': /^(clothing|footwear|shoes|sneaker|jacket|jeans|hoodie|coat|dress|shirt|t_shirt|sweater|high_heel|boot|hat|baseball_hat|beanie|sunglasses|jewelry|bag|sportswear|suit|scarf|sock|apparel)$/,
  'Food': /^(food|drink|dessert|fruit|coffee|baked_goods|bread|cake|pizza|pasta|salad|sushi|burger|hamburger|cocktail|wine|beer|juice|vegetable|sandwich|cookie|ice_cream|tea|meal)$/,
  'Animals': /^(animal|mammal|canine|feline|dog|cat|bird|insect|fish|horse|reptile|puppy|kitten)$/,
  'Nature': /^(plant|flower|tree|foliage|sky|blue_sky|cloudy|sunset_sunrise|mountain|forest|land|water|waterways|lake|ocean|sea|grass|garden|hill|desert|snow|field)$/,
  'Travel': /^(structure|building|cityscape|architecture|street|bridge|airport|aircraft|airplane|beach|harbour|castle|landmark|tower|skyscraper|hotel|road|monument|church|temple|museum|swimming_pool|cruise_ship|island|outdoor)$/,
  'Business': /^(document|screenshot|handwriting|diagram|chart|map|receipt|menu|book|paper|computer|laptop|computer_monitor|consumer_electronics|conference|office|desk|whiteboard|sign|credit_card|calendar)$/,
  'Content': /^(illustrations|art|painting|cartoon|graphic|poster|camera|microphone|studio)$/,
};

// Returns a category from the filename alone, or null if we need to look at the image.
function categoriseByName(item) {
  if (SCREENSHOT_NAME.test(item.name)) return 'Business';
  if (AI_NAME.test(item.name) || SCREENREC_NAME.test(item.name)) return 'Content';
  return null;
}

function categorise(v) {
  if (!v || v.error) return 'Other';
  const score = Object.fromEntries(Object.keys(RULES).map((k) => [k, 0]));
  for (const [label, conf] of v.labels || []) {
    for (const [cat, re] of Object.entries(RULES)) if (re.test(label)) score[cat] += conf;
  }
  score['People & family'] += Math.min(v.faces || 0, 3) * 0.5;
  score['Travel'] *= 0.8; // "outdoor"/"structure" fire on almost everything
  const [best, s] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return s >= 0.3 ? best : 'Other';
}

// ---------- pipeline ----------

async function sortFolder(dir, send) {
  const names = (await fsp.readdir(dir)).filter((n) => !n.startsWith('.'));
  const items = [];
  for (const name of names) {
    const kind = PHOTO_EXT.test(name) ? 'photo' : VIDEO_EXT.test(name) ? 'video' : null;
    if (!kind) continue;
    const p = path.join(dir, name);
    const st = await fsp.stat(p).catch(() => null);
    if (!st || !st.isFile()) continue;
    const key = crypto.createHash('md5').update(p + st.size + st.mtimeMs).digest('hex');
    items.push({ id: items.length, name, kind, path: p, size: st.size, key });
  }
  send('scan', {
    dir,
    items: items.map(({ id, name, kind, key, size }) => ({ id, name, kind, size, thumb: `/thumb/${key}.jpg`, mini: `/mini/${key}.jpg` })),
  });

  // Duplicates first (cheap: only same-size files get hashed) so they can fly straight away.
  const bySize = new Map();
  for (const it of items) bySize.set(it.size, [...(bySize.get(it.size) || []), it]);
  const seen = new Map();
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    for (const it of group) {
      const h = hashCache[it.key] || (hashCache[it.key] = await sha1(it.path));
      if (!h) continue;
      if (seen.has(h)) it.dupeOf = seen.get(h); else seen.set(h, it.id);
    }
  }

  let sorted = 0;
  const assign = (it, category, v) => {
    it.category = category;
    // Labels let the UI answer "find sneakers" without another round trip.
    send('sorted', { id: it.id, category, labels: (v?.labels || []).map(([l]) => l) });
    if (++sorted % 10 === 0 || sorted === items.length) send('progress', { phase: 'Looking at every image', done: sorted, total: items.length });
  };

  const byThumb = new Map();
  const vision = classifierPool((r) => {
    const it = byThumb.get(r.path);
    if (!it) return;
    visionCache[it.key] = r;
    assign(it, categorise(r), r);
  });

  let ready = [];
  const flushReady = () => { if (ready.length) send('thumbs', { ids: ready }); ready = []; };
  await pool(items, 8, async (it) => {
    const ok = await makeThumb(it);
    ready.push(it.id);
    if (ready.length >= 20) flushReady();
    if (it.dupeOf != null) return assign(it, 'Duplicates');
    const byName = categoriseByName(it);
    if (byName) return assign(it, byName);
    if (visionCache[it.key]) return assign(it, categorise(visionCache[it.key]), visionCache[it.key]);
    if (!ok) return assign(it, 'Other');
    const thumb = path.join(CACHE, it.key + '.jpg');
    byThumb.set(thumb, it);
    vision.push(thumb);
  });
  flushReady();
  await vision.end();
  for (const it of items) if (!it.category) assign(it, 'Other');
  await saveVisionCache();
  await fsp.writeFile(HASH_CACHE, JSON.stringify(hashCache)).catch(() => {});

  lastRun = { dir, items };
  send('done', { total: items.length });
}

async function applySort(mode) {
  if (!lastRun) throw new Error('Nothing sorted yet');
  const base = path.join(lastRun.dir, 'Sorted');
  let n = 0;
  for (const it of lastRun.items) {
    const destDir = path.join(base, it.category);
    await fsp.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, it.name);
    if (fs.existsSync(dest)) continue;
    if (mode === 'move') await fsp.rename(it.path, dest);
    else await fsp.copyFile(it.path, dest, fs.constants.COPYFILE_EXCL);
    n++;
  }
  if (mode === 'move') lastRun = null;
  return { files: n, folder: base };
}

// Duplicates go to the Bin via macOS `trash`, so they can still be put back from Finder.
async function trashDupes() {
  if (!lastRun) throw new Error('Nothing sorted yet');
  const dupes = lastRun.items.filter((it) => it.dupeOf != null && fs.existsSync(it.path));
  for (let i = 0; i < dupes.length; i += 100) {
    const ok = await run('/usr/bin/trash', dupes.slice(i, i + 100).map((it) => it.path));
    if (!ok) throw new Error('Could not move duplicates to the Bin');
  }
  const bytes = dupes.reduce((a, it) => a + it.size, 0);
  lastRun.items = lastRun.items.filter((it) => it.dupeOf == null);
  return { files: dupes.length, bytes };
}

// ---------- http ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/sort') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const dir = url.searchParams.get('dir') || DEFAULT_DIR;
    try { await sortFolder(dir.replace(/^~/, os.homedir()), send); }
    catch (e) { send('failure', { message: e.message }); }
    return res.end();
  }

  if (url.pathname === '/api/apply' && req.method === 'POST') {
    const mode = url.searchParams.get('mode') === 'move' ? 'move' : 'copy';
    try { res.end(JSON.stringify(await applySort(mode))); }
    catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (url.pathname === '/api/trash-dupes' && req.method === 'POST') {
    try { res.end(JSON.stringify(await trashDupes())); }
    catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // Many mini thumbnails in one response: [u32 length][jpeg bytes] per key, in request order.
  if (url.pathname === '/api/minis') {
    const keys = (url.searchParams.get('k') || '').split('.').filter((k) => /^[0-9a-f]{32}$/.test(k)).slice(0, 200);
    const parts = await Promise.all(keys.map((k) => fsp.readFile(path.join(MINI, k + '.jpg')).catch(() => Buffer.alloc(0))));
    const out = Buffer.alloc(parts.reduce((a, b) => a + 4 + b.length, 0));
    let o = 0;
    for (const b of parts) { out.writeUInt32LE(b.length, o); b.copy(out, o + 4); o += 4 + b.length; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(out);
  }

  if (url.pathname.startsWith('/thumb/') || url.pathname.startsWith('/mini/')) {
    const file = path.join(url.pathname.startsWith('/mini/') ? MINI : CACHE, path.basename(url.pathname));
    return fs.createReadStream(file)
      .on('open', () => res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' }))
      .on('error', () => { res.writeHead(404); res.end(); })
      .pipe(res);
  }

  const file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Sorter on http://localhost:${PORT}`));
