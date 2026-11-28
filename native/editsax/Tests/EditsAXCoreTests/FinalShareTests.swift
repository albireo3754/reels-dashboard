import Foundation
import Testing
@testable import EditsAXCore

@MainActor struct FinalShareTests {
    private func fixture(account: String = "7/2200 Sharing as fixture_reels", caption: String = "Caption") -> FakeBackend {
        let b = FakeBackend()
        b.appStatus.screenLocked = .unlocked
        b.add(2, role: "AXWindow", title: "Share to Instagram")
        b.add(3, parent: 2, role: "AXStaticText", value: .string(account))
        b.add(4, parent: 2, role: "AXTextArea", settable: true, value: .string(caption))
        b.add(5, parent: 2, title: "Share")
        return b
    }

    private func preview(_ b: FakeBackend, observed: Bool? = false) async throws -> JSON {
        try await FinalShare(backend: b).execute(syntheticRequest("final-share-preview", ["lease": .string("synthetic")])) { _ in observed }
    }

    private func confirm(_ b: FakeBackend, _ approved: JSON, proof: @escaping () -> Bool? = { false }) async throws -> JSON {
        try await FinalShare(backend: b).execute(syntheticRequest("final-share-confirm",
            ["lease": .string("synthetic"), "fingerprint": approved["fingerprint"]!,
             "expiresAt": .number(Date().timeIntervalSince1970 * 1000 + 90_000)]), pollSeconds: 0.15) { _ in proof() }
    }

    private func apply(_ b: FakeBackend, _ approved: JSON, caption: JSON?,
                       expiresAt: Double = Date().timeIntervalSince1970 * 1000 + 90_000,
                       proof: () -> Bool? = { false }) async throws -> JSON {
        var args: [String: JSON] = ["lease": .string("synthetic"), "fingerprint": approved["fingerprint"]!,
                                    "expiresAt": .number(expiresAt)]
        args["caption"] = caption
        return try await FinalShare(backend: b).execute(syntheticRequest("final-share-caption", args)) { _ in proof() }
    }

    @Test(arguments: ["empty", "multiline", "grapheme-limit"])
    func appliesVerbatimAndReturnsTheNewPreview(_ example: String) async throws {
        let caption: String
        switch example {
        case "empty": caption = ""
        case "multiline": caption = "  한글 👩🏽‍💻\n\ne\u{301}\r\n끝  "
        default:
            caption = String(repeating: "🫶🏻", count: 2200)
            #expect(caption.count == 2200)
            #expect(caption.unicodeScalars.count == 4400)
            #expect(caption.utf8.count > 16_384)
        }
        let b = fixture()
        b.add(6, parent: 2, role: "AXStaticText", title: "Other element", settable: true, value: .string("Keep"))
        b.add(7, parent: 1, role: "AXTextArea", settable: true, value: .string("Outside"))
        let original = try await preview(b)
        var captures = 0
        b.captureHook = { [weak b] in
            captures += 1
            if b?.calls == ["set:4"] { b?.shareImage = "fresh" }
        }

        let updated = try await apply(b, original, caption: .string(caption))
        #expect(updated["caption"]?.string?.utf8.elementsEqual(caption.utf8) == true)
        #expect(b.values[4]?.string?.utf8.elementsEqual(caption.utf8) == true)
        #expect(b.values[6] == .string("Keep"))
        #expect(b.values[7] == .string("Outside"))
        #expect(updated["windowKey"] == original["windowKey"])
        #expect(updated["account"] == original["account"])
        #expect(updated["fingerprint"] != original["fingerprint"])
        #expect(updated["image"] == .string("data:image/png;base64,fresh"))
        #expect(captures == 2)
        #expect(try await preview(b) == updated)

        await expectFailure("FINAL_SHARE_CHANGED") { _ = try await confirm(b, original) }
        await expectFailure("FINAL_SHARE_CHANGED") { _ = try await apply(b, original, caption: .string("Stale")) }
        #expect(b.calls == ["set:4"])
    }

