import Foundation
// FileManager chooses the correct macOS Trash and resolves name collisions.
// No unlink, permanent deletion, shell commands, or Trash emptying.
do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "Retention", code: 1) }
    let source = URL(fileURLWithPath: CommandLine.arguments[1])
    var destination: NSURL?
    try FileManager.default.trashItem(at: source, resultingItemURL: &destination)
    let data = try JSONSerialization.data(withJSONObject: ["destination": destination?.path ?? "macOS Trash"])
    print(String(decoding: data, as: UTF8.self))
} catch {
    fputs("macOS Trash move failed; source preserved if still present.\n", stderr)
    exit(1)
}
