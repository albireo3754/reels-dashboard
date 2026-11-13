import Foundation
import Testing
@testable import EditsAXCore

@MainActor struct SubroleReadPolicyTests {
    private func failure(_ code: Int = -25200, attribute: String = "AXSubrole", api: String = "AXUIElementCopyAttributeValue") -> AXFailure {
        AXFailure("AX_ACTION_FAILED", "Synthetic attribute read failure", details: [
            "axErrorCode": .number(Double(code)), "axAPI": .string(api), "axAttribute": .string(attribute)
        ])
    }

    @Test func successfulSecureSubroleIsNotProbedAndStillPreventsValueRead() throws {
        var probes = 0
        let result = try SubroleReadPolicy.read(role: "AXTextField", value: { "AXSecureTextField" }, isAdvertised: { probes += 1; return true })
        #expect(result.value == "AXSecureTextField"); #expect(!result.confirmedAbsentAfterFailure); #expect(probes == 0)
        let b = FakeBackend(); b.add(3, parent: 2, role: "AXTextField", subrole: result.value, settable: true, value: .string("synthetic-secret"))
        let s = try TreeReader(backend: b, budget: RequestBudget()).capture(pid: 42).snapshot
        #expect(!b.valueReads.contains(3))
        #expect(s.nodes.first { $0.target.path == [0, 0] }?.value == .null)
        #expect(s.nodes.first { $0.target.path == [0, 0] }?.settable == false)
    }

    @Test(arguments: ["AXButton", "AXGroup", "AXToolbar", "AXImage", "AXStaticText", "AXScrollArea", "AXSplitGroup", "AXSplitter"])
    func genericFailureRequiresConfirmedAbsenceAndBasicRole(role: String) throws {
        var probes = 0
        let result = try SubroleReadPolicy.read(role: role, value: { throw failure() }, isAdvertised: { probes += 1; return false })
        #expect(result.value.isEmpty); #expect(result.confirmedAbsentAfterFailure); #expect(probes == 1)
    }

    @Test(arguments: ["AXTextField", "AXTextArea", "AXComboBox", "AXTimeField", "AXDateField", "AXWindow", "AXSheet", "AXDialog", "AXUnknown", "AXOpaqueProviderGroup", ""])
    func inputsWindowsAndUnknownRolesRemainStrictEvenIfNotAdvertised(role: String) throws {
        do {
            _ = try SubroleReadPolicy.read(role: role, value: { throw failure() }, isAdvertised: { false })
            Issue.record("Unknown/security-relevant subrole must not be treated as absent")
        } catch let error as AXFailure {
            #expect(error.details["axRole"] == .string(role)); #expect(error.details["axAttributeListed"] == .bool(false))
            #expect(error.details["axErrorCode"] == .number(-25200))
        }
    }

    @Test func advertisedSubroleFailureIsPreservedWithRoleEvidence() throws {
        do {
            _ = try SubroleReadPolicy.read(role: "AXButton", value: { throw failure() }, isAdvertised: { true })
            Issue.record("Advertised subrole failure must remain an error")
        } catch let error as AXFailure {
            #expect(error.details["axRole"] == .string("AXButton")); #expect(error.details["axAttributeListed"] == .bool(true))
            #expect(error.details["axAttribute"] == .string("AXSubrole"))
        }
    }

    @Test(arguments: [-25204, -25202, -25211, -25205])
    func otherErrorsDoNotUseTheAbsenceException(code: Int) throws {
        var probes = 0
        #expect(throws: AXFailure.self) {
            try SubroleReadPolicy.read(role: "AXButton", value: { throw failure(code) }, isAdvertised: { probes += 1; return false })
        }
        #expect(probes == 0)
        #expect(throws: AXFailure.self) {
            try SubroleReadPolicy.read(role: "AXButton", value: { throw failure(attribute: "AXValue") }, isAdvertised: { probes += 1; return false })
        }
        #expect(probes == 0)
    }

    @Test(arguments: ["AX_ACTION_FAILED", "AX_PERMISSION_REQUIRED"])
    func attributeListFailureCannotEstablishAbsence(code: String) throws {
        let probe = AXFailure(code, "Synthetic list failure", details: ["axErrorCode": .number(-25204), "axAPI": .string("AXUIElementCopyAttributeNames")])
        do {
            _ = try SubroleReadPolicy.read(role: "AXButton", value: { throw failure() }, isAdvertised: { throw probe })
            Issue.record("Failed attribute list must not establish absence")
        } catch let error as AXFailure {
            #expect(error.code == code)
            if code == "AX_PERMISSION_REQUIRED" { #expect(error == probe) }
            else {
                #expect(error.details["axErrorCode"] == .number(-25200))
                #expect(error.details["axAttributeListErrorCode"] == .number(-25204))
                #expect(error.details["axAttributeListed"] == nil)
            }
        }
    }

    @Test func confirmedAbsenceIsAuditableWithoutTruncationAndSamplesAreBounded() throws {
        let b = FakeBackend()
        for id in 3...22 {
            b.add(id, parent: 2, role: "AXToolbar")
            let result = try SubroleReadPolicy.read(role: "AXToolbar", value: { throw failure() }, isAdvertised: { false })
            b.metadata[id]?.subrole = result.value
            b.metadata[id]?.subroleConfirmedAbsentAfterFailure = result.confirmedAbsentAfterFailure
        }
        let s = try TreeReader(backend: b, budget: RequestBudget()).capture(pid: 42).snapshot
        #expect(!s.truncated); #expect(s.diagnostics.counts.isEmpty)
        #expect(s.diagnostics.confirmedAbsentSubroles == 20)
        #expect(s.diagnostics.confirmedAbsentSubroleSamples.count == 16)
        let sample = try #require(s.diagnostics.confirmedAbsentSubroleSamples.first)
        #expect(sample.root == .application); #expect(sample.path == [0, 0]); #expect(sample.role == "AXToolbar")
    }

    @Test func unresolvedSubroleStillTruncatesBlocksWritesAndNeverReadsPotentialSecret() async throws {
        let b = FakeBackend(); b.add(3, parent: 2, role: "AXTextField", value: .string("synthetic-secret"))
        b.add(4, parent: 2, identifier: "editor.export")
        let exportTarget = try b.target(4)
        do {
            _ = try SubroleReadPolicy.read(role: "AXTextField", value: { throw failure() }, isAdvertised: { false })
            Issue.record("Expected strict field failure")
        } catch let error as AXFailure { b.attributeFailures[3] = error }
        b.valueReads = []
        let reader = TreeReader(backend: b, budget: RequestBudget())
        let snapshot = try reader.capture(pid: 42).snapshot
        #expect(snapshot.truncated); #expect(!b.valueReads.contains(3))
        let sample = try #require(snapshot.diagnostics.samples.first)
        #expect(sample.axRole == "AXTextField"); #expect(sample.axAttributeListed == false)
        do {
            _ = try await Engine(backend: b).execute(syntheticRequest("press", ["target": exportTarget, "intent": .string("editor-control"), "allowCoordinateFallback": .bool(true)]))
            Issue.record("Expected unchanged full-tree guard")
        } catch let error as AXFailure { #expect(error.code == "AX_ACTION_FORBIDDEN") }
        #expect(b.calls.isEmpty)
    }
}
