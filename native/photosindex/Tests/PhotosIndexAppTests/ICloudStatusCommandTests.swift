import Darwin
import Foundation
import XCTest
import PhotosIndexCommand
import PhotosIndexExport
import PhotosIndexPhotos
@testable import PhotosIndexApp

final class ICloudStatusCommandTests: XCTestCase {
    func testICloudStatusIsReadOnlyWithoutPhotosPermissionAndRejectsEscapes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("icloud-status-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("caption.txt")
        let contents = Data("synthetic".utf8)
        try contents.write(to: file)
        let router = AppCommandRouter(
            runtime: IndexRuntime(library: ICloudStatusPhotoLibrary(), timezone: TimeZone(identifier: "Asia/Seoul")!),
            permission: { "denied" }, requestAuthorization: { XCTFail("must not request Photos permission"); return "denied" },
            exportService: ExportCommandService(allowedRoot: root)
        )
        func call(_ paths: [String]) throws -> CommandResponse {
            router.handle(CommandRequest(method: "icloud.status", arguments: ["paths": String(data: try JSONEncoder().encode(paths), encoding: .utf8)!]))
        }
        let response = try call([file.path])
        XCTAssertTrue(response.ok)
        let status = try response.decodePayload(ICloudUploadStatus.self)
        XCTAssertEqual(status.files.count, 1)
        XCTAssertFalse(status.files[0].isUbiquitous)
        XCTAssertEqual(status.state, "failed")
        XCTAssertEqual(try Data(contentsOf: file), contents)
        let posix = try XCTUnwrap(realpath(file.path, nil))
        defer { free(posix) }
        XCTAssertTrue(try call([String(cString: posix)]).ok)
        XCTAssertFalse(try call([]).ok)
        XCTAssertFalse(try call([file.path, file.path]).ok)
        XCTAssertFalse(try call([root.path]).ok)
        XCTAssertFalse(try call(["/etc/hosts"]).ok)
        let link = root.appendingPathComponent("alias.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        XCTAssertFalse(try call([link.path]).ok)
        XCTAssertFalse(router.handle(CommandRequest(method: "icloud.status", arguments: ["paths": "not-json"])).ok)
    }
}

private struct ICloudStatusPhotoLibrary: PhotoLibraryReading {
    func authorizationStatus() -> PhotoAuthorizationStatus { .authorized }
    func requestAuthorization() async -> PhotoAuthorizationStatus { .authorized }
    func assets(from start: Date, to end: Date) throws -> [PhotoAsset] { [] }
}
