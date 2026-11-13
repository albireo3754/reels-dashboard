import CoreFoundation
import Foundation

public enum ScreenLockState: Equatable, Codable, Sendable {
    case locked, unlocked, unknown

    /// Read exactly one session key. Missing keys, numbers and strings are never coerced to Bool.
    public init(sessionDictionary: NSDictionary?) {
        guard let raw = sessionDictionary?.object(forKey: "CGSSessionScreenIsLocked"),
              CFGetTypeID(raw as CFTypeRef) == CFBooleanGetTypeID(),
              let value = raw as? Bool else { self = .unknown; return }
        self = value ? .locked : .unlocked
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let value = try? c.decode(Bool.self) { self = value ? .locked : .unlocked }
        else if try c.decode(String.self) == "unknown" { self = .unknown }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "Expected Bool or unknown") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .locked: try c.encode(true)
        case .unlocked: try c.encode(false)
        case .unknown: try c.encode("unknown")
        }
    }
}
