import Foundation

public struct ActionResult: Encodable, Sendable {
    public var attempted: Bool
    public var dryRun: Bool
    public var verified: Bool
    public var verification: Verification
    public var fallback: String?
    public var before: Snapshot
    public var after: Snapshot

    public struct Verification: Codable, Sendable {
        public var kind: String
        public var reason: String
    }
    enum CodingKeys: String, CodingKey { case attempted, dryRun, verified, verification, fallback, before, after }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(attempted, forKey: .attempted); try c.encode(dryRun, forKey: .dryRun)
        try c.encode(verified, forKey: .verified); try c.encode(verification, forKey: .verification)
        try c.encode(fallback, forKey: .fallback); try c.encode(before, forKey: .before); try c.encode(after, forKey: .after)
    }
}

@MainActor public final class Engine<B: AccessibilityBackend> {
    private let backend: B
    public init(backend: B) { self.backend = backend }

    public func execute(_ request: Wire.Request, budget supplied: RequestBudget? = nil) async throws -> JSON {
        let budget = supplied ?? RequestBudget(seconds: request.operation == "screenshot" ? 30 : 20)
        try budget.check()
        let op = request.operation
        let allowed: Set<String>
        switch op {
        case "status", "screenshot": allowed = []
        case "tree": allowed = ["depth", "maxNodes"]
        case "find": allowed = ["selector", "depth", "maxNodes"]
        case "press": allowed = ["target", "intent", "action", "allowCoordinateFallback", "dryRun"]
        case "set-value": allowed = ["target", "intent", "value", "dryRun"]
        case "key": allowed = ["target", "context", "key", "dryRun"]
        case "menu": allowed = ["path", "dryRun"]
        case "drag": allowed = ["target", "deltaX", "deltaY", "dryRun"]
        default: throw AXFailure.invalid("Unknown operation")
        }
        let args = try Arguments(request.args, allowed: allowed)
        let status = try backend.status()
        if op == "status" { return try JSON.encoded(status) }
        guard status.trusted else { throw AXFailure("AX_PERMISSION_REQUIRED", "Accessibility permission is required") }
        guard let pid = status.pid else { throw AXFailure("EDITS_NOT_RUNNING", "The exact /Applications/Edits.app is not running") }
        if op == "screenshot" {
            guard status.screenCaptureAllowed else {
                throw AXFailure("SCREEN_CAPTURE_PERMISSION_REQUIRED", "Screen capture permission is required")
            }
            let screenshot = try await backend.screenshot(pid: pid)
            try budget.check()
            return try JSON.encoded(screenshot)
        }
        let reader = TreeReader(backend: backend, budget: budget)
        if op == "tree" || op == "find" {
            let depth = try args.integer("depth", default: 12, range: 1...16)
            let maxNodes = try args.integer("maxNodes", default: 3000, range: 1...4000)
            let selector = op == "find" ? try Selector(json: args.values["selector"]) : nil
            let capture = try reader.capture(pid: pid, depth: depth, maxNodes: maxNodes)
            if let selector {
                let matches = capture.records.filter { selector.matches($0.attributes) }.map(\.node)
                return .object(["snapshot": try JSON.encoded(capture.snapshot), "matches": try JSON.encoded(matches)])
            }
            return try JSON.encoded(capture.snapshot)
        }
        let dryRun = try args.bool("dryRun")
        let before = try reader.capture(pid: pid)
        guard !before.snapshot.truncated else {
            throw AXFailure("AX_ACTION_FORBIDDEN", "A complete bounded tree is required to classify a write safely",
                            details: ["diagnostics": try JSON.encoded(before.snapshot.diagnostics)])
        }
        var attempted = false
        var fallback: String?
        var valueVerified = false
        do {
            if op == "menu" {
                let path = try menuPath(args.values["path"])
                try checkMenuContext(before)
                if !dryRun {
                    try assertProcess(pid)
                    try performMenu(path: path, pid: pid, reader: reader, attempted: &attempted)
                }
            } else {
                let target = try Target(json: args.values["target"])
                var resolved = try reader.resolve(target, pid: pid)
                var c = context(resolved, capture: before)
                switch op {
                case "press":
                    let intent = try args.string("intent")!
                    let requestedAction = try args.string("action", required: false) ?? "AXPress"
                    let coordinate = try args.bool("allowCoordinateFallback")
                    var action = requestedAction
                    if requestedAction == "Edit timecode", resolved.attributes.identifier == "editor.timecode" {
                        let matches = resolved.attributes.actions.filter { $0.name == requestedAction || $0.description == requestedAction }
                        guard matches.count == 1 else { throw SafetyPolicy.denied("Edit timecode action is ambiguous or unavailable") }
                        action = matches[0].name
                    }
                    try SafetyPolicy.press(intent, action: action, context: c)
                    if !dryRun {
                        try assertProcess(pid)
                        (resolved, c, _) = try freshTarget(target, pid: pid, reader: reader)
                        try SafetyPolicy.press(intent, action: action, context: c)
                        var notDispatched = !resolved.attributes.actions.contains { $0.name == action }
                        if !notDispatched {
                            try budget.check()
                            attempted = true
                            do { try backend.perform(resolved.element, action: action) }
                            catch DispatchFailure.notDispatched { notDispatched = true; attempted = false }
                        }
                        if notDispatched {
                            guard coordinate && action == "AXPress" else {
                                throw AXFailure("AX_ACTION_FAILED", "Allowed AX action is not implemented or not exposed")
                            }
                            // Re-resolve and re-check intent, identity and frame after a proven non-dispatch.
                            (resolved, c, _) = try freshTarget(target, pid: pid, reader: reader)
                            try SafetyPolicy.press(intent, action: action, context: c)
                            let point = try coordinatePoint(resolved, pid: pid)
                            try budget.check()
                            fallback = "coordinate"; attempted = true
                            try backend.click(pid: pid, at: point)
                        }
                    }
                case "set-value":
                    let intent = try args.string("intent")!
                    guard let value = args.values["value"], validValue(value) else { throw AXFailure.invalid("Invalid scalar value") }
                    try SafetyPolicy.value(intent, context: c)
                    guard resolved.attributes.settable else { throw AXFailure("AX_VALUE_NOT_SETTABLE", "AXValue is not settable") }
                    let current = try backend.value(resolved.element)
                    guard sameType(current, value) else { throw AXFailure.invalid("Value type does not match the actual AXValue type") }
                    if !dryRun {
                        try assertProcess(pid)
                        (resolved, c, _) = try freshTarget(target, pid: pid, reader: reader)
                        try SafetyPolicy.value(intent, context: c)
                        guard resolved.attributes.settable else { throw AXFailure("AX_VALUE_NOT_SETTABLE", "AXValue is no longer settable") }
                        guard sameType(try backend.value(resolved.element), value) else { throw AXFailure.invalid("AXValue type changed before setting") }
                        try budget.check()
                        attempted = true
                        try backend.setValue(resolved.element, value: value)
                        let fresh = try reader.resolve(target, pid: pid)
                        guard !SafetyPolicy.sensitive(fresh.chain) else { throw AXFailure("AX_VERIFICATION_FAILED", "Value context changed") }
                        valueVerified = try backend.value(fresh.element) == value
                        guard valueVerified else { throw AXFailure("AX_VERIFICATION_FAILED", "AXValue readback did not match the requested value") }
                    }
                case "key":
                    let key = try args.string("key")!
                    let keyContext = try args.string("context")!
                    let allowedKeys = ["escape", "return", "tab", "select-all", "go-to-folder"]
                    guard allowedKeys.contains(key) else { throw AXFailure.invalid("Unknown key") }
                    let focus = try focusedContext(pid: pid, capture: before, reader: reader)
                    try SafetyPolicy.key(key, context: keyContext, target: c, focus: focus)
                    if !dryRun {
                        try assertProcess(pid)
                        let fresh = try freshTarget(target, pid: pid, reader: reader)
                        let currentFocus = try focusedContext(pid: pid, capture: fresh.2, reader: reader)
                        try SafetyPolicy.key(key, context: keyContext, target: fresh.1, focus: currentFocus)
                        try budget.check()
                        attempted = true
                        try backend.key(pid: pid, key: key)
                    }
                case "drag":
                    let dx = try args.number("deltaX", range: -1000...1000)
                    let dy = try args.number("deltaY", default: 0, range: -1000...1000)
                    guard dx != 0 || dy != 0 else { throw AXFailure.invalid("Drag delta must be nonzero") }
                    try SafetyPolicy.drag(c, evidence: c.evidence)
                    let start = try coordinatePoint(resolved, pid: pid)
                    let end = Point(x: start.x + dx, y: start.y + dy)
                    guard backend.screenContains(end) else { throw SafetyPolicy.denied("Drag endpoint is offscreen") }
                    if !dryRun {
                        try assertProcess(pid)
                        let (freshResolved, freshContext, _) = try freshTarget(target, pid: pid, reader: reader)
                        resolved = freshResolved
                        try SafetyPolicy.drag(freshContext, evidence: freshContext.evidence)
                        guard try coordinatePoint(resolved, pid: pid) == start else { throw AXFailure("AX_STALE_TARGET", "Drag frame moved") }
                        try budget.check()
                        attempted = true; fallback = "coordinate"
                        try backend.drag(pid: pid, from: start, to: end)
                    }
                default: throw AXFailure.invalid("Unsupported action")
                }
            }
            let after = dryRun ? before.snapshot : try reader.capture(pid: pid).snapshot
            // Diagnostic differences and incomplete observations do not prove a UI state change.
            let changed = !after.truncated && before.snapshot.nodes != after.nodes
            let kind = dryRun ? "dry-run" : valueVerified ? "value-match" : changed ? "state-change" : "outcome-unknown"
            let reason = dryRun ? "Plan validated without dispatching input" : valueVerified ? "AXValue matched after setting" :
                after.truncated ? "After AX observation is incomplete; outcome is unknown and must not be replayed" :
                changed ? "AX state changed; the high-level postcondition still needs verification" : "No AX state change observed; do not replay this action"
            return try JSON.encoded(ActionResult(attempted: attempted, dryRun: dryRun, verified: valueVerified,
                verification: .init(kind: kind, reason: reason), fallback: fallback, before: before.snapshot, after: after))
        } catch {
            var failure: AXFailure
            switch error {
            case let known as AXFailure: failure = known
            case DispatchFailure.notDispatched(let reason):
                if op != "menu" { attempted = false }
                failure = AXFailure("AX_ACTION_FAILED", reason)
            case DispatchFailure.uncertain(let reason): failure = AXFailure("AX_OUTCOME_UNKNOWN", reason, details: ["outcome": .string("unknown")])
            default: failure = AXFailure("AX_OUTCOME_UNKNOWN", "Native action failed with an uncertain outcome", details: ["outcome": .string("unknown")])
            }
            failure.details["attempted"] = .bool(attempted)
            failure.details["before"] = try? JSON.encoded(before.snapshot)
            if let fallback { failure.details["fallback"] = .string(fallback) }
            // One bounded observation, never a polling loop or automatic replay.
            if !budget.expired, let after = try? reader.capture(pid: pid).snapshot {
                failure.details["after"] = try? JSON.encoded(after)
            }
            throw failure
        }
    }

