import Darwin
import Foundation

/// Local process ownership information, never part of a dashboard snapshot.
public struct HelperInstanceRecord: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let instanceID: String
    public let pid: Int32
    public let executablePath: String
    public let socketPath: String

    public init(
        instanceID: String = UUID().uuidString,
        pid: Int32 = getpid(),
        executablePath: String,
        socketPath: String
    ) {
        self.schemaVersion = 1
        self.instanceID = instanceID
        self.pid = pid
        self.executablePath = executablePath
        self.socketPath = socketPath
    }
}

public struct HelperInstanceStore: Sendable {
    public enum StoreError: Error {
        case unsafeDirectory
        case unsafeRecord
        case writeFailed
    }

    public let root: URL
    public var recordURL: URL { root.appendingPathComponent("helper-instance.json") }

    public init(root: URL) { self.root = root }

    public func publish(_ record: HelperInstanceRecord) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(root.path, &info) == 0,
              info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid() else {
            throw StoreError.unsafeDirectory
        }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(record)
        let temporary = root.appendingPathComponent(".helper-instance-\(UUID().uuidString).json")
        guard manager.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw StoreError.writeFailed
        }
        defer { try? manager.removeItem(at: temporary) }
        guard rename(temporary.path, recordURL.path) == 0 else {
            throw StoreError.writeFailed
        }
    }

    public func read() throws -> HelperInstanceRecord? {
        let descriptor = open(recordURL.path, O_RDONLY | O_NOFOLLOW)
        if descriptor < 0 {
            if errno == ENOENT { return nil }
            throw StoreError.unsafeRecord
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              info.st_size <= 8192 else {
            throw StoreError.unsafeRecord
        }
        let data = try handle.read(upToCount: 8193) ?? Data()
        guard data.count <= 8192 else { throw StoreError.unsafeRecord }
        return try JSONDecoder().decode(HelperInstanceRecord.self, from: data)
    }

    /// A previous process must never remove a replacement process's record.
    public func removeIfOwned(by record: HelperInstanceRecord) throws {
        guard try read() == record else { return }
        try FileManager.default.removeItem(at: recordURL)
    }
}
