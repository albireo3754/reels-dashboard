import Foundation
import Testing
@testable import EditsAXCore

struct WireTests {
    private func request(_ json: String) throws -> Wire.Request { try Wire.Request(data: Data(json.utf8)) }

    @Test func acceptsOneDocumentAndPreservesID() throws {
        let req = try request("{\"protocol\":1,\"id\":\"synthetic-id\",\"operation\":\"status\",\"args\":{}}\n")
        #expect(req.id == "synthetic-id")
        #expect(req.operation == "status")
    }

    @Test(arguments: [
        "{}", "[]", "null", "{", "{}{}",
        "{\"protocol\":true,\"id\":\"x\",\"operation\":\"status\",\"args\":{}}",
        "{\"protocol\":2,\"id\":\"x\",\"operation\":\"status\",\"args\":{}}",
        "{\"protocol\":1,\"id\":\"\",\"operation\":\"status\",\"args\":{}}",
        "{\"protocol\":1,\"id\":\"x\",\"operation\":\"shell\",\"args\":{}}",
        "{\"protocol\":1,\"id\":\"x\",\"operation\":\"status\",\"args\":[],\"extra\":1}"
    ]) func rejectsMalformedOrNoncontractRequests(input: String) {
        #expect(throws: AXFailure.self) { try request(input) }
    }

    @Test func rejectsOversizedAndNonUTF8() {
        #expect(throws: AXFailure.self) { try Wire.Request(data: Data(repeating: 32, count: Wire.maxInputBytes + 1)) }
        #expect(throws: AXFailure.self) { try Wire.Request(data: Data([0xff])) }
    }

    @Test func roundTripsScalarTypesAndNull() throws {
        for value in [JSON.bool(true), .number(1), .string("1"), .null] {
            #expect(try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(value)) == value)
        }
        #expect(JSON.bool(true) != .number(1))
    }

    @Test func emitsSingleErrorEnvelopeAndRecoverableID() throws {
        let response = Wire.response(id: "id", error: AXFailure("AX_PERMISSION_REQUIRED", "Permission required"))
        let bytes = try Wire.encode(response)
        #expect(bytes.last == 10)
        let value = try JSONDecoder().decode(JSON.self, from: bytes)
        #expect(value["ok"] == .bool(false))
        #expect(value["error"]?["code"] == .string("AX_PERMISSION_REQUIRED"))
        #expect(value["error"]?["details"] == .object([:]))
        #expect(Wire.requestID(in: Data("{\"id\":\"id\"}".utf8)) == "id")
    }

    @Test func argumentValidationDoesNotCoerceTypes() throws {
        let args = try Arguments(["depth": .number(1.5), "dryRun": .string("true")], allowed: ["depth", "dryRun"])
        #expect(throws: AXFailure.self) { try args.integer("depth", default: 10, range: 1...16) }
        #expect(throws: AXFailure.self) { try args.bool("dryRun") }
        #expect(throws: AXFailure.self) { try Arguments(["unknown": .null], allowed: []) }
    }

    @Test func statusWithoutPermissionOrAppIsSuccessfulAndExplicitlyNull() throws {
        let status = AppStatus(trusted: false, installed: false, pid: nil, version: nil, helperPid: 1,
                               parentPid: 2, screenCaptureAllowed: false)
        let value = try JSON.encoded(status)
        #expect(value["trusted"] == .bool(false))
        #expect(value["pid"] == .null)
        #expect(value["version"] == .null)
        #expect(value["running"] == .bool(false))
        #expect(value["screenLocked"] == .string("unknown"))
    }

    @Test func excludesInstallVolumeAndWrongIdentity() throws {
        let mount = AppCandidate(pid: 10, path: "/Volumes/Installer/Edits.app", bundleId: EditsApp.bundleId)
        let wrong = AppCandidate(pid: 11, path: EditsApp.path, bundleId: "example.wrong")
        let exact = AppCandidate(pid: 12, path: EditsApp.path, bundleId: EditsApp.bundleId)
        #expect(try EditsApp.process(in: [mount, wrong]) == nil)
        #expect(try EditsApp.process(in: [mount, exact]) == exact)
        #expect(throws: AXFailure.self) { try EditsApp.process(in: [exact, exact]) }
    }
}
