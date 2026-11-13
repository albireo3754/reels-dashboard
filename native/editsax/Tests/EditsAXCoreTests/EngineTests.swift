import Foundation
import Testing
@testable import EditsAXCore

@MainActor struct EngineTests {
    private func call(_ backend: FakeBackend, _ op: String, _ args: [String: JSON] = [:]) async throws -> JSON {
        try await Engine(backend: backend).execute(syntheticRequest(op, args))
    }
    private func failure(_ backend: FakeBackend, _ op: String, _ args: [String: JSON] = [:]) async -> AXFailure {
        do { _ = try await call(backend, op, args); Issue.record("Expected failure"); return AXFailure("TEST", "Expected failure") }
        catch let e as AXFailure { return e }
        catch { Issue.record("Unexpected error type"); return AXFailure("TEST", "Unexpected error") }
    }
    private func pressArgs(_ b: FakeBackend, _ element: Int, intent: String = "editor-control", dry: Bool = false, fallback: Bool = false) throws -> [String: JSON] {
        ["target": try b.target(element), "intent": .string(intent), "dryRun": .bool(dry), "allowCoordinateFallback": .bool(fallback)]
    }

    @Test func statusRequiresNeitherTrustNorRunningApp() async throws {
        let b = FakeBackend(); b.appStatus.trusted = false; b.appStatus.pid = nil; b.appStatus.running = false
        let result = try await call(b, "status")
        #expect(result["trusted"] == .bool(false)); #expect(result["pid"] == .null)
        #expect(b.rootReads == 0); #expect(b.calls.isEmpty)
    }

    @Test func separatesPermissionFromMissingAppAndCapturePermission() async throws {
        let b = FakeBackend(); b.appStatus.trusted = false
        #expect(await failure(b, "tree").code == "AX_PERMISSION_REQUIRED")
        b.appStatus.trusted = true; b.appStatus.pid = nil
        #expect(await failure(b, "tree").code == "EDITS_NOT_RUNNING")
        b.appStatus.pid = 42; b.appStatus.screenCaptureAllowed = false
        #expect(await failure(b, "screenshot").code == "SCREEN_CAPTURE_PERMISSION_REQUIRED")
        #expect(b.calls.isEmpty)
    }

    @Test func includesStandaloneMenuBarAndPreservesRootPaths() async throws {
        let b = FakeBackend(); b.add(101, parent: 100, role: "AXMenuBarItem", title: "File")
        b.add(3, parent: 2, title: "Media")
        let result = try await call(b, "tree")
        let nodes = try #require(result["nodes"]?.array)
        let menu = try #require(nodes.first { $0["title"] == .string("File") })
        #expect(menu["target"]?["root"] == .string("menuBar"))
        #expect(menu["target"]?["path"] == .array([.number(0)]))
        #expect(nodes.first { $0["title"] == .string("Media") }?["target"]?["path"] == .array([.number(0), .number(0)]))
    }

    @Test func exactSelectorUsesPlaceholderAndANDAndReturnsAllMatches() async throws {
        let b = FakeBackend()
        b.add(3, parent: 2, role: "AXTextField", identifier: "query", placeholder: "Search audio")
        b.add(4, parent: 2, role: "AXTextField", identifier: "query", placeholder: "Search audio")
        b.add(5, parent: 2, role: "AXButton", title: "Search audio", identifier: "other")
        let found = try await call(b, "find", ["selector": .object(["role": .string("AXTextField"), "identifier": .string("query"), "label": .string("Search audio")])])
        #expect(found["matches"]?.array?.count == 2)
        let noMatch = try await call(b, "find", ["selector": .object(["label": .string("Search")])])
        #expect(noMatch["matches"]?.array?.isEmpty == true)
    }

    @Test func cyclesFailuresAndDepthAreBounded() async throws {
        let b = FakeBackend(); b.add(3, parent: 2); b.add(4, parent: 3); b.edges[4] = [3]
        let result = try await call(b, "tree")
        #expect(result["truncated"] == .bool(true)); #expect(result["nodes"]?.array?.count == 5)
        let limited = try await call(b, "tree", ["maxNodes": .number(2)])
        #expect(limited["nodes"]?.array?.count == 2); #expect(limited["truncated"] == .bool(true))
        b.failedReads.insert(3)
        let failed = try await call(b, "tree")
        #expect(failed["truncated"] == .bool(true))
        #expect(b.calls.isEmpty)
    }

