import Foundation

public enum TruncationReason: String, Codable, Sendable {
    case depthLimit = "depth-limit"
    case nodeLimit = "node-limit"
    case byteLimit = "byte-limit"
    case childrenLimit = "children-limit"
    case duplicate
    case cycle
    case attributesReadError = "attributes-read-error"
    case valueReadError = "value-read-error"
    case childrenReadError = "children-read-error"
}

/// Bounded metadata only: no element labels, values, error messages or arbitrary error details.
public struct TreeDiagnostics: Codable, Equatable, Sendable {
    public struct Sample: Codable, Equatable, Sendable {
        public var reason: TruncationReason
        public var root: TargetRoot
        public var path: [Int]
        public var firstPath: [Int]?
        public var errorCode: String?
        public var axErrorCode: Int?
        public var axAPI: String?
        public var axAttribute: String?
        public var axRole: String?
        public var axAttributeListed: Bool?
        public var axAttributeListErrorCode: Int?
        public var identity: ElementIdentityProbe?
    }

    public struct ConfirmedAbsentSubrole: Codable, Equatable, Sendable {
        public var root: TargetRoot
        public var path: [Int]
        public var role: String
    }

    public private(set) var counts: [String: Int] = [:]
    public private(set) var samples: [Sample] = []
    public private(set) var samplesOmitted = 0
    public private(set) var confirmedAbsentSubroles = 0
    public private(set) var confirmedAbsentSubroleSamples: [ConfirmedAbsentSubrole] = []
    public init() {}

    mutating func record(_ reason: TruncationReason, root: TargetRoot, path: [Int], firstPath: [Int]? = nil, error: Error? = nil, identity: ElementIdentityProbe? = nil) {
        counts[reason.rawValue, default: 0] += 1
        guard samples.count < 16 else { samplesOmitted += 1; return }
        let failure = error as? AXFailure
        samples.append(Sample(reason: reason, root: root, path: path, firstPath: firstPath,
            errorCode: failure?.code.bounded(100), axErrorCode: integer(failure?.details["axErrorCode"]),
            axAPI: failure?.details["axAPI"]?.string?.bounded(200),
            axAttribute: failure?.details["axAttribute"]?.string?.bounded(200),
            axRole: failure?.details["axRole"]?.string?.bounded(100),
            axAttributeListed: failure?.details["axAttributeListed"]?.bool,
            axAttributeListErrorCode: integer(failure?.details["axAttributeListErrorCode"]), identity: identity?.bounded()))
    }

    mutating func recordConfirmedAbsentSubrole(root: TargetRoot, path: [Int], role: String) {
        confirmedAbsentSubroles += 1
        if confirmedAbsentSubroleSamples.count < 16 {
            confirmedAbsentSubroleSamples.append(.init(root: root, path: path, role: role.bounded(100)))
        }
    }

    private func integer(_ value: JSON?) -> Int? {
        guard let n = value?.number, n.isFinite, n.rounded() == n,
              n >= Double(Int32.min), n <= Double(Int32.max) else { return nil }
        return Int(n)
    }
}