    private func assertProcess(_ pid: Int32) throws {
        let status = try backend.status()
        guard status.trusted else { throw AXFailure("AX_PERMISSION_REQUIRED", "Accessibility permission is required") }
        guard status.pid == pid else { throw AXFailure("AX_STALE_TARGET", "Exact Edits process changed before dispatch") }
    }

    private func freshTarget(_ target: Target, pid: Int32, reader: TreeReader<B>) throws -> (Resolved<B.Element>, PolicyContext, Capture<B.Element>) {
        let capture = try reader.capture(pid: pid)
        guard !capture.snapshot.truncated else {
            throw AXFailure("AX_ACTION_FORBIDDEN", "Current write context is incomplete",
                            details: ["diagnostics": try JSON.encoded(capture.snapshot.diagnostics)])
        }
        let resolved = try reader.resolve(target, pid: pid)
        return (resolved, context(resolved, capture: capture), capture)
    }

    private func context(_ r: Resolved<B.Element>, capture: Capture<B.Element>) -> PolicyContext {
        let windowIndex = r.chain.lastIndex { $0.role == "AXWindow" || $0.role == "AXSheet" || SafetyPolicy.dialog($0) } ?? 0
        let windowPath = Array(r.target.path.prefix(windowIndex))
        let evidence = capture.records.filter {
            $0.node.target.root == r.target.root && $0.node.target.path.starts(with: windowPath)
        }.map(\.attributes)
        let mainWindowIndex = r.chain.lastIndex { $0.role == "AXWindow" } ?? windowIndex
        let mainWindowPath = Array(r.target.path.prefix(mainWindowIndex))
        let windowEvidence = capture.records.filter {
            $0.node.target.root == r.target.root && $0.node.target.path.starts(with: mainWindowPath)
        }.map(\.attributes)
        let parentPath = Array(r.target.path.dropLast())
        let localEvidence = capture.records.filter {
            $0.node.target.root == r.target.root && $0.node.target.path.starts(with: parentPath)
        }.map(\.attributes)
        let dialogs = capture.records.filter { SafetyPolicy.dialog($0.attributes) }
        let unrelated = dialogs.contains {
            $0.node.target.root != r.target.root || !r.target.path.starts(with: $0.node.target.path)
        }
        let leaf = !(capture.records.contains {
            $0.node.target.root == r.target.root && $0.node.target.path.count > r.target.path.count &&
            $0.node.target.path.starts(with: r.target.path) && $0.attributes.role == "AXButton"
        })
        return PolicyContext(target: r.target, chain: r.chain, evidence: evidence,
                             windowEvidence: windowEvidence, localEvidence: localEvidence, leaf: leaf,
                             blockingDialog: !dialogs.isEmpty, unrelatedDialog: unrelated)
    }

