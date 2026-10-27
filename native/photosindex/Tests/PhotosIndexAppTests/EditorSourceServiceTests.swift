import Foundation
import XCTest
import PhotosIndexCommand
import PhotosIndexCore
import PhotosIndexExport
import PhotosIndexPhotos
@testable import PhotosIndexApp

final class EditorSourceServiceTests: XCTestCase {
    func testMaterializesSelectedVideoIntoPrivateCacheWithoutChangingOriginal() throws {
        let fixture = try makeFixture()
        let response = fixture.router.handle(request(fixture))
        XCTAssertTrue(response.ok)
        let result = try response.decodePayload(EditorMaterializationPayload.self)
        let output = URL(fileURLWithPath: result.sourcePath)
        XCTAssertEqual(result.assetID, fixture.video.id)
        XCTAssertEqual(result.originalFilename, "IMG_EDITOR.MOV")
        XCTAssertEqual(output.deletingLastPathComponent().deletingLastPathComponent(), fixture.support.resolvingSymlinksInPath().appendingPathComponent("editor-sources", isDirectory: true))
        XCTAssertNotNil(UUID(uuidString: output.deletingLastPathComponent().lastPathComponent))
        XCTAssertEqual(try Data(contentsOf: output), fixture.originalBytes)
        XCTAssertEqual(try Data(contentsOf: fixture.original), fixture.originalBytes)
        XCTAssertEqual(fixture.materializer.calls, 1)
        XCTAssertEqual(try mode(output), 0o600)
        XCTAssertEqual(try mode(output.deletingLastPathComponent()), 0o700)
        XCTAssertEqual(try mode(output.deletingLastPathComponent().deletingLastPathComponent()), 0o700)
        XCTAssertFalse(String(decoding: try CanonicalJSON.encode(result), as: UTF8.self).contains(fixture.video.localIdentifier))
    }

    func testRejectsStaleRunBeforeMaterializing() throws {
        let fixture = try makeFixture()
        var arguments = request(fixture).arguments
        arguments["index-run"] = "old-run"
        let response = fixture.router.handle(CommandRequest(method: "editor.materialize", arguments: arguments))
        XCTAssertEqual(response.error?.code, "stale-index-run")
        XCTAssertEqual(fixture.materializer.calls, 0)
    }

    func testRejectsAssetFromDifferentGroupBeforeMaterializing() throws {
        let fixture = try makeFixture()
        var arguments = request(fixture).arguments
        arguments["asset-id"] = fixture.otherVideo.id
        let response = fixture.router.handle(CommandRequest(method: "editor.materialize", arguments: arguments))
        XCTAssertEqual(response.error?.code, "editor-asset-not-in-group")
        XCTAssertEqual(fixture.materializer.calls, 0)
    }

    func testRejectsPhotoBeforeMaterializing() throws {
        let fixture = try makeFixture()
        var arguments = request(fixture).arguments
        arguments["asset-id"] = fixture.photo.id
        let response = fixture.router.handle(CommandRequest(method: "editor.materialize", arguments: arguments))
        XCTAssertEqual(response.error?.code, "editor-video-required")
        XCTAssertEqual(fixture.materializer.calls, 0)
    }

    func testRequiresPhotosPermissionEvenWithExistingIndex() throws {
        let fixture = try makeFixture(permission: "denied")
        let response = fixture.router.handle(request(fixture))
        XCTAssertEqual(response.error?.code, "photos-permission-required")
        XCTAssertEqual(fixture.materializer.calls, 0)
    }

