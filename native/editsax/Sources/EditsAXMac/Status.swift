import AppKit
import ApplicationServices
import CoreGraphics
import EditsAXCore

@MainActor public enum MacStatus {
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
