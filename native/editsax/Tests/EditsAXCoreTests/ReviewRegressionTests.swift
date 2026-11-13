import Foundation
import Testing
@testable import EditsAXCore

@MainActor struct ReviewRegressionTests {
    private func execute(_ b: FakeBackend, _ op: String, _ args: [String: JSON]) async throws -> JSON {
        try await Engine(backend: b).execute(syntheticRequest(op, args))
    }
    private func denied(_ b: FakeBackend, _ op: String, _ args: [String: JSON]) async throws {
        do { _ = try await execute(b, op, args); Issue.record("Expected fail-closed rejection") }
        catch let failure as AXFailure { #expect(failure.code == "AX_ACTION_FORBIDDEN") }
    }
    private func openPanel() -> FakeBackend {
        let b = FakeBackend(); b.metadata[2]?.subrole = "AXOpenDialog"; b.metadata[2]?.title = "Open"
        b.add(3, parent: 2, role: "AXBrowser")
        return b
    }
    private func key(_ b: FakeBackend, target: Int, _ key: String) throws -> [String: JSON] {
        ["target": try b.target(target), "context": .string("import-dialog"), "key": .string(key)]
    }
    private func libraryPress(_ b: FakeBackend, _ target: Int) throws -> [String: JSON] {
        ["target": try b.target(target), "intent": .string("library-result"), "allowCoordinateFallback": .bool(true)]
    }

    @Test(arguments: ["return", "select-all", "go-to-folder", "escape"])
    func importUnclassifiedButtonsAndSheetsNeverReceiveAuxiliaryKeys(input: String) async throws {
        let b = openPanel(); b.add(4, parent: 2, title: "New Folder"); b.focus = 4
        try await denied(b, "key", key(b, target: 4, input))
        b.add(5, parent: 2, role: "AXSheet", title: "Unclassified"); b.focus = 5
        try await denied(b, "key", key(b, target: 5, input))
        #expect(b.calls.isEmpty)
    }

    @Test func importKeysDistinguishPathInputBrowserAndActualConfirmationPress() async throws {
        let b = openPanel(); b.focus = 3
        _ = try await execute(b, "key", key(b, target: 3, "go-to-folder"))
        try await denied(b, "key", key(b, target: 3, "return"))
        try await denied(b, "key", key(b, target: 3, "select-all"))
        b.add(4, parent: 2, role: "AXSheet", title: "Go to Folder")
        b.add(5, parent: 4, role: "AXTextField", placeholder: "Go to the folder:"); b.focus = 5
        for input in ["return", "select-all", "escape"] { _ = try await execute(b, "key", key(b, target: 5, input)) }
        b.edges[2]?.removeAll { $0 == 4 } // Synthetic sheet closes; no real UI is involved.
        b.add(6, parent: 3, role: "AXRow", selected: true); b.focus = 6
        _ = try await execute(b, "key", key(b, target: 6, "return"))
        b.add(7, parent: 2, title: "Import"); b.focus = 7
        try await denied(b, "key", key(b, target: 7, "return"))
        _ = try await execute(b, "press", ["target": try b.target(7), "intent": .string("import-confirm")])
        #expect(b.calls.filter { $0 == "key:42:return" }.count == 2)
        #expect(b.calls.last == "perform:7:AXPress")
    }

    @Test(arguments: ["Open settings", "save thin filled", "Synthetic Song", "Song, Artist", "Song, Artist, · 3:99", " , Artist, · 3:16", "Song, , · 3:16"])
    func libraryRejectsPlainAndMalformedListControls(label: String) async throws {
        let b = FakeBackend(); b.add(3, parent: 2, role: "AXGroup", title: "Audio")
        b.add(4, parent: 3, role: "AXList"); b.add(5, parent: 4, title: label, placeholder: "Song, Artist, · 3:16")
        try await denied(b, "press", libraryPress(b, 5))
        #expect(b.calls.isEmpty)
    }

    @Test func libraryRequiresObservedSongMarkerAndLocalPreviewEvidence() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, role: "AXGroup", title: "Audio")
        b.add(4, parent: 3, role: "AXList")
        b.add(5, parent: 4, title: "Synthetic Song, Artist One, Artist Two, · 3:16")
        _ = try await execute(b, "press", libraryPress(b, 5))
        b.add(6, parent: 3, role: "AXGroup", title: "Audio preview"); b.add(7, parent: 6, title: "add thin")
        try await denied(b, "press", libraryPress(b, 7)) // A track in the unrelated list is insufficient.
        b.add(8, parent: 6, role: "AXStaticText", title: "Synthetic Song, Artist One, · 3:16")
        _ = try await execute(b, "press", libraryPress(b, 7))
        #expect(b.calls == ["perform:5:AXPress", "perform:7:AXPress"])
    }

    @Test func placeholderRoundTripsInFindAndTreeAfterQueryChanges() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, role: "AXTextField", placeholder: "Search audio", settable: true, value: .string(""))
        let args: [String: JSON] = ["selector": .object(["role": .string("AXTextField"), "label": .string("Search audio")])]
        let initial = try await execute(b, "find", args)
        let first = try #require(initial["matches"]?.array?.first)
        #expect(first["placeholder"] == .string("Search audio"))
        #expect(initial["snapshot"]?["nodes"]?.array?.contains { $0["placeholder"] == .string("Search audio") } == true)
        b.values[3] = .string("synthetic query")
        let next = try await execute(b, "find", args)
        let match = try #require(next["matches"]?.array?.first)
        #expect(match["target"] == first["target"]); #expect(match["placeholder"] == first["placeholder"])
        #expect(match["value"] == .string("synthetic query"))
    }

    @Test func placeholderIsBoundedAndSecureValuesRemainUnread() async throws {
        let b = FakeBackend()
        b.add(3, parent: 2, role: "AXTextField", placeholder: "Password", subrole: "AXSecureTextField", settable: true, value: .string("synthetic-private-value"))
        b.add(4, parent: 2, role: "AXTextField", placeholder: String(repeating: "x", count: 5000))
        let tree = try await execute(b, "tree", [:])
        let secure = try #require(tree["nodes"]?.array?.first { $0["placeholder"] == .string("Password") })
        #expect(secure["value"] == .null); #expect(secure["settable"] == .bool(false)); #expect(!b.valueReads.contains(3))
        let long = try #require(tree["nodes"]?.array?.first { $0["placeholder"]?.string?.hasPrefix("xxx") == true })
        #expect(try #require(long["placeholder"]?.string).utf8.count <= 1024)
        #expect(!String(decoding: try JSONEncoder().encode(tree), as: UTF8.self).contains("synthetic-private-value"))
    }

    @Test func rootSelfCyclePreservesSafetyAndExposesReadOnlyIdentityRecheck() throws {
        let b = FakeBackend(); b.edges[1] = [1]
        let s = try TreeReader(backend: b, budget: RequestBudget()).capture(pid: 42).snapshot
        #expect(s.truncated); #expect(s.diagnostics.counts["cycle"] == 1)
        let sample = try #require(s.diagnostics.samples.first { $0.reason == .cycle })
        #expect(sample.path == [0]); #expect(sample.firstPath == [])
        #expect(sample.identity?.firstCapturedRole == "AXApplication")
        #expect(sample.identity?.currentRole == "AXApplication"); #expect(sample.identity?.freshFirstChildRole == "AXApplication")
        #expect(sample.identity?.sameReference == true); #expect(b.identityProbeCalls == 1); #expect(b.calls.isEmpty)
    }

    @Test func ambiguousIdentityOrProbeFailureNeverDisablesCycleGuard() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.export")
        let target = try b.target(3); b.edges[1] = [1]
        var evidence = ElementIdentityProbe()
        evidence.currentRole = "AXWindow"; evidence.firstRoleNow = "AXApplication"
        evidence.sameReference = false; evidence.currentEqualsFirst = true
        evidence.probeErrorCode = "AX_ACTION_FAILED"; evidence.probeAXErrorCode = -25204
        b.identityProbe = evidence
        let tree = try await execute(b, "tree", [:])
        #expect(tree["truncated"] == .bool(true)); #expect(tree["diagnostics"]?["counts"]?["cycle"] == .number(1))
        let sample = try #require(tree["diagnostics"]?["samples"]?.array?.first)
        #expect(sample["identity"]?["currentRole"] == .string("AXWindow"))
        #expect(sample["identity"]?["firstCapturedRole"] == .string("AXApplication"))
        #expect(sample["identity"]?["probeAXErrorCode"] == .number(-25204))
        try await denied(b, "press", ["target": target, "intent": .string("editor-control"), "allowCoordinateFallback": .bool(true)])
        #expect(b.calls.isEmpty)
    }
}
