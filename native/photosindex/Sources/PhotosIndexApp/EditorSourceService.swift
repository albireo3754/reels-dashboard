import Darwin
import Foundation
import PhotosIndexCore
import PhotosIndexExport
import PhotosIndexPhotos

enum EditorSourceError: Error, Equatable {
    case videoRequired
    case unsafeDirectory
    case unsafeMaterializedFile
}

/// Copies one selected original into an app-owned cache. It has no deletion
/// dependency and never accepts a destination from a renderer request.
struct EditorSourceService: Sendable {
    private let supportRoot: URL
    private let materializer: any PhotoAssetMaterializing

    init(
        supportRoot: URL,
        materializer: any PhotoAssetMaterializing = PhotoKitAssetMaterializer()
    ) {
        self.supportRoot = supportRoot.standardizedFileURL
        self.materializer = materializer
    }

    func materialize(asset: PhotoAsset) throws -> EditorMaterializationPayload {
        guard asset.mediaKind == .video else { throw EditorSourceError.videoRequired }
        try privateDirectory(supportRoot)
        let sources = supportRoot.resolvingSymlinksInPath()
            .appendingPathComponent("editor-sources", isDirectory: true)
        try privateDirectory(sources)
        let workspace = sources.appendingPathComponent(UUID().uuidString, isDirectory: true)
        guard mkdir(workspace.path, 0o700) == 0 else { throw EditorSourceError.unsafeDirectory }
        var completed = false
        defer {
            if !completed { try? FileManager.default.removeItem(at: workspace) }
        }
        let staged = try materializer.stage(asset: asset, into: workspace)
        let output = staged.stagedURL.standardizedFileURL
        guard staged.assetID == asset.id, staged.mediaKind == .video,
              output.deletingLastPathComponent().path == workspace.path else {
            throw EditorSourceError.unsafeMaterializedFile
        }
        var info = stat()
        guard lstat(output.path, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_size > 0,
              output.resolvingSymlinksInPath().path == output.path else {
            throw EditorSourceError.unsafeMaterializedFile
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        completed = true
        return EditorMaterializationPayload(
            assetID: asset.id,
            sourcePath: output.path,
            originalFilename: asset.publicFilename
        )
    }

    private func privateDirectory(_ directory: URL) throws {
        var info = stat()
        if lstat(directory.path, &info) != 0 {
            guard errno == ENOENT else { throw EditorSourceError.unsafeDirectory }
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
        guard lstat(directory.path, &info) == 0,
              info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid() else {
            throw EditorSourceError.unsafeDirectory
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }
}
