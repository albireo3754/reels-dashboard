import Foundation
import Testing
@testable import EditsAXCore

@MainActor struct TreeDiagnosticsTests {
    private func capture(_ b: FakeBackend, depth: Int = 16, maxNodes: Int = 4000, byteLimit: Int = 6 * 1_048_576) throws -> Snapshot {
        try TreeReader(backend: b, budget: RequestBudget()).capture(pid: 42, depth: depth, maxNodes: maxNodes, byteLimit: byteLimit).snapshot
    }

    @Test func completeTreeHasEmptyDiagnosticsAndExpectedMenuReferenceIsNotADuplicate() throws {
        let b = FakeBackend()
        b.edges[1]?.append(100) // Same menu is exported through its explicit menuBar root.
        let s = try capture(b)
        #expect(!s.truncated); #expect(s.diagnostics.counts.isEmpty)
        #expect(s.diagnostics.samples.isEmpty); #expect(s.diagnostics.samplesOmitted == 0)
        #expect(s.nodes.filter { $0.role == "AXMenuBar" }.count == 1)
        #expect(s.nodes.first { $0.role == "AXMenuBar" }?.target.root == .menuBar)
    }

    @Test func limitDiagnosticsDistinguishDepthNodesChildrenAndBytes() throws {
        let b = FakeBackend()
        for i in 3...5 { b.add(i, parent: 2) }
        let depth = try capture(b, depth: 1)
        #expect(depth.truncated); #expect(depth.diagnostics.counts["depth-limit"] == 1)
        let nodes = try capture(b, maxNodes: 2)
        #expect(nodes.truncated); #expect(nodes.nodes.count == 2)
        #expect(nodes.diagnostics.counts["node-limit"] != nil)
        #expect(nodes.diagnostics.counts["children-limit"] == 1)
        let bytes = try capture(b, byteLimit: 1)
        #expect(bytes.truncated); #expect(bytes.nodes.isEmpty)
        #expect(bytes.diagnostics.counts["byte-limit"] != nil)
        #expect(bytes.diagnostics.counts["attributes-read-error"] == nil)
    }

    @Test func cyclesAndSharedDuplicatesRetainFirstPathsAndBothRemainTruncated() throws {
        let b = FakeBackend(); b.add(3, parent: 2); b.add(4, parent: 2)
        b.edges[3] = [2]
        let cycle = try capture(b)
        let c = try #require(cycle.diagnostics.samples.first { $0.reason == .cycle })
        #expect(cycle.truncated); #expect(c.root == .application)
        #expect(c.path == [0, 0, 0]); #expect(c.firstPath == [0])
        #expect(cycle.diagnostics.counts["duplicate"] == nil)
        b.edges[3] = []; b.edges[4] = [3]
        let duplicate = try capture(b)
        let d = try #require(duplicate.diagnostics.samples.first { $0.reason == .duplicate })
        #expect(duplicate.truncated); #expect(d.path == [0, 1, 0]); #expect(d.firstPath == [0, 0])
        #expect(duplicate.diagnostics.counts["cycle"] == nil)
    }

    @Test(arguments: ["attributes", "value", "children"])
    func readErrorsExposeOnlyBoundedStructuredAXMetadata(stage: String) async throws {
        let b = FakeBackend(); b.add(3, parent: 2)
        let error = AXFailure("AX_ACTION_FAILED", "synthetic-sensitive-message", details: [
            "axErrorCode": .number(-25204), "axAPI": .string("AXUIElementCopyAttributeValue"),
            "axAttribute": .string("AXValue"), "private": .string("synthetic-private-detail")
        ])
        switch stage {
        case "attributes": b.attributeFailures[3] = error
        case "value": b.valueFailures[3] = error
        default: b.childrenFailures[3] = error
        }
        let result = try await Engine(backend: b).execute(syntheticRequest("tree"))
        #expect(result["truncated"] == .bool(true))
        let expected = "\(stage)-read-error"
        #expect(result["diagnostics"]?["counts"]?[expected] == .number(1))
        let sample = try #require(result["diagnostics"]?["samples"]?.array?.first)
        #expect(sample["root"] == .string("application")); #expect(sample["path"] == .array([.number(0), .number(0)]))
        #expect(sample["errorCode"] == .string("AX_ACTION_FAILED")); #expect(sample["axErrorCode"] == .number(-25204))
        #expect(sample["axAPI"] == .string("AXUIElementCopyAttributeValue")); #expect(sample["axAttribute"] == .string("AXValue"))
        let text = String(decoding: try JSONEncoder().encode(result), as: UTF8.self)
        #expect(!text.contains("synthetic-sensitive-message")); #expect(!text.contains("synthetic-private-detail"))
    }

    @Test func samplesAreCappedWhileAllFailureEventsAreCounted() throws {
        let b = FakeBackend()
        for i in 3...42 { b.add(i, parent: 2); b.failedReads.insert(i) }
        let s = try capture(b)
        #expect(s.truncated); #expect(s.diagnostics.counts["attributes-read-error"] == 40)
        #expect(s.diagnostics.samples.count == 16); #expect(s.diagnostics.samplesOmitted == 24)
    }

    @Test func PermissionFailureStillPropagatesInsteadOfBecomingPartialSuccess() throws {
        let b = FakeBackend(); b.add(3, parent: 2)
        b.attributeFailures[3] = AXFailure("AX_PERMISSION_REQUIRED", "Synthetic permission revoked")
        #expect(throws: AXFailure("AX_PERMISSION_REQUIRED", "Synthetic permission revoked")) { try capture(b) }
    }

    @Test func duplicateStillBlocksWritesAndIncludesDiagnosticEvidence() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.export"); b.add(4, parent: 2)
        b.edges[4] = [3]
        let target = try b.target(3)
        do {
            _ = try await Engine(backend: b).execute(syntheticRequest("press", ["target": target, "intent": .string("editor-control"), "allowCoordinateFallback": .bool(true)]))
            Issue.record("Expected complete-tree rejection")
        } catch let e as AXFailure {
            #expect(e.code == "AX_ACTION_FORBIDDEN")
            #expect(e.details["diagnostics"]?["counts"]?["duplicate"] == .number(1))
        }
        #expect(b.calls.isEmpty)
    }

    @Test func incompleteAfterReadDoesNotTurnDiagnosticsIntoUIStateChange() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, identifier: "editor.export")
        let target = try b.target(3)
        b.performHook = { _, _ in b.valueFailures[3] = AXFailure("AX_ACTION_FAILED", "Synthetic read failure") }
        let result = try await Engine(backend: b).execute(syntheticRequest("press", ["target": target, "intent": .string("editor-control")]))
        #expect(result["attempted"] == .bool(true)); #expect(result["verified"] == .bool(false))
        #expect(result["after"]?["truncated"] == .bool(true))
        #expect(result["after"]?["diagnostics"]?["counts"]?["value-read-error"] == .number(1))
        #expect(result["verification"]?["kind"] == .string("outcome-unknown"))
        #expect(b.calls == ["perform:3:AXPress"])
    }
}
