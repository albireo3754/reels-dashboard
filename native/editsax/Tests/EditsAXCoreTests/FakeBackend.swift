import Foundation
@testable import EditsAXCore

@MainActor final class FakeBackend: AccessibilityBackend {
    typealias Element = Int
    var appStatus = AppStatus(trusted: true, installed: true, pid: 42, version: "synthetic",
                              helperPid: 43, parentPid: 44, screenCaptureAllowed: true)
    var metadata: [Int: Attributes] = [:]
    var values: [Int: JSON] = [:]
    var edges: [Int: [Int]] = [:]
    var focus: Int?
    var calls: [String] = []
    var valueReads: [Int] = []
    var metadataReads: [Int: Int] = [:]
    var readHook: ((Int, Int) -> Void)?
    var performHook: ((Int, String) -> Void)?
    var performFailure: DispatchFailure?
    var setFailure: DispatchFailure?
    var ignoreSet = false
    var coordinateAllowed = true
    var failedReads: Set<Int> = []
    var attributeFailures: [Int: AXFailure] = [:]
    var valueFailures: [Int: AXFailure] = [:]
    var childrenFailures: [Int: AXFailure] = [:]
    var rootReads = 0
    var identityProbe: ElementIdentityProbe?
    var identityProbeCalls = 0

    init() {
        add(1, role: "AXApplication", title: "Edits")
        add(2, parent: 1, role: "AXWindow", identifier: "editor")
        add(100, role: "AXMenuBar")
    }

    @discardableResult func add(_ element: Int, parent: Int? = nil, role: String = "AXButton", title: String = "",
                               identifier: String = "", description: String = "", placeholder: String = "",
                               subrole: String = "", actions: [Action] = [Action("AXPress")], selected: Bool = false,
                               settable: Bool = false, value: JSON = .null) -> Int {
        var a = Attributes()
        a.role = role; a.title = title; a.description = description; a.identifier = identifier
        a.placeholder = placeholder; a.subrole = subrole; a.actions = actions; a.enabled = true
        a.selected = selected; a.settable = settable; a.frame = Rect(x: 10, y: 20, width: 100, height: 80)
        metadata[element] = a; values[element] = value; edges[element] = []
        if let parent { edges[parent, default: []].append(element) }
        return element
    }
    func status() throws -> AppStatus { appStatus }
    func root(pid: Int32, kind: TargetRoot) throws -> Int? { rootReads += 1; return kind == .application ? 1 : 100 }
    func attributes(_ element: Int) throws -> Attributes {
        metadataReads[element, default: 0] += 1
        readHook?(element, metadataReads[element]!)
        if let failure = attributeFailures[element] { throw failure }
        guard !failedReads.contains(element), let a = metadata[element] else { throw AXFailure("AX_TARGET_NOT_FOUND", "Synthetic missing node") }
        return a
    }
    func value(_ element: Int) throws -> JSON {
        valueReads.append(element)
        if let failure = valueFailures[element] { throw failure }
        return values[element] ?? .null
    }
    func children(_ element: Int, limit: Int) throws -> (elements: [Int], truncated: Bool) {
        if let failure = childrenFailures[element] { throw failure }
        let all = edges[element] ?? []
        return (Array(all.prefix(limit)), all.count > limit)
    }
    func focusedElement(pid: Int32) throws -> Int? { focus }
    func identityEvidence(_ current: Int, first: Int, pid: Int32) -> ElementIdentityProbe {
        identityProbeCalls += 1
        if let identityProbe { return identityProbe }
        var evidence = ElementIdentityProbe()
        evidence.currentRole = metadata[current]?.role; evidence.firstRoleNow = metadata[first]?.role
        evidence.currentPid = pid; evidence.firstPid = pid
        evidence.sameReference = current == first; evidence.currentEqualsFirst = current == first
        evidence.freshApplicationRole = metadata[1]?.role
        evidence.freshChildPresent = !(edges[1] ?? []).isEmpty
        if let child = edges[1]?.first {
            evidence.freshFirstChildRole = metadata[child]?.role
            evidence.freshChildEqualsApplication = child == 1; evidence.freshChildEqualsCurrent = child == current
        }
        return evidence
    }
    func perform(_ element: Int, action: String) throws {
        calls.append("perform:\(element):\(action)")
        performHook?(element, action)
        if let performFailure { throw performFailure }
    }
    func setValue(_ element: Int, value: JSON) throws {
        calls.append("set:\(element)")
        if let setFailure { throw setFailure }
        if !ignoreSet { values[element] = value }
    }
    func key(pid: Int32, key: String) throws { calls.append("key:\(pid):\(key)") }
    func coordinateReady(pid: Int32, target: Int, point: Point) throws -> Bool { coordinateAllowed }
    func screenContains(_ point: Point) -> Bool { Rect(x: 0, y: 0, width: 1920, height: 1080).contains(point) }
    func click(pid: Int32, at point: Point) throws { calls.append("click:\(pid)") }
    func drag(pid: Int32, from: Point, to: Point) throws { calls.append("drag:\(pid)") }
    func screenshot(pid: Int32) async throws -> Screenshot {
        calls.append("screenshot:\(pid)")
        return Screenshot(image: "data:image/png;base64,synthetic", width: 100, height: 80, windowId: 99)
    }
    func target(_ element: Int) throws -> JSON {
        let capture = try TreeReader(backend: self, budget: RequestBudget()).capture(pid: 42)
        guard let record = capture.records.first(where: { $0.element == element }) else { throw AXFailure.invalid("Test target missing") }
        return try JSON.encoded(record.node.target)
    }
}

func syntheticRequest(_ operation: String, _ args: [String: JSON] = [:]) throws -> Wire.Request {
    let json = JSON.object(["protocol": .number(1), "id": .string("synthetic"), "operation": .string(operation), "args": .object(args)])
    return try Wire.Request(data: JSONEncoder().encode(json))
}
