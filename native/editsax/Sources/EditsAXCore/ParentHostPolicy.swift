import Foundation

public enum DashboardHostKind: String, Sendable { case packagedDashboard, developmentDashboard }

/// Internal, non-Codable observations. Paths/argv are never copied to wire errors or status.
public struct ParentHostObservation: Sendable {
    public var parentPid: Int32
    public var finalParentPid: Int32
    public var applicationPid: Int32?
    public var applicationTerminated: Bool
    public var helperExecutable: String?
    public var parentExecutable: String?
    public var applicationExecutable: String?
    public var bundlePath: String?
    public var bundleId: String?
    public var arguments: [String]?
    public var workingDirectory: String?
    public var developmentProjectMatches: Bool

    public init(parentPid: Int32, finalParentPid: Int32, applicationPid: Int32?, applicationTerminated: Bool,
                helperExecutable: String?, parentExecutable: String?, applicationExecutable: String?, bundlePath: String?,
                bundleId: String?, arguments: [String]?, workingDirectory: String?, developmentProjectMatches: Bool) {
        self.parentPid = parentPid; self.finalParentPid = finalParentPid; self.applicationPid = applicationPid
        self.applicationTerminated = applicationTerminated; self.helperExecutable = helperExecutable
        self.parentExecutable = parentExecutable; self.applicationExecutable = applicationExecutable
        self.bundlePath = bundlePath; self.bundleId = bundleId; self.arguments = arguments
        self.workingDirectory = workingDirectory; self.developmentProjectMatches = developmentProjectMatches
    }
}

public enum ParentHostPolicy {
    public static let packagedBundleId = "io.github.reelsdashboard.desktop"
    public static let developmentBundleId = "com.github.Electron"
    private static let developmentSuffix = "/native/editsax/.build/editsax"

    public static func canonical(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
    }

    public static func developmentRoot(helperExecutable: String?) -> String? {
        guard let path = helperExecutable, path.hasPrefix("/") else { return nil }
        let normalized = canonical(path)
        guard normalized.hasSuffix(developmentSuffix) else { return nil }
        let root = String(normalized.dropLast(developmentSuffix.count))
        return root.isEmpty ? nil : root
    }

    public static func classify(_ host: ParentHostObservation) throws -> DashboardHostKind {
        guard host.parentPid > 1, host.parentPid == host.finalParentPid,
              host.applicationPid == host.parentPid, !host.applicationTerminated else { throw denied("parent-unavailable-or-changed") }
        guard let helper = absolute(host.helperExecutable), let executable = absolute(host.parentExecutable),
              let appExecutable = absolute(host.applicationExecutable), let bundle = absolute(host.bundlePath),
              let bundleId = host.bundleId else { throw denied("parent-metadata-unavailable") }
        guard executable == appExecutable else { throw denied("parent-executable-mismatch") }
        guard let argv = host.arguments, !argv.isEmpty, argv.count <= 256,
              argv.allSatisfy({ $0.utf8.count <= 16_384 && !$0.contains("\0") }) else { throw denied("parent-arguments-unavailable") }
        guard argv[0] == URL(fileURLWithPath: executable).lastPathComponent || absolute(argv[0]) == executable else {
            throw denied("parent-executable-mismatch")
        }
        if bundleId == packagedBundleId {
            guard bundle.hasSuffix(".app"), executable == canonical(bundle + "/Contents/MacOS/Reels Dashboard"),
                  helper == canonical(bundle + "/Contents/Resources/native/editsax") else { throw denied("packaged-layout-mismatch") }
            guard try entries(argv, cwd: host.workingDirectory, loader: nil, packaged: true).isEmpty else { throw denied("unsupported-parent-launch") }
            return .packagedDashboard
        }
        if bundleId == developmentBundleId {
            guard let root = developmentRoot(helperExecutable: helper), host.developmentProjectMatches else {
                throw denied("development-project-unverified")
            }
            let expected = canonical(root + "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
            let expectedBundle = URL(fileURLWithPath: expected).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
            guard executable == expected, bundle == expectedBundle else { throw denied("development-electron-mismatch") }
            let loader = canonical(root + "/node_modules/playwright-core/lib/server/electron/loader.js")
            guard try entries(argv, cwd: host.workingDirectory, loader: loader, packaged: false) == [root] else {
                throw denied("development-entry-mismatch")
            }
            return .developmentDashboard
        }
        throw denied("unsupported-parent-bundle")
    }

    private static func absolute(_ path: String?) -> String? {
        guard let path, path.hasPrefix("/") else { return nil }
        return canonical(path)
    }

    private static func entries(_ argv: [String], cwd: String?, loader: String?, packaged: Bool) throws -> [String] {
        var result: [String] = []
        var index = 1
        var usedLoader = false
        while index < argv.count {
            let arg = argv[index]
            if ["--inspect=0", "--remote-debugging-port=0"].contains(arg) { index += 1; continue }
            if packaged, arg.range(of: "^-psn_[0-9]+_[0-9]+$", options: .regularExpression) != nil { index += 1; continue }
            if arg == "-r", let loader, !usedLoader, index + 1 < argv.count, absolute(argv[index + 1]) == loader {
                usedLoader = true; index += 2; continue
            }
            guard !arg.hasPrefix("-"), !arg.isEmpty else { throw denied("unsupported-parent-launch") }
            if let entry = absolute(arg) { result.append(entry) }
            else {
                guard let directory = absolute(cwd) else { throw denied("parent-working-directory-unavailable") }
                result.append(canonical(directory + "/" + arg))
            }
            index += 1
        }
        return result
    }

    private static func denied(_ reason: String) -> AXFailure {
        AXFailure("EDITS_HOST_UNSUPPORTED", "Run Edits tools through Reels Dashboard main", details: ["reason": .string(reason)])
    }
}

@MainActor public enum HostedRequest {
    /// The dispatch factory (including AX backend initialization) is unreachable for rejected hosts.
    public static func execute(_ request: Wire.Request, observe: @MainActor () -> ParentHostObservation,
                               dispatch: @MainActor (Wire.Request) async throws -> JSON) async throws -> JSON {
        _ = try ParentHostPolicy.classify(observe())
        return try await dispatch(request)
    }
}