    private func focusedContext(pid: Int32, capture: Capture<B.Element>, reader: TreeReader<B>) throws -> PolicyContext {
        guard let focus = try backend.focusedElement(pid: pid),
              let record = capture.records.first(where: { $0.element == focus }) else {
            throw SafetyPolicy.denied("Actual focus is unavailable or outside the bounded tree")
        }
        let resolved = try reader.resolve(record.node.target, pid: pid)
        guard resolved.element == focus else { throw SafetyPolicy.denied("Actual focus changed") }
        return context(resolved, capture: capture)
    }

    private func coordinatePoint(_ r: Resolved<B.Element>, pid: Int32) throws -> Point {
        guard let frame = r.attributes.frame, frame.valid, backend.screenContains(frame.center),
              try backend.coordinateReady(pid: pid, target: r.element, point: frame.center) else {
            throw SafetyPolicy.denied("Target center is offscreen, occluded, unfocused or not independently hit-testable")
        }
        return frame.center
    }

    private func validValue(_ value: JSON) -> Bool {
        switch value {
        case .string(let s): return s.utf8.count <= 40_000 && !s.contains("\0")
        case .number(let n): return n.isFinite
        case .bool: return true
        default: return false
        }
    }
    private func sameType(_ lhs: JSON, _ rhs: JSON) -> Bool {
        switch (lhs, rhs) { case (.string, .string), (.number, .number), (.bool, .bool): return true; default: return false }
    }

