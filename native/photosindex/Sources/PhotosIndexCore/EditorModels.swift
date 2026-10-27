import Foundation

/// A local-only handle to a selected video prepared for the desktop editor.
/// Photos library identifiers and private location metadata are never returned.
public struct EditorMaterializationPayload: Codable, Equatable, Sendable {
    public let assetID: String
    public let sourcePath: String
    public let originalFilename: String?

    public init(assetID: String, sourcePath: String, originalFilename: String?) {
        self.assetID = assetID
        self.sourcePath = sourcePath
        self.originalFilename = originalFilename
    }
}
