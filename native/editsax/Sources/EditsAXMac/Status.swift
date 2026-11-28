import AppKit
import ApplicationServices
import CoreGraphics
import EditsAXCore

@MainActor public enum MacStatus {
    private struct ShareLease: Decodable {
        let parentPid: Int32
        let expiresAt: Double
        let observedUnlock: Bool
    }

    public static func finalShareObservation(_ path: String) -> Bool? {
        let file = URL(fileURLWithPath: path)
        guard file.lastPathComponent == "lease.json",
              file.deletingLastPathComponent().lastPathComponent.hasPrefix("reels-share-session-"),
              let data = try? Data(contentsOf: file), data.count <= 256,
              let lease = try? JSONDecoder().decode(ShareLease.self, from: data),
              lease.parentPid == getppid() else { return nil }
        let remaining = lease.expiresAt - Date().timeIntervalSince1970 * 1000
        guard remaining > 0, remaining <= 2300 else { return nil }
        return lease.observedUnlock
    }

    static func finalShareOnConsole() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as NSDictionary? else { return false }
        return [kCGSessionOnConsoleKey, kCGSessionLoginDoneKey].allSatisfy { key in
            guard let raw = session.object(forKey: key), CFGetTypeID(raw as CFTypeRef) == CFBooleanGetTypeID() else { return false }
            return (raw as? Bool) == true
        }
    }

    public static func read() throws -> AppStatus {
        let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: EditsApp.bundleId).map {
            AppCandidate(pid: $0.processIdentifier, path: $0.bundleURL?.path ?? "", bundleId: $0.bundleIdentifier ?? "")
        }
        let process = try EditsApp.process(in: candidates)
        let bundle = Bundle(url: URL(fileURLWithPath: EditsApp.path))
        let installed = bundle?.bundleIdentifier == EditsApp.bundleId
        let session = CGSessionCopyCurrentDictionary()
        let screenLocked = ScreenLockState(sessionDictionary: session.map { $0 as NSDictionary })
        return AppStatus(
            trusted: AXIsProcessTrusted(), installed: installed, pid: process?.pid,
            version: installed ? bundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String : nil,
            helperPid: getpid(), parentPid: getppid(), screenCaptureAllowed: CGPreflightScreenCaptureAccess(),
            screenLocked: screenLocked
        )
    }
}
