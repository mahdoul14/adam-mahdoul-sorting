// Reads image paths (one per line) from stdin, writes one JSON object per line:
// {"path":..., "labels":[[id,conf],...], "faces":n, "text":chars}
import Foundation
import Vision

if CommandLine.arguments.contains("--list") {
  let ids = (try? VNClassifyImageRequest().supportedIdentifiers()) ?? []
  print(ids.joined(separator: "\n")); exit(0)
}

while let line = readLine() {
  let path = line.trimmingCharacters(in: .whitespaces)
  if path.isEmpty { continue }
  let url = URL(fileURLWithPath: path)
  let handler = VNImageRequestHandler(url: url, options: [:])
  let cls = VNClassifyImageRequest()
  let faces = VNDetectFaceRectanglesRequest()
  let text = VNRecognizeTextRequest()
  text.recognitionLevel = .fast
  text.usesLanguageCorrection = false
  var out: [String: Any] = ["path": path]
  do {
    try handler.perform(CommandLine.arguments.contains("--no-text") ? [cls, faces] : [cls, faces, text])
    let labels = (cls.results ?? []).filter { $0.confidence > 0.15 }.prefix(8)
    out["labels"] = labels.map { [$0.identifier, Double(String(format: "%.2f", $0.confidence))!] }
    out["faces"] = faces.results?.count ?? 0
    out["text"] = (text.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined().count
  } catch {
    out["error"] = error.localizedDescription
  }
  let data = try! JSONSerialization.data(withJSONObject: out)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
