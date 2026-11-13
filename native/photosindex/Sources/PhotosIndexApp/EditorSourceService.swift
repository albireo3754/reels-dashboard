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
    private let pairedVideo: (any PairedVideoMaterializing)?

    init(
        supportRoot: URL,
        materializer: any PhotoAssetMaterializing = PhotoKitAssetMaterializer(),
        pairedVideo: (any PairedVideoMaterializing)? = nil
    ) {
        self.supportRoot = supportRoot.standardizedFileURL
        self.materializer = materializer
        self.pairedVideo = pairedVideo ?? (materializer as? any PairedVideoMaterializing)
    }

    func materialize(asset: PhotoAsset) throws -> EditorMaterializationPayload {
        guard asset.mediaKind == .video else { throw EditorSourceError.videoRequired }
        let copied = try copy(asset: asset)
        return EditorMaterializationPayload(
            assetID: asset.id,
            sourcePath: copied.source.path,
            originalFilename: asset.publicFilename
        )
    }

    /// Photo or video copy for a bundle import. A Live Photo also copies its
    /// original motion video into the same private workspace.
    func materializeMedia(asset: PhotoAsset) throws -> MediaMaterializationPayload {
        let copied = try copy(asset: asset)
        return MediaMaterializationPayload(
            assetID: asset.id,
            mediaKind: asset.mediaKind,
            sourcePath: copied.source.path,
            pairedVideoPath: copied.paired?.path,
            originalFilename: asset.publicFilename
        )
    }

    private func copy(asset: PhotoAsset) throws -> (source: URL, paired: URL?) {
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
        guard staged.assetID == asset.id, staged.mediaKind == asset.mediaKind else {
            throw EditorSourceError.unsafeMaterializedFile
        }
        let output = try privateFile(staged.stagedURL, in: workspace)
        var paired: URL?
        if asset.mediaKind == .photo, let pairedVideo,
           let motion = try pairedVideo.stagePairedVideo(asset: asset, into: workspace) {
            let file = try privateFile(motion, in: workspace)
            guard file.path != output.path else { throw EditorSourceError.unsafeMaterializedFile }
            paired = file
        }
        completed = true
        return (output, paired)
    }

    private func privateFile(_ url: URL, in workspace: URL) throws -> URL {
        let output = url.standardizedFileURL
        guard output.deletingLastPathComponent().path == workspace.path else {
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
        return output
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
