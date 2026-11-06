// Render captions offline. These images are appended below the captured screen.
import AppKit
import Foundation
let args = CommandLine.arguments
if args.count != 3 { fatalError("Usage: captions caption-manifest.json output-directory") }
let data = try Data(contentsOf: URL(fileURLWithPath: args[1]))
let rows = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
for (index, row) in rows.enumerated() {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1920,
        pixelsHigh: 128, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor(calibratedWhite: 0.07, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: 1920, height: 128).fill()
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    paragraph.lineBreakMode = .byWordWrapping
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 32, weight: .medium),
        .foregroundColor: NSColor.white, .paragraphStyle: paragraph
    ]
    let text = row["text"] as! String
    (text as NSString).draw(in: NSRect(x: 80, y: 22, width: 1760, height: 84), withAttributes: attributes)
    NSGraphicsContext.restoreGraphicsState()
    let output = URL(fileURLWithPath: args[2]).appendingPathComponent("caption-\(index).png")
    try bitmap.representation(using: .png, properties: [:])!.write(to: output)
}
