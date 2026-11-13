import Foundation

/// Only these two AX errors prove that the action was not dispatched.
public enum DispatchFailure: Error, Sendable {
    case notDispatched(String)
    case uncertain(String)
}

public struct Screenshot: Codable, Sendable {
    public var image: String
    public var width: Int
    public var height: Int
    public var windowId: UInt32
    public init(image: String, width: Int, height: Int, windowId: UInt32) {
        self.image = image; self.width = width; self.height = height; self.windowId = windowId
    }
}

@MainActor public protocol AccessibilityBackend {
    associatedtype Element: Hashable
    func status() throws -> AppStatus
    func root(pid: Int32, kind: TargetRoot) throws -> Element?
    func attributes(_ element: Element) throws -> Attributes
    func value(_ element: Element) throws -> JSON
    /// Returns a bounded prefix while preserving original AXChildren indices.
    func children(_ element: Element, limit: Int) throws -> (elements: [Element], truncated: Bool)
    func focusedElement(pid: Int32) throws -> Element?
    func identityEvidence(_ current: Element, first: Element, pid: Int32) -> ElementIdentityProbe
    func perform(_ element: Element, action: String) throws
    func setValue(_ element: Element, value: JSON) throws
    func key(pid: Int32, key: String) throws
    func coordinateReady(pid: Int32, target: Element, point: Point) throws -> Bool
    func screenContains(_ point: Point) -> Bool
    func click(pid: Int32, at point: Point) throws
    func drag(pid: Int32, from: Point, to: Point) throws
    func screenshot(pid: Int32) async throws -> Screenshot
}

extension AccessibilityBackend {
    public func identityEvidence(_ current: Element, first: Element, pid: Int32) -> ElementIdentityProbe {
        var evidence = ElementIdentityProbe()
        evidence.currentEqualsFirst = current == first
        return evidence
    }
}

public final class RequestBudget {
    private let clock: () -> TimeInterval
    private let deadline: TimeInterval
    public init(seconds: TimeInterval = 20, clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.clock = clock; deadline = clock() + seconds
    }
    public var expired: Bool { clock() >= deadline }
    public func check() throws {
        if expired {
            throw AXFailure("AX_OUTCOME_UNKNOWN", "Request time limit reached", details: ["outcome": .string("unknown")])
        }
    }
}

struct Record<E: Hashable> {
    let element: E
    let attributes: Attributes
    let node: Node
}

struct Capture<E: Hashable> {
    var snapshot: Snapshot
    var records: [Record<E>]
}

struct Resolved<E: Hashable> {
    var element: E
    var chain: [Attributes]
    var target: Target
    var attributes: Attributes { chain.last! }
}

@MainActor struct TreeReader<B: AccessibilityBackend> {
    let backend: B
    let budget: RequestBudget