    func testRejectsRendererProvidedOutputDirectory() throws {
        let fixture = try makeFixture()
        var arguments = request(fixture).arguments
        arguments["output"] = fixture.root.appendingPathComponent("renderer-output").path
        let response = fixture.router.handle(CommandRequest(method: "editor.materialize", arguments: arguments))
        XCTAssertEqual(response.error?.code, "invalid-arguments")
        XCTAssertEqual(fixture.materializer.calls, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: arguments["output"]!))
    }

    func testRejectsMaterializerFileOutsidePrivateWorkspace() throws {
        let fixture = try makeFixture(behavior: .outside)
        let response = fixture.router.handle(request(fixture))
        XCTAssertFalse(response.ok)
        XCTAssertEqual(fixture.materializer.calls, 1)
        XCTAssertEqual(try Data(contentsOf: fixture.original), fixture.originalBytes)
        XCTAssertEqual(try cachedWorkspaces(fixture), [])
    }

    func testRejectsSymlinkCacheBeforeMaterializing() throws {
        let fixture = try makeFixture()
        try FileManager.default.createDirectory(at: fixture.support, withIntermediateDirectories: true)
        let outside = fixture.root.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: fixture.support.appendingPathComponent("editor-sources"), withDestinationURL: outside)
        let response = fixture.router.handle(request(fixture))
        XCTAssertFalse(response.ok)
        XCTAssertEqual(fixture.materializer.calls, 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])
    }

    func testCleansPartialWorkspaceWhenMaterializerFails() throws {
        let fixture = try makeFixture(behavior: .partialFailure)
        XCTAssertFalse(fixture.router.handle(request(fixture)).ok)
        XCTAssertEqual(try cachedWorkspaces(fixture), [])
        XCTAssertEqual(try Data(contentsOf: fixture.original), fixture.originalBytes)
    }

    func testRepeatedPreparationUsesSeparateCacheDirectories() throws {
        let fixture = try makeFixture(permission: "limited")
        let first = try fixture.router.handle(request(fixture)).decodePayload(EditorMaterializationPayload.self)
        let second = try fixture.router.handle(request(fixture)).decodePayload(EditorMaterializationPayload.self)
        XCTAssertNotEqual(first.sourcePath, second.sourcePath)
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.sourcePath))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.sourcePath))
        XCTAssertEqual(fixture.materializer.calls, 2)
    }

    private func mode(_ url: URL) throws -> Int {
        (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber).intValue
    }

    private func cachedWorkspaces(_ fixture: Fixture) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: fixture.support.appendingPathComponent("editor-sources").path)
    }

    private func request(_ fixture: Fixture) -> CommandRequest {
        CommandRequest(method: "editor.materialize", arguments: [
            "id": fixture.group.id,
            "index-run": fixture.runID,
            "asset-id": fixture.video.id,
        ])
    }

    private func makeFixture(permission: String = "authorized", behavior: FakeMaterializer.Behavior = .copy) throws -> Fixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("reels-editor-test-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let original = root.appendingPathComponent("original.MOV")
        let bytes = Data("synthetic original video bytes".utf8)
        try bytes.write(to: original)
        let date = ISO8601DateFormatter().date(from: "2026-08-16T03:00:00Z")!
        func asset(_ privateID: String, _ kind: MediaKind, _ offset: TimeInterval) -> PhotoAsset {
            PhotoAssetMapper.map(PhotoMetadataInput(
                localIdentifier: privateID, capturedAt: date.addingTimeInterval(offset),
                mediaKind: kind, durationSeconds: kind == .video ? 3 : 0,
                pixelWidth: 1920, pixelHeight: 1080, coordinate: nil,
                originalFilename: kind == .video ? "IMG_EDITOR.MOV" : "IMG_EDITOR.HEIC"
            ))
        }
        let video = asset("PRIVATE-PHOTOKIT-VIDEO-ID", .video, 0)
        let photo = asset("PRIVATE-PHOTOKIT-PHOTO-ID", .photo, 60)
        let otherVideo = asset("PRIVATE-PHOTOKIT-OTHER-ID", .video, 7200)
        let library = EditorFakeLibrary(storedAssets: [video, photo, otherVideo])
        let runtime = IndexRuntime(library: library, timezone: TimeZone(identifier: "Asia/Seoul")!)
        let run = try runtime.sync(localDate: "2026-08-16")
        let group = runtime.groups(level: .fine).groups.first(where: { $0.assetIDs.contains(video.id) })!
        XCTAssertFalse(group.assetIDs.contains(otherVideo.id))
        let support = root.appendingPathComponent("Private Support", isDirectory: true)
        let materializer = FakeMaterializer(original: original, behavior: behavior)
        let router = AppCommandRouter(
            runtime: runtime, permission: { permission }, requestAuthorization: { permission },
            editorSourceService: EditorSourceService(supportRoot: support, materializer: materializer)
        )
        return Fixture(root: root, support: support, original: original, originalBytes: bytes,
                       video: video, photo: photo, otherVideo: otherVideo, group: group,
                       runID: run.indexRunID, router: router, materializer: materializer)
    }
}

private struct Fixture {
    let root: URL
    let support: URL
    let original: URL
    let originalBytes: Data
    let video: PhotoAsset
    let photo: PhotoAsset
    let otherVideo: PhotoAsset
    let group: CaptureGroup
    let runID: String
    let router: AppCommandRouter
    let materializer: FakeMaterializer
}

private struct EditorFakeLibrary: PhotoLibraryReading {
    let storedAssets: [PhotoAsset]
    func authorizationStatus() -> PhotoAuthorizationStatus { .authorized }
    func requestAuthorization() async -> PhotoAuthorizationStatus { .authorized }
    func assets(from start: Date, to end: Date) throws -> [PhotoAsset] { storedAssets }
}

private final class FakeMaterializer: PhotoAssetMaterializing, @unchecked Sendable {
    enum Behavior { case copy, outside, partialFailure }
    let original: URL
    let behavior: Behavior
    private(set) var calls = 0
    init(original: URL, behavior: Behavior) { self.original = original; self.behavior = behavior }
    func stage(asset: PhotoAsset, into stagingRoot: URL) throws -> StagedExportAsset {
        calls += 1
        let destination = behavior == .outside ? original : stagingRoot.appendingPathComponent("IMG_EDITOR.MOV")
        if behavior != .outside { try FileManager.default.copyItem(at: original, to: destination) }
        if behavior == .partialFailure { throw CocoaError(.fileWriteUnknown) }
        return StagedExportAsset(assetID: asset.id, mediaKind: asset.mediaKind,
                                 safeFilename: "IMG_EDITOR.MOV", stagedURL: destination,
                                 bytes: Int64(try Data(contentsOf: destination).count), sha256: "fixture")
    }
}
