import Foundation

public struct SubroleObservation: Equatable, Sendable {
    public let value: String
    public let confirmedAbsentAfterFailure: Bool
}

/// AXSubrole is optional for these basic non-input roles. Generic failure alone never proves absence.
public enum SubroleReadPolicy {
    private static let basicRoles: Set<String> = [
        "AXButton", "AXGroup", "AXToolbar", "AXImage", "AXStaticText", "AXScrollArea", "AXSplitGroup", "AXSplitter"
    ]

    public static func read(role: String, value: () throws -> String, isAdvertised: () throws -> Bool) throws -> SubroleObservation {
        do { return SubroleObservation(value: try value(), confirmedAbsentAfterFailure: false) }
        catch var failure as AXFailure {
            failure.details["axRole"] = .string(role)
            guard failure.code == "AX_ACTION_FAILED",
                  failure.details["axErrorCode"] == .number(-25200),
                  failure.details["axAPI"] == .string("AXUIElementCopyAttributeValue"),
                  failure.details["axAttribute"] == .string("AXSubrole") else { throw failure }
            let advertised: Bool
            do { advertised = try isAdvertised() }
            catch let probe as AXFailure {
                if probe.code == "AX_PERMISSION_REQUIRED" { throw probe }
                failure.details["axAttributeListErrorCode"] = probe.details["axErrorCode"]
                throw failure
            } catch { throw failure }
            failure.details["axAttributeListed"] = .bool(advertised)
            // Text fields (including secure subroles), windows/dialogs and unknown roles stay strict.
            guard !advertised, basicRoles.contains(role) else { throw failure }
            return SubroleObservation(value: "", confirmedAbsentAfterFailure: true)
        }
    }
}
