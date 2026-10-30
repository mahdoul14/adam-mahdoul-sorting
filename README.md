# Adam Mahdoul Sorting

Talk to your Mac and watch it sort your Downloads folder.

Every photo and video drops into a spinning ball, re-forms as a colour wheel, then flies into folders: Travel, Content, Business, People & family, Food, Outfits, Nature, Animals and Duplicates. When it's done you get a "Downloads, Wrapped" recap of what you save the most.

Everything runs on your Mac. Photos are classified with Apple's on-device Vision framework, so nothing is uploaded and no API key is needed.

## Requirements

- macOS (uses Apple Vision, `sips` and `trash`)
- Node.js 20+
- Xcode command line tools (for `swiftc`): `xcode-select --install`
- ffmpeg, for video thumbnails: `brew install ffmpeg`

## Run it

```bash
git clone https://github.com/mahdoul14/adam-mahdoul-sorting.git
cd adam-mahdoul-sorting
npm run build   # compiles the on-device classifier
npm start
```

Open **http://localhost:8769** in Chrome and press **Sort**, or hold **Space** and say "sort my downloads".

## Voice commands

| Say | What happens |
|---|---|
| "Sort my downloads" | Scans and sorts the folder |
| "Pull up outfits" | Opens that folder |
| "Find sneakers" | Searches what's *in* your photos |
| "Show my wrapped" | Plays your Downloads recap |
| "Clear duplicates" / "yes" | Moves duplicates to the Bin (recoverable) |
| "Close", "mute" | Closes a view, silences the voice |

Voice input needs Chrome or Safari. You can always type commands in the bar instead.

## Your files are safe

Sorting only looks at your files; nothing is moved until you choose:

- **Copy into Sorted/** copies everything into `Downloads/Sorted/<Folder>`. Your originals stay where they are, but this uses extra disk space.
- **Move originals** moves the files instead, and asks you to confirm first.
- **Clear duplicates** sends extra copies to the Bin, where you can put them back from Finder.

To sort a different folder, change the path in the box next to the Sort button.

---

Built by [@adammahdoul](https://instagram.com/adammahdoul) with Claude Code.
