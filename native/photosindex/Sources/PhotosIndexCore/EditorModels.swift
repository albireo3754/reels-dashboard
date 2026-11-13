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

/// A local-only copy of one selected Photos original (photo or video) for a
/// dashboard bundle import. A Live Photo also carries its motion video copy.
/// Photos library identifiers and private location metadata are never returned.
public struct MediaMaterializationPayload: Codable, Equatable, Sendable {
    public let assetID: String
    public let mediaKind: MediaKind
    public let sourcePath: String
    public let pairedVideoPath: String?
    public let originalFilename: String?

    public init(
        assetID: String,
        mediaKind: MediaKind,
        sourcePath: String,
        pairedVideoPath: String?,
        originalFilename: String?
    ) {
        self.assetID = assetID
        self.mediaKind = mediaKind
        self.sourcePath = sourcePath
        self.pairedVideoPath = pairedVideoPath
        self.originalFilename = originalFilename
    }
}
