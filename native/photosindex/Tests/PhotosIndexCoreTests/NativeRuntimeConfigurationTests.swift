import Foundation
import XCTest
@testable import PhotosIndexCore

final class NativeRuntimeConfigurationTests: XCTestCase {
    func testDefaultsAreIsolatedFromStandalonePhotosIndex() throws {
        let config = try NativeRuntimeConfiguration(
            environment: [:], arguments: [],
            homeDirectory: URL(fileURLWithPath: "/tmp/test-home"), userID: 123
        )
        XCTAssertEqual(config.socketPath, "/tmp/reels-photosindex-123.sock")
        XCTAssertEqual(config.supportRoot.path, "/tmp/test-home/Library/Application Support/ReelsDashboard/PhotosIndex")
        XCTAssertEqual(config.exportRoot.path, "/tmp/test-home/Library/Mobile Documents/com~apple~CloudDocs/Naver Clip")
    }

    func testLaunchArgumentsRoundTripEnvironmentIncludingSpacesAndKorean() throws {
        let cli = try NativeRuntimeConfiguration(environment: [
            "PHOTOSINDEX_SOCKET_PATH": "/tmp/reels-test.sock",
            "PHOTOSINDEX_EXPORT_ROOT": "/tmp/촬영 원본",
            "PHOTOSINDEX_SUPPORT_ROOT": "/tmp/app data"
        ], arguments: [])
        let helper = try NativeRuntimeConfiguration(environment: [:], arguments: cli.helperArguments)
        XCTAssertEqual(cli, helper)
    }

    func testLaunchArgumentsTakePriorityOverEnvironment() throws {
        let config = try NativeRuntimeConfiguration(
            environment: ["PHOTOSINDEX_SOCKET_PATH": "/tmp/env.sock"],
            arguments: ["--photosindex-socket", "/tmp/arg.sock"]
        )
        XCTAssertEqual(config.socketPath, "/tmp/arg.sock")
    }

    func testRejectsRelativeMissingAndNullPaths() throws {
        XCTAssertThrowsError(try NativeRuntimeConfiguration(environment: ["PHOTOSINDEX_EXPORT_ROOT": "relative"], arguments: []))
        XCTAssertThrowsError(try NativeRuntimeConfiguration(environment: [:], arguments: ["--photosindex-socket"]))
        XCTAssertThrowsError(try NativeRuntimeConfiguration(environment: ["PHOTOSINDEX_SUPPORT_ROOT": "/tmp/bad\0path"], arguments: []))
    }
}