    @Test func rejectsMissingNonStringNULAndMoreThan2200Graphemes() async throws {
        let b = fixture()
        let approved = try await preview(b)
        let tooLong = String(repeating: "🫶🏻", count: 2201)
        #expect(tooLong.count == 2201)
        for invalid: JSON? in [nil, .null, .number(1), .string("first\0last"), .string(tooLong)] {
            await expectFailure("FINAL_SHARE_CAPTION") { _ = try await apply(b, approved, caption: invalid) }
        }
        #expect(b.calls.isEmpty)
    }

    @Test(arguments: ["locked", "lease", "permission", "otherWindow", "windowId", "account", "ambiguous", "unsettable", "expired"])
    func refusesCaptionDispatchWhenApprovalOrTargetIsUnavailable(_ reason: String) async throws {
        let b = fixture()
        let approved = try await preview(b)
        let code: String
        switch reason {
        case "locked": b.appStatus.screenLocked = .locked; code = "FINAL_SHARE_LOCKED"
        case "lease": code = "FINAL_SHARE_SESSION_UNKNOWN"
        case "permission": b.appStatus.trusted = false; code = "FINAL_SHARE_PERMISSION"
        case "otherWindow":
            b.shareWindow = 10
            b.add(10, role: "AXWindow", title: "Editor")
            code = "FINAL_SHARE_WINDOW"
        case "windowId": b.shareWindowID = 100; code = "FINAL_SHARE_CHANGED"
        case "account": b.values[3] = .string("Sharing as different_account"); code = "FINAL_SHARE_CHANGED"
        case "ambiguous": b.add(9, parent: 2, role: "AXTextField", settable: true); code = "FINAL_SHARE_WINDOW"
        case "unsettable": b.metadata[4]?.settable = false; code = "FINAL_SHARE_CAPTION"
        default: code = "FINAL_SHARE_CHANGED"
        }
        await expectFailure(code) {
            _ = try await apply(b, approved, caption: .string("New"),
                                expiresAt: reason == "expired" ? 0 : Date().timeIntervalSince1970 * 1000 + 90_000) {
                reason == "lease" ? nil : false
            }
        }
        #expect(b.calls.isEmpty)
    }

    @Test func captionFieldReplacementDuringApprovalCaptureBlocksInput() async throws {
        let b = fixture()
        let approved = try await preview(b)
        b.captureHook = { [weak b] in
            guard let b else { return }
            b.metadata[6] = b.metadata[4]
            b.values[6] = b.values[4]
            b.edges[2] = [3, 6, 5]
        }
        await expectFailure("FINAL_SHARE_CHANGED") { _ = try await apply(b, approved, caption: .string("New")) }
        #expect(b.calls.isEmpty)
    }

    @Test func revokedLeaseDuringApprovalCaptureBlocksInput() async throws {
        let b = fixture()
        let approved = try await preview(b)
        var live = true
        b.captureHook = { live = false }
        await expectFailure("FINAL_SHARE_SESSION_UNKNOWN") {
            _ = try await apply(b, approved, caption: .string("New")) { live ? false : nil }
        }
        #expect(b.calls.isEmpty)
    }

    @Test func captionSetterRejectionIsReportedWithoutRetry() async throws {
        let b = fixture()
        let approved = try await preview(b)
        b.setFailure = .notDispatched("synthetic rejection")
        await expectFailure("FINAL_SHARE_CAPTION") { _ = try await apply(b, approved, caption: .string("New")) }
        #expect(b.values[4] == .string("Caption"))
        #expect(b.calls == ["set:4"])
    }

    @Test func pollsReadbackForADelayedSetter() async throws {
        let b = fixture()
        let approved = try await preview(b)
        b.ignoreSet = true
        var readsAfterSet = 0
        b.valueReadHook = { [weak b] element in
            guard let b, element == 4, b.calls == ["set:4"] else { return }
            readsAfterSet += 1
            if readsAfterSet == 2 { b.values[4] = .string("Delayed") }
        }
        let result = try await apply(b, approved, caption: .string("Delayed"))
        #expect(result["caption"] == .string("Delayed"))
        #expect(b.calls == ["set:4"])
    }