    private func menuPath(_ json: JSON?) throws -> [String] {
        guard let array = json?.array, array.count == 2,
              let first = array[0].string, let second = array[1].string else { throw AXFailure.invalid("Menu path must contain two strings") }
        let path = [first, second]
        guard [["File", "Import Media"], ["File", "Close"], ["Clip", "Duration"]].contains(path) else {
            throw SafetyPolicy.denied("Menu path is outside the allowlist")
        }
        return path
    }

    private func checkMenuContext(_ capture: Capture<B.Element>) throws {
        guard !capture.snapshot.truncated,
              capture.records.contains(where: { $0.attributes.role == "AXWindow" && ["editor", "home"].contains($0.attributes.identifier) }),
              !capture.records.contains(where: { SafetyPolicy.dialog($0.attributes) || ($0.attributes.focused && SafetyPolicy.forbidden([$0.attributes])) }) else {
            throw SafetyPolicy.denied("Menu requires a classified Edits window without a dialog")
        }
    }

    private func performMenu(path: [String], pid: Int32, reader: TreeReader<B>, attempted: inout Bool) throws {
        guard let root = try backend.root(pid: pid, kind: .menuBar) else { throw AXFailure("AX_TARGET_NOT_FOUND", "Menu bar is unavailable") }
        func unique(_ items: [B.Element], label: String) throws -> B.Element {
            let matches = try items.filter { try backend.attributes($0).labels.contains(label) }
            guard matches.count == 1 else { throw AXFailure("AX_TARGET_NOT_FOUND", "Menu item is missing or ambiguous") }
            return matches[0]
        }
        func press(_ element: B.Element) throws {
            try reader.budget.check()
            let a = try backend.attributes(element)
            guard a.enabled, !SafetyPolicy.forbidden([a]), let action = a.actions.first(where: { ["AXPress", "AXPick"].contains($0.name) }) else {
                throw SafetyPolicy.denied("Menu item is disabled, forbidden or has no supported action")
            }
            attempted = true
            try backend.perform(element, action: action.name)
        }
        let top = try unique(backend.children(root, limit: 100).elements, label: path[0])
        try checkMenuContext(reader.capture(pid: pid))
        try press(top)
        try checkMenuContext(reader.capture(pid: pid))
        var items: [B.Element] = []
        for child in try backend.children(top, limit: 100).elements {
            let a = try backend.attributes(child)
            if a.role == "AXMenu" { items += try backend.children(child, limit: 200).elements }
            else { items.append(child) }
        }
        let leaf = try unique(items, label: path[1])
        try assertProcess(pid)
        try press(leaf)
    }
}