    @Test func depthDoesNotRecurseIntoHiddenDescendants() async throws {
        let b = FakeBackend(); b.add(3, parent: 2)
        let result = try await call(b, "tree", ["depth": .number(1)])
        #expect(result["nodes"]?.array?.contains { $0["target"]?["path"] == .array([.number(0), .number(0)]) } == false)
        #expect(result["truncated"] == .bool(true))
    }

    @Test func redactsSecureAndLoginValuesWithoutReadingThem() async throws {
        let b = FakeBackend()
        b.add(3, parent: 2, role: "AXTextField", subrole: "AXSecureTextField", settable: true, value: .string("synthetic-secret"))
        b.add(4, parent: 2, role: "AXGroup", title: "Sign in")
        b.add(5, parent: 4, role: "AXTextField", value: .string("synthetic-email"))
        b.valueReads = []
        let result = try await call(b, "tree")
        #expect(!b.valueReads.contains(3)); #expect(!b.valueReads.contains(5))
        let encoded = try JSONEncoder().encode(result)
        #expect(!String(decoding: encoded, as: UTF8.self).contains("synthetic-secret"))
        #expect(!String(decoding: encoded, as: UTF8.self).contains("synthetic-email"))
    }

    @Test func staleFingerprintAndPIDAreRejectedWithoutDispatch() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.export")
        var args = try pressArgs(b, 3)
        b.metadata[3]?.title = "Changed"
        #expect(await failure(b, "press", args).code == "AX_STALE_TARGET")
        args = try pressArgs(b, 3)
        b.appStatus.pid = 50
        #expect(await failure(b, "press", args).code == "AX_STALE_TARGET")
        #expect(b.calls.isEmpty)
    }

    @Test func valueChangesDoNotChangeFingerprint() throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.timecode")
        let first = try b.target(3)
        b.values[3] = .string("0:01")
        #expect(try b.target(3) == first)
        var a = b.metadata[3]!
        #expect(a.fingerprint(pid: 42, root: .application) != a.fingerprint(pid: 42, root: .menuBar))
        a.title = "x"; a.description = "y|z"
        let hash = a.fingerprint(pid: 42, root: .application)
        a.title = "x|y"; a.description = "z"
        #expect(hash != a.fingerprint(pid: 42, root: .application))
    }

    @Test(arguments: ["Share to Instagram", "Publish", "Post", "Login", "Password", "Delete account", "권한 허용", "게시", "Unclassified", "확인"])
    func forbiddenAndUnclassifiedButtonsCannotUseIntentOrFallbackAsAuthority(label: String) async throws {
        let b = FakeBackend(); b.add(3, parent: 2, title: label, actions: [])
        #expect(await failure(b, "press", try pressArgs(b, 3, fallback: true)).code == "AX_ACTION_FORBIDDEN")
        #expect(b.calls.isEmpty)
    }

    @Test func forbiddenAncestorAndUnknownDialogBlockKnownEditorID() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, role: "AXGroup", title: "Share to Instagram")
        b.add(4, parent: 3, identifier: "editor.export")
        #expect(await failure(b, "press", try pressArgs(b, 4)).code == "AX_ACTION_FORBIDDEN")
        b.edges[3] = []; b.add(5, parent: 2, identifier: "editor.export")
        b.add(6, parent: 2, role: "AXSheet", title: "Unknown alert")
        #expect(await failure(b, "press", try pressArgs(b, 5)).code == "AX_ACTION_FORBIDDEN")
        #expect(b.calls.isEmpty)
    }

    @Test func arbitraryAXActionAndAmbiguousExportParentAreRejected() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.export", actions: [Action("AXDelete")])
        var args = try pressArgs(b, 3); args["action"] = .string("AXDelete")
        #expect(await failure(b, "press", args).code == "AX_ACTION_FORBIDDEN")
        b.metadata[3]?.actions = [Action("AXPress")]; b.add(4, parent: 3, identifier: "editor.export")
        #expect(await failure(b, "press", try pressArgs(b, 3)).code == "AX_ACTION_FORBIDDEN")
        #expect(b.calls.isEmpty)
    }

    @Test func dryRunAndSuccessfulAPIAreNeverGoalVerification() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.export")
        let dry = try await call(b, "press", pressArgs(b, 3, dry: true))
        #expect(dry["attempted"] == .bool(false)); #expect(dry["verified"] == .bool(false))
        #expect(dry["before"] == dry["after"]); #expect(dry["fallback"] == .null); #expect(b.calls.isEmpty)
        let real = try await call(b, "press", pressArgs(b, 3, fallback: true))
        #expect(real["attempted"] == .bool(true)); #expect(real["verified"] == .bool(false))
        #expect(real["verification"]?["kind"] == .string("outcome-unknown"))
        #expect(b.calls.count == 1); #expect(!b.calls.contains("click:42"))
    }

    @Test func fallbackOnlyAfterProvenNonDispatch() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.export", actions: [])
        let missing = try await call(b, "press", pressArgs(b, 3, fallback: true))
        #expect(missing["fallback"] == .string("coordinate")); #expect(b.calls == ["click:42"])
        b.calls = []; b.metadata[3]?.actions = [Action("AXPress")]; b.performFailure = .notDispatched("actionUnsupported")
        let unsupported = try await call(b, "press", pressArgs(b, 3, fallback: true))
        #expect(unsupported["fallback"] == .string("coordinate")); #expect(b.calls == ["perform:3:AXPress", "click:42"])
    }

    @Test(arguments: ["timeout", "cannotComplete", "general failure", "response lost"])
    func uncertainDispatchNeverRetriesAndRetainsAfter(reason: String) async throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.export")
        b.performFailure = .uncertain(reason)
        b.performHook = { _, _ in b.values[2] = .string("partial state change") }
        let e = await failure(b, "press", try pressArgs(b, 3, fallback: true))
        #expect(e.code == "AX_OUTCOME_UNKNOWN"); #expect(e.details["outcome"] == .string("unknown"))
        #expect(e.details["attempted"] == .bool(true)); #expect(e.details["after"] != nil)
        #expect(b.calls == ["perform:3:AXPress"])
    }

    @Test func fallbackRechecksTargetAndRejectsMovedIdentityOrOcclusion() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.export")
        b.performFailure = .notDispatched("notImplemented")
        b.performHook = { element, _ in b.metadata[element]?.description = "Changed" }
        #expect(await failure(b, "press", try pressArgs(b, 3, fallback: true)).code == "AX_STALE_TARGET")
        #expect(!b.calls.contains("click:42"))
        b.performHook = nil; b.performFailure = nil; b.metadata[3]?.actions = []; b.coordinateAllowed = false; b.calls = []
        #expect(await failure(b, "press", try pressArgs(b, 3, fallback: true)).code == "AX_ACTION_FORBIDDEN")
        #expect(b.calls.isEmpty)
    }

    @Test func UUIDOutsideTimelineIsRefusedButTimelineAndHomeTargetsAreAllowed() async throws {
        let b = FakeBackend(); let id = "00000000-0000-4000-8000-000000000001"
        b.add(3, parent: 2, identifier: id)
        #expect(await failure(b, "press", try pressArgs(b, 3, intent: "timeline-select")).code == "AX_ACTION_FORBIDDEN")
        b.add(4, parent: 2, role: "AXGroup", title: "Timeline"); b.add(5, parent: 4, identifier: id)
        _ = try await call(b, "press", pressArgs(b, 5, intent: "timeline-select", dry: true))
        b.metadata[2]?.identifier = "home"; b.add(6, parent: 2, identifier: "home.project." + id)
        _ = try await call(b, "press", pressArgs(b, 6, intent: "timeline-select", dry: true))
        #expect(b.calls.isEmpty)
    }

    @Test func setValueEnforcesContextTypeSettableAndReadback() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, role: "AXTextField", identifier: "editor.timecode", settable: true, value: .string("0:00"))
        var args: [String: JSON] = ["target": try b.target(3), "intent": .string("timecode"), "value": .string("0:01"), "dryRun": .bool(true)]
        let dry = try await call(b, "set-value", args)
        #expect(dry["verified"] == .bool(false)); #expect(b.values[3] == .string("0:00")); #expect(b.calls.isEmpty)
        args["dryRun"] = .bool(false)
        let result = try await call(b, "set-value", args)
        #expect(result["verified"] == .bool(true)); #expect(result["verification"]?["kind"] == .string("value-match"))
        args["value"] = .number(1)
        #expect(await failure(b, "set-value", args).code == "INVALID_REQUEST")
        args["value"] = .string("0:02"); b.ignoreSet = true
        let e = await failure(b, "set-value", args)
        #expect(e.code == "AX_VERIFICATION_FAILED"); #expect(e.details["after"] != nil)
        b.metadata[3]?.settable = false
        #expect(await failure(b, "set-value", args).code == "AX_VALUE_NOT_SETTABLE")
    }

    @Test func bareKeyAndFocusOutsideTargetAreRejected() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, role: "AXTextField", identifier: "editor.timecode"); b.focus = 3
        #expect(await failure(b, "key", ["key": .string("return"), "context": .string("timecode")]).code == "INVALID_REQUEST")
        var args: [String: JSON] = ["target": try b.target(3), "context": .string("timecode"), "key": .string("return"), "dryRun": .bool(true)]
        _ = try await call(b, "key", args); #expect(b.calls.isEmpty)
        args["dryRun"] = .bool(false); _ = try await call(b, "key", args)
        #expect(b.calls == ["key:42:return"])
        b.add(4, parent: 2, title: "Post"); b.focus = 4; b.calls = []
        #expect(await failure(b, "key", args).code == "AX_ACTION_FORBIDDEN"); #expect(b.calls.isEmpty)
        b.focus = 3; args["key"] = .string("go-to-folder")
        #expect(await failure(b, "key", args).code == "AX_ACTION_FORBIDDEN")
    }

    @Test func unknownValueAndSearchToolsCannotMasqueradeAsTextContent() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, role: "AXTextArea", title: "Search tools", settable: true, value: .string(""))
        let args: [String: JSON] = ["target": try b.target(3), "intent": .string("text-content"), "value": .string("synthetic")]
        #expect(await failure(b, "set-value", args).code == "AX_ACTION_FORBIDDEN"); #expect(b.calls.isEmpty)
    }

    @Test func menuAllowlistDryRunAndExactPathTraversal() async throws {
        let b = FakeBackend(); b.add(101, parent: 100, role: "AXMenuBarItem", title: "File")
        b.add(102, parent: 101, role: "AXMenu"); b.add(103, parent: 102, role: "AXMenuItem", title: "Import Media")
        let path = JSON.array([.string("File"), .string("Import Media")])
        _ = try await call(b, "menu", ["path": path, "dryRun": .bool(true)]); #expect(b.calls.isEmpty)
        _ = try await call(b, "menu", ["path": path]); #expect(b.calls == ["perform:101:AXPress", "perform:103:AXPress"])
        b.calls = []
        #expect(await failure(b, "menu", ["path": .array([.string("File"), .string("Publish")])]).code == "AX_ACTION_FORBIDDEN")
        #expect(b.calls.isEmpty)
    }

    @Test func dragRequiresTrimModeTimelineBoundsAndNeverClaimsSourceVerification() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, role: "AXGroup", title: "Timeline")
        b.add(4, parent: 3, identifier: "00000000-0000-4000-8000-000000000001", description: "Video")
        b.add(5, parent: 2, identifier: "editor.tool.toolMode.trim", selected: false)
        var args: [String: JSON] = ["target": try b.target(4), "deltaX": .number(50)]
        #expect(await failure(b, "drag", args).code == "AX_ACTION_FORBIDDEN")
        b.metadata[5]?.selected = true; args["dryRun"] = .bool(true)
        let dry = try await call(b, "drag", args); #expect(dry["fallback"] == .null); #expect(b.calls.isEmpty)
        args["dryRun"] = .bool(false)
        let result = try await call(b, "drag", args)
        #expect(result["fallback"] == .string("coordinate")); #expect(result["verified"] == .bool(false))
        #expect(b.calls == ["drag:42"])
        args["deltaX"] = .number(-500); b.calls = []
        #expect(await failure(b, "drag", args).code == "AX_ACTION_FORBIDDEN")
        args["deltaX"] = .number(1001)
        #expect(await failure(b, "drag", args).code == "INVALID_REQUEST"); #expect(b.calls.isEmpty)
    }

    @Test func expiredRequestNeverDispatches() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.export")
        let request = try syntheticRequest("press", pressArgs(b, 3))
        var time = 0.0
        let budget = RequestBudget(seconds: 1, clock: { time })
        time = 2
        do { _ = try await Engine(backend: b).execute(request, budget: budget); Issue.record("Expected timeout") }
        catch let e as AXFailure { #expect(e.code == "AX_OUTCOME_UNKNOWN"); #expect(e.details["outcome"] == .string("unknown")) }
        #expect(b.calls.isEmpty)
    }
}
