import Foundation

/// Read-only evidence for a root cycle. Roles/PIDs/comparisons only; no labels, values or addresses.
public struct ElementIdentityProbe: Codable, Equatable, Sendable {
    public var firstCapturedRole: String?
    public var currentRole: String?
    public var firstRoleNow: String?
    public var currentPid: Int32?
    public var firstPid: Int32?
    public var sameReference: Bool?
    public var currentEqualsFirst: Bool?
    public var freshApplicationRole: String?
    public var freshChildPresent: Bool?
    public var freshFirstChildRole: String?
    public var freshChildEqualsApplication: Bool?
    public var freshChildEqualsCurrent: Bool?
    public var probeErrorCode: String?
    public var probeAXErrorCode: Int?
    public var probeAXAPI: String?
    public var probeAXAttribute: String?
    public init() {}

    func bounded() -> ElementIdentityProbe {
        var p = self
        p.firstCapturedRole = firstCapturedRole?.bounded(100)
        p.currentRole = currentRole?.bounded(100); p.firstRoleNow = firstRoleNow?.bounded(100)
        p.freshApplicationRole = freshApplicationRole?.bounded(100); p.freshFirstChildRole = freshFirstChildRole?.bounded(100)
        p.probeErrorCode = probeErrorCode?.bounded(100); p.probeAXAPI = probeAXAPI?.bounded(200)
        p.probeAXAttribute = probeAXAttribute?.bounded(200)
        return p
    }
}
