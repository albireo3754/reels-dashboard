import Foundation

public struct AppCandidate: Equatable, Sendable {
    public var pid: Int32
    public var path: String
    public var bundleId: String
    public init(pid: Int32, path: String, bundleId: String) {
        self.pid = pid; self.path = path; self.bundleId = bundleId
    }
}

public enum EditsApp {
    public static let path = "/Applications/Edits.app"
    public static let bundleId = "com.burbn.basel.mac"

    public static func process(in candidates: [AppCandidate]) throws -> AppCandidate? {
        let exact = candidates.filter {
            $0.pid > 0 && $0.path == path && $0.bundleId == bundleId
        }
        guard exact.count <= 1 else {
            throw AXFailure("EDITS_APP_AMBIGUOUS", "Multiple exact /Applications/Edits.app processes")
        }
        return exact.first
    }
}

public struct AppStatus: Codable, Equatable, Sendable {
    public var trusted: Bool
    public var appPath: String
    public var installed: Bool
    public var running: Bool
    public var pid: Int32?
    public var version: String?
    public var bundleId: String
    public var helperPid: Int32
    public var parentPid: Int32
    public var screenCaptureAllowed: Bool
    public var screenLocked: ScreenLockState

    public init(trusted: Bool, installed: Bool, pid: Int32?, version: String?, helperPid: Int32,
                parentPid: Int32, screenCaptureAllowed: Bool, screenLocked: ScreenLockState = .unknown) {
        self.trusted = trusted; self.appPath = EditsApp.path; self.installed = installed
        self.running = pid != nil; self.pid = pid; self.version = version
        self.bundleId = EditsApp.bundleId; self.helperPid = helperPid; self.parentPid = parentPid
        self.screenCaptureAllowed = screenCaptureAllowed
        self.screenLocked = screenLocked
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(trusted, forKey: .trusted); try c.encode(appPath, forKey: .appPath)
        try c.encode(installed, forKey: .installed); try c.encode(running, forKey: .running)
        try c.encode(pid, forKey: .pid); try c.encode(version, forKey: .version)
        try c.encode(bundleId, forKey: .bundleId); try c.encode(helperPid, forKey: .helperPid)
        try c.encode(parentPid, forKey: .parentPid); try c.encode(screenCaptureAllowed, forKey: .screenCaptureAllowed)
        try c.encode(screenLocked, forKey: .screenLocked)
    }
}
