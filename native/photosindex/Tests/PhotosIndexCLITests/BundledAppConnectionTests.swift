import Foundation
import XCTest
@testable import PhotosIndexCLI

final class BundledAppConnectionTests: XCTestCase {
    func testResolvesHelperBesidePackagedCLIWithUnicodeAndSpaces() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("reels helper 한글 \(UUID().uuidString)", isDirectory: true)
        let helper = root.appendingPathComponent("PhotosIndex.app", isDirectory: true)
        try FileManager.default.createDirectory(at: helper, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertEqual(
            AppConnection(environment: [:]).resolveAppPath(executableURL: root.appendingPathComponent("photosindex")),
            helper.path
        )
    }

    func testMissingBundledHelperDoesNotDiscoverAnInstalledApp() {
        let missing = URL(fileURLWithPath: "/tmp/nonexistent-\(UUID().uuidString)/photosindex")
        XCTAssertNil(AppConnection(environment: [:]).resolveAppPath(executableURL: missing))
    }
}
