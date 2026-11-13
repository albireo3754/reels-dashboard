import CryptoKit
import Foundation

public enum TargetRoot: String, Codable, CaseIterable, Sendable { case application, menuBar }

public struct Target: Codable, Equatable, Sendable {
    public var pid: Int32
    public var root: TargetRoot
    public var path: [Int]
    public var fingerprint: String

    public init(pid: Int32, root: TargetRoot, path: [Int], fingerprint: String) {
        self.pid = pid; self.root = root; self.path = path; self.fingerprint = fingerprint
    }

    public init(json: JSON?) throws {
        guard let o = json?.object, Set(o.keys) == ["pid", "root", "path", "fingerprint"],
              let p = o["pid"]?.number, p > 0, p <= Double(Int32.max), p.rounded() == p,
              let r = o["root"]?.string.flatMap(TargetRoot.init(rawValue:)),
              let path = o["path"]?.array, path.count <= 32,
              let fingerprint = o["fingerprint"]?.string, !fingerprint.isEmpty, fingerprint.utf8.count <= 500 else {
            throw AXFailure.invalid("Invalid target")
        }
        self.pid = Int32(p); self.root = r; self.fingerprint = fingerprint
        self.path = try path.map {
            guard let n = $0.number, n >= 0, n <= Double(Int32.max), n.rounded() == n else {
                throw AXFailure.invalid("Invalid target path")
            }
            return Int(n)
        }
    }
}

public struct Rect: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
    public var valid: Bool { [x, y, width, height].allSatisfy(\.isFinite) && width > 0 && height > 0 }
    public var center: Point { Point(x: x + width / 2, y: y + height / 2) }
    public func contains(_ point: Point) -> Bool {
        valid && point.x >= x && point.x < x + width && point.y >= y && point.y < y + height
    }
}

public struct Point: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

public struct Action: Codable, Equatable, Sendable {
    public var name: String
    public var description: String
    public init(_ name: String, description: String = "") { self.name = name; self.description = description }
}

/// Metadata is read before AXValue so a secure/login field's value is never requested.
public struct Attributes: Equatable, Sendable {
    public var role = ""
    public var subrole = ""
    public var subroleConfirmedAbsentAfterFailure = false
    public var title = ""
    public var description = ""
    public var identifier = ""
    public var help = ""
    public var placeholder = ""
    public var enabled = false
    public var selected = false
    public var focused = false
    public var settable = false
    public var actions: [Action] = []
    public var frame: Rect?
    public init() {}

    public var labels: [String] { [title, description, placeholder].filter { !$0.isEmpty } }
    public var contextText: String { [role, subrole, title, description, identifier, help, placeholder].joined(separator: " ") }

    public func fingerprint(pid: Int32, root: TargetRoot) -> String {
        // A JSON array is length-delimited: separators in labels cannot create collisions.
        let fields = [String(pid), root.rawValue, role, identifier, title, description]
        let data = (try? JSONEncoder().encode(fields)) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

public struct Node: Codable, Equatable, Sendable {
    public var target: Target
    public var role: String
    public var title: String
    public var description: String
    public var identifier: String
    public var help: String
    public var placeholder: String
    public var value: JSON
    public var enabled: Bool
    public var selected: Bool
    public var focused: Bool
    public var settable: Bool
    public var actions: [Action]
    public var frame: Rect?

    public init(target: Target, attributes a: Attributes, value: JSON, sensitive: Bool) {
        self.target = target; role = a.role.bounded(); title = a.title.bounded()
        description = a.description.bounded(); identifier = a.identifier.bounded(); help = a.help.bounded()
        placeholder = a.placeholder.bounded()
        if sensitive { self.value = .null }
        else if case .string(let text) = value { self.value = .string(text.bounded(4096)) }
        else { self.value = value }
        enabled = a.enabled; selected = a.selected; focused = a.focused; settable = a.settable && !sensitive
        actions = a.actions.prefix(16).map { Action($0.name.bounded(200), description: $0.description.bounded()) }
        frame = a.frame?.valid == true ? a.frame : nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(target, forKey: .target); try c.encode(role, forKey: .role)
        try c.encode(title, forKey: .title); try c.encode(description, forKey: .description)
        try c.encode(identifier, forKey: .identifier); try c.encode(help, forKey: .help)
        try c.encode(placeholder, forKey: .placeholder)
        try c.encode(value, forKey: .value); try c.encode(enabled, forKey: .enabled)
        try c.encode(selected, forKey: .selected); try c.encode(focused, forKey: .focused)
        try c.encode(settable, forKey: .settable); try c.encode(actions, forKey: .actions)
        try c.encode(frame, forKey: .frame)
    }
}

public struct Snapshot: Codable, Equatable, Sendable {
    public var pid: Int32
    public var nodes: [Node]
    public var truncated: Bool
    public var diagnostics: TreeDiagnostics
    public init(pid: Int32, nodes: [Node], truncated: Bool, diagnostics: TreeDiagnostics = .init()) {
        self.pid = pid; self.nodes = nodes; self.truncated = truncated; self.diagnostics = diagnostics
    }
}

public struct Selector: Sendable {
    public var role: String?
    public var identifier: String?
    public var label: String?
    public init(json: JSON?) throws {
        guard let o = json?.object else { throw AXFailure.invalid("Missing selector") }
        let args = try Arguments(o, allowed: ["role", "identifier", "label"])
        role = try args.string("role", required: false)
        identifier = try args.string("identifier", required: false)
        label = try args.string("label", required: false)
        guard role != nil || identifier != nil || label != nil else { throw AXFailure.invalid("Empty selector") }
    }
    public func matches(_ a: Attributes) -> Bool {
        (role == nil || role == a.role) && (identifier == nil || identifier == a.identifier) &&
        (label == nil || a.labels.contains(label!))
    }
}

extension String {
    func bounded(_ bytes: Int = 1024) -> String {
        if utf8.count <= bytes { return self }
        return String(decoding: utf8.prefix(bytes - 3), as: UTF8.self) + "…"
    }
}