    @Test func rejectsCanonicalButInexactReadback() async throws {
        let b = fixture(caption: "é")
        let approved = try await preview(b)
        b.ignoreSet = true
        await expectFailure("FINAL_SHARE_CAPTION") { _ = try await apply(b, approved, caption: .string("e\u{301}")) }
        #expect(b.calls == ["set:4"])
    }

    @Test func exactChangeInvalidatesApprovalEvenWithAnIdenticalImage() async throws {
        let b = fixture(caption: "é")
        let approved = try await preview(b)
        let updated = try await apply(b, approved, caption: .string("e\u{301}"))
        #expect(updated["image"] == approved["image"])
        #expect(updated["fingerprint"] != approved["fingerprint"])
        await expectFailure("FINAL_SHARE_CHANGED") { _ = try await confirm(b, approved) }
        #expect(b.calls == ["set:4"])
    }

    @Test(arguments: ["account", "field", "window"])
    func refusesUpdatedPreviewWhenTheTargetChangesAfterInput(_ change: String) async throws {
        let b = fixture()
        let approved = try await preview(b)
        b.captureHook = { [weak b] in
            guard let b, b.calls == ["set:4"] else { return }
            switch change {
            case "account": b.values[3] = .string("Sharing as different_account")
            case "field":
                b.metadata[6] = b.metadata[4]
                b.values[6] = b.values[4]
                b.edges[2] = [3, 6, 5]
            default: b.shareWindowID = 100
            }
        }
        await expectFailure("FINAL_SHARE_CHANGED") { _ = try await apply(b, approved, caption: .string("New")) }
        #expect(b.calls == ["set:4"])
    }

    @Test(arguments: ["0/2200 Sharing as fixture_reels", "123/2200 Sharing as fixture_reels", "Sharing as fixture_reels"])
    func observedAccountAndCounterForms(_ label: String) async throws {
        let b = fixture(account: label, caption: label.hasPrefix("0/") ? "" : "Caption")
        b.add(6, parent: 2, role: "AXStaticText", title: "Sharing as @Fixture_Reels")
        #expect(try await preview(b)["account"]?.string == "@fixture_reels")
        #expect(b.calls.isEmpty)
    }

    @Test(arguments: ["x 0/2200 Sharing as fixture_reels", "0/2200 Sharing as fixture_reels plus", "2201/2200 Sharing as fixture_reels"])
    func rejectsUnanchoredOrInvalidAccountEvidence(_ label: String) async {
        let b = fixture(account: label)
        await expectFailure("FINAL_SHARE_WINDOW") { _ = try await preview(b) }
    }

    @Test func rejectsDifferentAccountsAndMissingAccountRole() async {
        let b = fixture()
        b.add(6, parent: 2, role: "AXStaticText", title: "Sharing as another_account")
        await expectFailure("FINAL_SHARE_WINDOW") { _ = try await preview(b) }
        b.edges[2] = [4, 5, 6]
        b.metadata[6]?.role = "AXGroup"
        await expectFailure("FINAL_SHARE_WINDOW") { _ = try await preview(b) }
    }

    @Test func pressesOnlyFinalButtonAndRequiresSuccessLinkOnSameWindow() async throws {
        let b = fixture()
        let approved = try await preview(b)
        b.performHook = { [weak b] _, _ in
            guard let b else { return }
            b.edges[2] = []
            b.add(10, parent: 2, role: "AXStaticText", title: "Shared successfully.")
            b.add(11, parent: 2, role: "AXStaticText", value: .string("View on Instagram: instagram.com/p/FakePost9/"))
        }
        #expect(try await confirm(b, approved)["url"]?.string == "https://www.instagram.com/p/FakePost9/")
        #expect(b.calls == ["perform:5:AXPress"])
    }

