import Foundation

public enum JSON: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let b = try? value.decode(Bool.self) { self = .bool(b) }
        else if let n = try? value.decode(Double.self), n.isFinite { self = .number(n) }
        else if let s = try? value.decode(String.self) { self = .string(s) }
        else if let a = try? value.decode([JSON].self) { self = .array(a) }
        else { self = .object(try value.decode([String: JSON].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let b): try container.encode(b)
        case .number(let n): try container.encode(n)
        case .string(let s): try container.encode(s)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }

    public static func encoded<T: Encodable>(_ value: T) throws -> JSON {
        try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(value))
    }

    public subscript(_ key: String) -> JSON? {
        guard case .object(let o) = self else { return nil }
        return o[key]
    }
    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var object: [String: JSON]? { if case .object(let o) = self { return o }; return nil }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var number: Double? { if case .number(let n) = self { return n }; return nil }
    public var array: [JSON]? { if case .array(let a) = self { return a }; return nil }
}

public struct AXFailure: Error, Codable, Equatable, Sendable {
    public var code: String
    public var message: String
    public var details: [String: JSON]

    public init(_ code: String, _ message: String, details: [String: JSON] = [:]) {
        self.code = code
        self.message = message
        self.details = details
    }

    public static func invalid(_ message: String) -> AXFailure {
        AXFailure("INVALID_REQUEST", message)
    }
}

public enum Wire {
    public static let maxInputBytes = 1_048_576
    public static let maxOutputBytes = 16_777_216

    public struct Request: Sendable {
        public let id: String
        public let operation: String
        public let args: [String: JSON]

        public init(data: Data) throws {
            guard data.count <= Wire.maxInputBytes else { throw AXFailure.invalid("Input exceeds 1 MiB") }
            guard String(data: data, encoding: .utf8) != nil else { throw AXFailure.invalid("Input must be UTF-8 JSON") }
            let value: JSON
            do { value = try JSONDecoder().decode(JSON.self, from: data) }
            catch { throw AXFailure.invalid("Expected one JSON request document") }
            guard let o = value.object, Set(o.keys) == ["protocol", "id", "operation", "args"],
                  o["protocol"] == .number(1),
                  let id = o["id"]?.string, !id.isEmpty, id.utf8.count <= 256,
                  let operation = o["operation"]?.string,
                  ["status", "tree", "find", "press", "set-value", "menu", "key", "drag", "screenshot"].contains(operation),
                  let args = o["args"]?.object else {
                throw AXFailure.invalid("Invalid protocol, id, operation or args")
            }
            self.id = id
            self.operation = operation
            self.args = args
        }
    }

    public static func response(id: String, result: JSON) -> JSON {
        .object(["protocol": .number(1), "id": .string(id), "ok": .bool(true), "result": result])
    }

    public static func response(id: String, error: AXFailure) -> JSON {
        .object(["protocol": .number(1), "id": .string(id), "ok": .bool(false),
                 "error": (try? JSON.encoded(error)) ?? .null])
    }

    /// Invalid documents have an empty id unless a valid bounded id can be recovered.
    public static func requestID(in data: Data) -> String {
        guard data.count <= maxInputBytes,
              let value = try? JSONDecoder().decode(JSON.self, from: data),
              let id = value["id"]?.string, id.utf8.count <= 256 else { return "" }
        return id
    }

    public static func encode(_ response: JSON) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(response)
        guard data.count < maxOutputBytes else {
            throw AXFailure("AX_ACTION_FAILED", "Response exceeds 16 MiB", details: ["outcome": .string("unknown")])
        }
        data.append(10)
        return data
    }
}

public struct Arguments {
    public let values: [String: JSON]
    public init(_ values: [String: JSON], allowed: Set<String>) throws {
        guard Set(values.keys).isSubset(of: allowed) else { throw AXFailure.invalid("Unknown argument") }
        self.values = values
    }
    public func string(_ key: String, required: Bool = true) throws -> String? {
        guard let value = values[key] else {
            if required { throw AXFailure.invalid("Missing \(key)") }; return nil
        }
        guard let s = value.string, !s.isEmpty, s.utf8.count <= 4096 else { throw AXFailure.invalid("Invalid \(key)") }
        return s
    }
    public func bool(_ key: String, default fallback: Bool = false) throws -> Bool {
        guard let value = values[key] else { return fallback }
        guard let b = value.bool else { throw AXFailure.invalid("Invalid \(key)") }
        return b
    }
    public func number(_ key: String, default fallback: Double? = nil, range: ClosedRange<Double>) throws -> Double {
        guard let value = values[key] else {
            if let fallback { return fallback }; throw AXFailure.invalid("Missing \(key)")
        }
        guard let n = value.number, n.isFinite, range.contains(n) else { throw AXFailure.invalid("Invalid \(key)") }
        return n
    }
    public func integer(_ key: String, default fallback: Int, range: ClosedRange<Int>) throws -> Int {
        let value = try number(key, default: Double(fallback), range: Double(range.lowerBound)...Double(range.upperBound))
        guard value.rounded() == value else { throw AXFailure.invalid("\(key) must be an integer") }
        return Int(value)
    }
}
