import Foundation
import Testing
@testable import EditsAXCore

@MainActor struct ParentHostTests {
    private let root = "/synthetic/Dashboard worktree"
    private let bundle = "/synthetic/Reels Dashboard.app"
    private func packaged() -> ParentHostObservation {
        let executable = bundle + "/Contents/MacOS/Reels Dashboard"
        return ParentHostObservation(parentPid: 42, finalParentPid: 42, applicationPid: 42, applicationTerminated: false,
            helperExecutable: bundle + "/Contents/Resources/native/editsax", parentExecutable: executable,
            applicationExecutable: executable, bundlePath: bundle, bundleId: ParentHostPolicy.packagedBundleId,
            arguments: [executable], workingDirectory: nil, developmentProjectMatches: false)
    }
    private func development(_ project: String? = nil) -> ParentHostObservation {
        let project = project ?? root
        let app = project + "/node_modules/electron/dist/Electron.app"
        let executable = app + "/Contents/MacOS/Electron"
        return ParentHostObservation(parentPid: 42, finalParentPid: 42, applicationPid: 42, applicationTerminated: false,
            helperExecutable: project + "/native/editsax/.build/editsax", parentExecutable: executable,
            applicationExecutable: executable, bundlePath: app, bundleId: ParentHostPolicy.developmentBundleId,
            arguments: [executable, "."], workingDirectory: project, developmentProjectMatches: true)
    }
    private func rejected(_ host: ParentHostObservation) throws -> AXFailure {
        do { _ = try ParentHostPolicy.classify(host); Issue.record("Expected host rejection"); return AXFailure("TEST", "Expected rejection") }
        catch let failure as AXFailure { #expect(failure.code == "EDITS_HOST_UNSUPPORTED"); return failure }
    }

    @Test func acceptsPackagedMainAndObservedPackagedQALaunch() throws {
        var host = packaged()
        #expect(try ParentHostPolicy.classify(host) == .packagedDashboard)
        host.arguments = [host.parentExecutable!, "-psn_0_1234", "--inspect=0", "--remote-debugging-port=0"]
        #expect(try ParentHostPolicy.classify(host) == .packagedDashboard)
    }

    @Test func acceptsDocumentedDevelopmentAndPlaywrightLoader() throws {
        var host = development()
        #expect(try ParentHostPolicy.classify(host) == .developmentDashboard)
        host.arguments = [host.parentExecutable!, "-r", root + "/node_modules/playwright-core/lib/server/electron/loader.js", "--inspect=0", "--remote-debugging-port=0", root]
        host.workingDirectory = nil // Absolute QA entry does not need a readable cwd.
        #expect(try ParentHostPolicy.classify(host) == .developmentDashboard)
    }

    @Test func rejectsDirectShellNodeRendererAndForeignBundle() throws {
        for executable in ["/bin/zsh", "/usr/local/bin/node", "/synthetic/Electron Helper.app/Contents/MacOS/Electron Helper"] {
            var host = packaged(); host.parentExecutable = executable; host.applicationExecutable = executable
            host.bundleId = "example.unrelated"
            _ = try rejected(host)
        }
        var renderer = packaged(); renderer.arguments?.append("--type=renderer")
        _ = try rejected(renderer)
    }

    @Test func rejectsNodeModeCLIAndUnrelatedDevelopmentEntry() throws {
        var host = packaged(); host.arguments?.append(bundle + "/Contents/Resources/cli/reels.mjs")
        _ = try rejected(host)
        host = development(); host.arguments = [host.parentExecutable!, "/synthetic/Other project"]
        _ = try rejected(host)
        host = development(); host.arguments = [host.parentExecutable!, root + "/dist-cli/reels.mjs"]
        _ = try rejected(host)
        host = development(); host.arguments = [host.parentExecutable!, root + "-other"]
        _ = try rejected(host)
    }

    @Test func rejectsMismatchedLayoutsProcessesAndUnreadableMetadata() throws {
        var host = packaged(); host.helperExecutable = "/synthetic/Other.app/Contents/Resources/native/editsax"; _ = try rejected(host)
        host = packaged(); host.applicationExecutable = "/synthetic/Other executable"; _ = try rejected(host)
        host = packaged(); host.finalParentPid = 1; _ = try rejected(host)
        host = packaged(); host.applicationPid = 99; _ = try rejected(host)
        host = packaged(); host.applicationTerminated = true; _ = try rejected(host)
        host = packaged(); host.arguments = nil; _ = try rejected(host)
        host = packaged(); host.bundleId = nil; _ = try rejected(host)
        host = development(); host.workingDirectory = nil; _ = try rejected(host)
        host = development(); host.developmentProjectMatches = false; _ = try rejected(host)
        host = development(); host.helperExecutable = root + "/native/editsax/.build/release/editsax"; _ = try rejected(host)
    }

    @Test(arguments: ["--type=utility", "--eval=synthetic-private-marker", "--edits-host-override=1", "--run-as-node", "--inspect=9229"])
    func unknownLaunchSwitchesCannotOverrideTheBoundary(argument: String) throws {
        var host = development(); host.arguments = [host.parentExecutable!, argument, root]
        let failure = try rejected(host)
        let text = String(decoding: try JSONEncoder().encode(failure), as: UTF8.self)
        #expect(!text.contains("synthetic-private-marker")); #expect(!text.contains(root))
        #expect(Set(failure.details.keys) == ["reason"])
        host.arguments = [host.parentExecutable!, "-r", "/synthetic/other-loader.js", root]
        _ = try rejected(host)
    }

    @Test func sharedNodeModulesSymlinkRetainsWorktreeBinding() throws {
        let temp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("editsax-host-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temp) }
        let project = temp.appendingPathComponent("Worktree with spaces")
        let shared = temp.appendingPathComponent("Shared modules")
        let app = shared.appendingPathComponent("electron/dist/Electron.app")
        try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        try Data().write(to: app.appendingPathComponent("Contents/MacOS/Electron"))
        try FileManager.default.createDirectory(at: project.appendingPathComponent("native/editsax/.build"), withIntermediateDirectories: true)
        try Data().write(to: project.appendingPathComponent("native/editsax/.build/editsax"))
        try FileManager.default.createSymbolicLink(at: project.appendingPathComponent("node_modules"), withDestinationURL: shared)
        var host = development(project.path)
        host.parentExecutable = app.appendingPathComponent("Contents/MacOS/Electron").path
        host.applicationExecutable = host.parentExecutable; host.bundlePath = app.path
        host.arguments = [host.parentExecutable!, project.path]
        #expect(try ParentHostPolicy.classify(host) == .developmentDashboard)
        host.arguments = [host.parentExecutable!, root]
        _ = try rejected(host)
    }

    @Test(arguments: ["status", "press"])
    func rejectedParentNeverConstructsTheAXBackend(operation: String) async throws {
        var host = packaged(); host.parentExecutable = "/bin/zsh"
        var backendConstructions = 0
        do {
            _ = try await HostedRequest.execute(syntheticRequest(operation), observe: { host }) { request in
                backendConstructions += 1
                return try await Engine(backend: FakeBackend()).execute(request)
            }
            Issue.record("Expected pre-AX rejection")
        } catch let failure as AXFailure { #expect(failure.code == "EDITS_HOST_UNSUPPORTED") }
        #expect(backendConstructions == 0)
    }

    @Test func supportedHostsReachTheUnchangedStatusHandler() async throws {
        for host in [packaged(), development()] {
            var constructions = 0
            let result = try await HostedRequest.execute(syntheticRequest("status"), observe: { host }) { request in
                constructions += 1
                let backend = FakeBackend(); backend.appStatus.trusted = false
                return try await Engine(backend: backend).execute(request)
            }
            #expect(constructions == 1); #expect(result["trusted"] == .bool(false))
            #expect(result["screenLocked"] == .string("unknown"))
        }
    }

    private func kernelArguments(_ argv: [String], tail: [UInt8] = []) -> Data {
        var argc = Int32(argv.count).littleEndian
        var data = withUnsafeBytes(of: &argc) { Data($0) }
        data.append(contentsOf: "/synthetic/Electron".utf8); data.append(contentsOf: [0, 0, 0])
        for arg in argv { data.append(contentsOf: arg.utf8); data.append(0) }
        data.append(contentsOf: tail)
        return data
    }

    @Test func argumentParserStopsBeforeEnvironmentAndPreservesEmptyArguments() {
        let argv = ["/synthetic/Electron", "", root]
        let data = kernelArguments(argv, tail: Array("EDITSAX_ALLOW_DIRECT=1\0PRIVATE=synthetic-private-marker\0".utf8) + [0xff])
        #expect(ProcessArguments.parse(data) == argv)
        #expect(ProcessArguments.parse(data)?.contains { $0.contains("PRIVATE") } == false)
    }

    @Test func argumentParserRejectsMalformedOrOversizedBuffers() {
        #expect(ProcessArguments.parse(Data()) == nil)
        #expect(ProcessArguments.parse(kernelArguments([])) == nil)
        var short = kernelArguments(["/synthetic/Electron"]); short.removeLast()
        #expect(ProcessArguments.parse(short) == nil)
        #expect(ProcessArguments.parse(Data(repeating: 0, count: ProcessArguments.maxBytes + 1)) == nil)
    }
}
