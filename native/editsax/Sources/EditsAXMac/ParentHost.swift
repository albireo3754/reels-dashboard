import AppKit
import Darwin
import EditsAXCore

/// Passive OS/launch metadata only. No AX, permission prompt, UI, argv/environment output or override.
@MainActor public enum MacParentHost {
    public static func observe() -> ParentHostObservation {
        let parent = getppid()
        let helper = executable(getpid())
        let parentExecutable = executable(parent)
        let application = NSRunningApplication(processIdentifier: parent)
        let bundleId = application?.bundleIdentifier
        let applicationPid = application?.processIdentifier
        let terminated = application?.isTerminated ?? true
        let applicationExecutable = application?.executableURL?.path
        let bundlePath = application?.bundleURL?.path
        // Do not even inspect argv for an unrelated shell, Node or terminal host.
        let recognizedBundle = bundleId == ParentHostPolicy.packagedBundleId || bundleId == ParentHostPolicy.developmentBundleId
        let argv = recognizedBundle ? arguments(parent) : nil
        let cwd = recognizedBundle ? workingDirectory(parent) : nil
        let projectMatches = developmentProjectMatches(helper)
        let finalParent = getppid()
        return ParentHostObservation(
            parentPid: parent, finalParentPid: finalParent, applicationPid: applicationPid,
            applicationTerminated: terminated, helperExecutable: helper,
            parentExecutable: parentExecutable, applicationExecutable: applicationExecutable,
            bundlePath: bundlePath, bundleId: bundleId,
            arguments: argv, workingDirectory: cwd, developmentProjectMatches: projectMatches
        )
    }

    private static func executable(_ pid: Int32) -> String? {
        // SDK PROC_PIDPATHINFO_MAXSIZE is (4 * MAXPATHLEN), a macro Swift cannot import.
        var buffer = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard count > 0, let end = buffer.firstIndex(of: 0) else { return nil }
        return String(bytes: buffer[..<end], encoding: .utf8)
    }

    private static func arguments(_ pid: Int32) -> [String]? {
        var limit: Int32 = 0
        var limitSize = MemoryLayout<Int32>.size
        var limitMib = [CTL_KERN, KERN_ARGMAX]
        guard sysctl(&limitMib, u_int(limitMib.count), &limit, &limitSize, nil, 0) == 0,
              limit >= 5, limit <= ProcessArguments.maxBytes else { return nil }
        var size = Int(limit)
        var buffer = [UInt8](repeating: 0, count: size)
        var mib = [CTL_KERN, KERN_PROCARGS2, pid]
        guard sysctl(&mib, u_int(mib.count), &buffer, &size, nil, 0) == 0,
              size > 0, size <= buffer.count else { return nil }
        return ProcessArguments.parse(Data(buffer.prefix(size)))
    }

    private static func workingDirectory(_ pid: Int32) -> String? {
        var info = proc_vnodepathinfo()
        let expected = MemoryLayout<proc_vnodepathinfo>.size
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, Int32(expected)) == expected else { return nil }
        return withUnsafeBytes(of: &info.pvi_cdir.vip_path) { bytes in
            guard let end = bytes.firstIndex(of: 0) else { return nil }
            return String(bytes: bytes[..<end], encoding: .utf8)
        }
    }

    private static func developmentProjectMatches(_ helper: String?) -> Bool {
        guard let root = ParentHostPolicy.developmentRoot(helperExecutable: helper),
              FileManager.default.fileExists(atPath: root + "/dist-electron/main.cjs"),
              let data = try? Data(contentsOf: URL(fileURLWithPath: root + "/package.json")), data.count <= 1_048_576,
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              manifest["name"] as? String == "reels-dashboard", manifest["main"] as? String == "dist-electron/main.cjs",
              let build = manifest["build"] as? [String: Any], build["appId"] as? String == ParentHostPolicy.packagedBundleId else { return false }
        return true
    }
}