    @Test(arguments: ["caption", "account", "image", "window", "button", "dialog", "owner"])
    func refusesAnyChangedOrAmbiguousTarget(_ change: String) async throws {
        let b = fixture()
        let approved = try await preview(b)
        switch change {
        case "caption": b.values[4] = .string("Edited")
        case "account": b.values[3] = .string("7/2200 Sharing as another_account")
        case "image": b.shareImage = "anotherVideo"
        case "window": b.shareWindowID = 100
        case "button": b.add(7, parent: 2, title: "Share")
        case "owner": b.foreignShareElements.insert(5)
        default: b.add(7, parent: 2, role: "AXSheet", title: "Other")
        }
        await expectFailure(["button", "dialog", "owner"].contains(change) ? "FINAL_SHARE_WINDOW" : "FINAL_SHARE_CHANGED") {
            _ = try await confirm(b, approved)
        }
        #expect(b.calls.isEmpty)
    }

    @Test func locksWinAndObservationMustStayLive() async throws {
        let b = fixture()
        b.appStatus.screenLocked = .unknown
        await expectFailure("FINAL_SHARE_SESSION_UNKNOWN") { _ = try await preview(b) }
        let approved = try await preview(b, observed: true)
        b.appStatus.screenLocked = .locked
        await expectFailure("FINAL_SHARE_LOCKED") { _ = try await confirm(b, approved) { true } }
        b.appStatus.screenLocked = .unknown
        var live = true
        b.captureHook = { live = false }
        await expectFailure("FINAL_SHARE_SESSION_UNKNOWN") {
            _ = try await confirm(b, approved) { live ? true : nil }
        }
        #expect(b.calls.isEmpty)
    }

    @Test func lostDispatchAndSuccessWithoutPermalinkStayPending() async throws {
        let b = fixture()
        let approved = try await preview(b)
        b.performFailure = .uncertain("synthetic")
        #expect(try await confirm(b, approved)["state"]?.string == "pending")
        #expect(b.calls == ["perform:5:AXPress"])

        b.calls = []
        b.performFailure = nil
        b.performHook = { [weak b] _, _ in
            b?.edges[2] = []
            b?.add(10, parent: 2, role: "AXStaticText", title: "Shared successfully.")
        }
        #expect(try await confirm(b, approved)["state"]?.string == "pending")
        #expect(b.calls == ["perform:5:AXPress"])
    }

    @Test func laterEvidenceIsReadOnlyAndMustUseTheSameWindow() async throws {
        let b = fixture()
        let approved = try await preview(b)
        #expect(try await confirm(b, approved)["state"]?.string == "pending")
        let recheck = try syntheticRequest("final-share-recheck", ["lease": .string("synthetic"), "windowKey": approved["windowKey"]!])
        let share = FinalShare(backend: b)
        #expect(try await share.execute(recheck) { _ in false }["state"]?.string == "pending")
        b.edges[2] = []
        b.add(10, parent: 2, role: "AXStaticText", title: "Shared successfully.")
        b.add(11, parent: 2, role: "AXStaticText", value: .string("View on Instagram: instagram.com/reel/MockLater/"))
        b.shareWindowID = 100
        #expect(try await share.execute(recheck) { _ in false }["state"]?.string == "pending")
        b.shareWindowID = 99
        b.appStatus.screenCaptureAllowed = false
        #expect(try await share.execute(recheck) { _ in false }["url"]?.string == "https://www.instagram.com/reel/MockLater/")
        #expect(b.calls == ["perform:5:AXPress"])
    }

    @Test func expiredApprovalCannotPress() async throws {
        let b = fixture()
        let approved = try await preview(b)
        let request = try syntheticRequest("final-share-confirm",
            ["lease": .string("synthetic"), "fingerprint": approved["fingerprint"]!, "expiresAt": .number(0)])
        await expectFailure("FINAL_SHARE_CHANGED") {
            _ = try await FinalShare(backend: b).execute(request) { _ in false }
        }
        #expect(b.calls.isEmpty)
    }

    private func expectFailure(_ code: String, _ work: () async throws -> Void) async {
        do {
            try await work()
            Issue.record("Expected \(code)")
        } catch let failure as AXFailure {
            #expect(failure.code == code)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }
}