    func capture(pid: Int32, depth: Int = 16, maxNodes: Int = 4000, byteLimit: Int = 6 * 1_048_576) throws -> Capture<B.Element> {
        var records: [Record<B.Element>] = []
        var truncated = false
        var diagnostics = TreeDiagnostics()
        var bytes = 0
        // before+after/find matches remain below the wire limit. The injectable cap is internal/test-only.
        let actualFocus = try backend.focusedElement(pid: pid)
        let menu = try backend.root(pid: pid, kind: .menuBar)
        for kind in TargetRoot.allCases {
            try budget.check()
            guard let root = try backend.root(pid: pid, kind: kind) else { continue }
            var visited: [B.Element: [Int]] = [:]
            var active: Set<B.Element> = []
            func mark(_ reason: TruncationReason, path: [Int], firstPath: [Int]? = nil, error: Error? = nil, identity: ElementIdentityProbe? = nil) {
                truncated = true
                diagnostics.record(reason, root: kind, path: path, firstPath: firstPath, error: error, identity: identity)
            }
            func visit(_ element: B.Element, path: [Int], chain: [Attributes]) throws {
                try budget.check()
                guard records.count < maxNodes else { mark(.nodeLimit, path: path); return }
                guard bytes < byteLimit else { mark(.byteLimit, path: path); return }
                if kind == .application, let menu, element == menu { return }
                if let firstPath = visited[element] {
                    let reason: TruncationReason = active.contains(element) ? .cycle : .duplicate
                    var identity: ElementIdentityProbe?
                    // Diagnose the observed application-root cycle, without bypassing it or replacing children.
                    if reason == .cycle, kind == .application, firstPath.isEmpty, diagnostics.samples.count < 16 {
                        try budget.check()
                        var probe = backend.identityEvidence(element, first: root, pid: pid)
                        probe.firstCapturedRole = records.first { $0.node.target.root == kind && $0.node.target.path == firstPath }?.attributes.role
                        identity = probe
                    }
                    mark(reason, path: path, firstPath: firstPath, identity: identity)
                    return
                }
                visited[element] = path
                active.insert(element)
                defer { active.remove(element) }
                var a: Attributes
                do { a = try backend.attributes(element) }
                catch { try propagatePermission(error); mark(.attributesReadError, path: path, error: error); return }
                if a.subroleConfirmedAbsentAfterFailure {
                    diagnostics.recordConfirmedAbsentSubrole(root: kind, path: path, role: a.role)
                }
                a.focused = actualFocus == element || a.focused
                let sensitive = SafetyPolicy.sensitive(chain + [a])
                let value: JSON
                do { value = sensitive ? .null : try backend.value(element) }
                catch { try propagatePermission(error); mark(.valueReadError, path: path, error: error); value = .null }
                let target = Target(pid: pid, root: kind, path: path, fingerprint: a.fingerprint(pid: pid, root: kind))
                let node = Node(target: target, attributes: a, value: value, sensitive: sensitive)
                bytes += (try JSONEncoder().encode(node)).count
                guard bytes < byteLimit else { mark(.byteLimit, path: path); return }
                records.append(Record(element: element, attributes: a, node: node))
                let children: (elements: [B.Element], truncated: Bool)
                do { children = try backend.children(element, limit: maxNodes) }
                catch { try propagatePermission(error); mark(.childrenReadError, path: path, error: error); return }
                if children.truncated { mark(.childrenLimit, path: path) }
                if path.count >= depth {
                    if !children.elements.isEmpty { mark(.depthLimit, path: path) }
                    return
                }
                for (index, child) in children.elements.enumerated() {
                    if records.count >= maxNodes { mark(.nodeLimit, path: path + [index]); break }
                    if bytes >= byteLimit { mark(.byteLimit, path: path + [index]); break }
                    try visit(child, path: path + [index], chain: chain + [a])
                }
            }
            try visit(root, path: [], chain: [])
        }
        return Capture(snapshot: Snapshot(pid: pid, nodes: records.map(\.node), truncated: truncated, diagnostics: diagnostics), records: records)
    }

    private func propagatePermission(_ error: Error) throws {
        if let failure = error as? AXFailure, failure.code == "AX_PERMISSION_REQUIRED" { throw failure }
    }

    func resolve(_ target: Target, pid: Int32) throws -> Resolved<B.Element> {
        try budget.check()
        guard target.pid == pid else { throw AXFailure("AX_STALE_TARGET", "Target process changed") }
        guard var element = try backend.root(pid: pid, kind: target.root) else {
            throw AXFailure("AX_TARGET_NOT_FOUND", "Target root is unavailable")
        }
        var chain = [try backend.attributes(element)]
        for index in target.path {
            try budget.check()
            // Snapshot indices are capped at 4000; do not allocate an attacker-controlled prefix.
            guard index < 4000 else { throw AXFailure("AX_TARGET_NOT_FOUND", "Target path is out of bounds") }
            let children = try backend.children(element, limit: index + 1).elements
            guard children.indices.contains(index) else { throw AXFailure("AX_TARGET_NOT_FOUND", "Target path is missing") }
            element = children[index]
            chain.append(try backend.attributes(element))
        }
        guard chain.last!.fingerprint(pid: pid, root: target.root) == target.fingerprint else {
            throw AXFailure("AX_STALE_TARGET", "Target identity changed at the observed root/path")
        }
        return Resolved(element: element, chain: chain, target: target)
    }
}
