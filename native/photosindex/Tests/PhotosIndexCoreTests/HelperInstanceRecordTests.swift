import Darwin
import Foundation
import XCTest
@testable import PhotosIndexCore

final class HelperInstanceRecordTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("reels-instance-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func record(_ id: String) -> HelperInstanceRecord {
        HelperInstanceRecord(instanceID: id, pid: 123,
                             executablePath: "/tmp/Reels Dashboard.app/Contents/Resources/native/PhotosIndex.app/Contents/MacOS/PhotosIndex",
                             socketPath: "/tmp/reels-instance-test.sock")
    }

    func testPublishesOwnerOnlyRecordAndDirectory() throws {
        let store = HelperInstanceStore(root: try directory())
        let expected = record("first")
        try store.publish(expected)
        XCTAssertEqual(try store.read(), expected)
        let directoryMode = try FileManager.default.attributesOfItem(atPath: store.root.path)[.posixPermissions] as? NSNumber
        let fileMode = try FileManager.default.attributesOfItem(atPath: store.recordURL.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(directoryMode?.intValue, 0o700)
        XCTAssertEqual(fileMode?.intValue, 0o600)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: store.root.path), ["helper-instance.json"])
    }

    func testOldInstanceCannotRemoveReplacementRecord() throws {
        let store = HelperInstanceStore(root: try directory())
        let first = record("first")
        let second = record("second")
        try store.publish(first)
        try store.publish(second)
        try store.removeIfOwned(by: first)
        XCTAssertEqual(try store.read(), second)
        try store.removeIfOwned(by: second)
        XCTAssertNil(try store.read())
    }

    func testRejectsSymlinkDirectoryAndRecord() throws {
        let root = try directory()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let target = root.appendingPathComponent("target")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        let link = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertThrowsError(try HelperInstanceStore(root: link).publish(record("first")))
        let store = HelperInstanceStore(root: target)
        let other = root.appendingPathComponent("other.json")
        try Data("{}".utf8).write(to: other)
        try FileManager.default.createSymbolicLink(at: store.recordURL, withDestinationURL: other)
        XCTAssertThrowsError(try store.read())
        XCTAssertThrowsError(try store.removeIfOwned(by: record("first")))
        XCTAssertTrue(FileManager.default.fileExists(atPath: other.path))
    }

    func testRejectsWorldReadableMetadata() throws {
        let store = HelperInstanceStore(root: try directory())
        try store.publish(record("first"))
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: store.recordURL.path)
        XCTAssertThrowsError(try store.read())
    }
}
