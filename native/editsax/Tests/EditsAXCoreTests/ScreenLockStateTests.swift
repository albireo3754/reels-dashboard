import Foundation
import Testing
@testable import EditsAXCore

struct ScreenLockStateTests {
    @Test func explicitBooleansArePreserved() throws {
        #expect(ScreenLockState(sessionDictionary: ["CGSSessionScreenIsLocked": true]) == .locked)
        #expect(ScreenLockState(sessionDictionary: ["CGSSessionScreenIsLocked": false]) == .unlocked)
        #expect(ScreenLockState(sessionDictionary: ["CGSSessionScreenIsLocked": NSNumber(value: true)]) == .locked)
        #expect(ScreenLockState(sessionDictionary: ["CGSSessionScreenIsLocked": NSNumber(value: false)]) == .unlocked)
    }

    @Test func absentSessionOrKeyIsUnknown() {
        #expect(ScreenLockState(sessionDictionary: nil) == .unknown)
        #expect(ScreenLockState(sessionDictionary: [:]) == .unknown)
        #expect(ScreenLockState(sessionDictionary: ["ScreenIsLocked": false]) == .unknown)
        #expect(ScreenLockState(sessionDictionary: ["kCGSSessionOnConsoleKey": true, "kCGSSessionLoginDoneKey": true]) == .unknown)
    }

    @Test func numbersStringsAndNullAreNotBooleans() {
        for value: Any in [NSNumber(value: 0), NSNumber(value: 1), NSNumber(value: 2), "true", "false", "1", NSNull()] {
            #expect(ScreenLockState(sessionDictionary: ["CGSSessionScreenIsLocked": value]) == .unknown)
        }
    }

    @Test func wireUsesExactlyBooleanOrUnknown() throws {
        for (state, expected) in [(ScreenLockState.locked, JSON.bool(true)), (.unlocked, .bool(false)), (.unknown, .string("unknown"))] {
            #expect(try JSON.encoded(state) == expected)
            #expect(try JSONDecoder().decode(ScreenLockState.self, from: JSONEncoder().encode(state)) == state)
        }
        for invalid in ["null", "0", "1", "\"true\"", "\"false\""] {
            #expect(throws: (any Error).self) { try JSONDecoder().decode(ScreenLockState.self, from: Data(invalid.utf8)) }
        }
    }

    @Test func statusSerializesOnlyLockStateAndExistingFields() throws {
        let session: NSDictionary = ["CGSSessionScreenIsLocked": true, "unrelatedPrivateField": "synthetic-private-marker"]
        let state = ScreenLockState(sessionDictionary: session)
        let status = AppStatus(trusted: false, installed: false, pid: nil, version: nil, helperPid: 1,
                               parentPid: 2, screenCaptureAllowed: false, screenLocked: state)
        let value = try JSON.encoded(status)
        #expect(value["screenLocked"] == .bool(true))
        #expect(value["trusted"] == .bool(false)); #expect(value["pid"] == .null)
        #expect(Set(try #require(value.object).keys) == ["trusted", "appPath", "installed", "running", "pid", "version", "bundleId", "helperPid", "parentPid", "screenCaptureAllowed", "screenLocked"])
        let text = String(decoding: try JSONEncoder().encode(status), as: UTF8.self)
        #expect(!text.contains("synthetic-private-marker")); #expect(!text.contains("CGSSession"))
    }
}
