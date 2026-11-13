import AppKit
import ApplicationServices
import CoreFoundation
import EditsAXCore
// ScreenCaptureKit's ObjC completion results lack Sendable annotations in the macOS 15 SDK.
// They are consumed only on this backend's main actor and are never shared with another task.
@preconcurrency import ScreenCaptureKit

public struct MacElement: Hashable {
    let ax: AXUIElement
    public static func == (lhs: MacElement, rhs: MacElement) -> Bool { CFEqual(lhs.ax, rhs.ax) }
    public func hash(into hasher: inout Hasher) { hasher.combine(CFHash(ax)) }
}

@MainActor public final class MacBackend: AccessibilityBackend {
    public typealias Element = MacElement
    private let system = AXUIElementCreateSystemWide()

    public init() {
        // Global to this short-lived helper only. Each request also has an absolute budget.
        AXUIElementSetMessagingTimeout(system, 0.35)
    }

    public func status() throws -> AppStatus { try MacStatus.read() }

    public func root(pid: Int32, kind: TargetRoot) throws -> MacElement? {
        let app = MacElement(ax: AXUIElementCreateApplication(pid))
        if kind == .application { return app }
        return element(try copy(app, kAXMenuBarAttribute))
    }

    public func attributes(_ element: MacElement) throws -> Attributes {
        var a = Attributes()
        a.role = try text(element, kAXRoleAttribute)
        guard !a.role.isEmpty else {
            throw AXFailure("AX_TARGET_NOT_FOUND", "Element role is unavailable",
                            details: ["axAPI": .string("AXUIElementCopyAttributeValue"), "axAttribute": .string(kAXRoleAttribute)])
        }
        let subrole = try SubroleReadPolicy.read(role: a.role,
            value: { try text(element, kAXSubroleAttribute) },
            isAdvertised: { try advertisesSubrole(element) })
        a.subrole = subrole.value
        a.subroleConfirmedAbsentAfterFailure = subrole.confirmedAbsentAfterFailure
        a.title = try text(element, kAXTitleAttribute)
        a.description = try text(element, kAXDescriptionAttribute)
        a.identifier = try text(element, kAXIdentifierAttribute)
        a.help = try text(element, kAXHelpAttribute)
        a.placeholder = try text(element, kAXPlaceholderValueAttribute)
        a.enabled = try copy(element, kAXEnabledAttribute) as? Bool ?? false
        a.selected = try copy(element, kAXSelectedAttribute) as? Bool ?? false
        a.focused = try copy(element, kAXFocusedAttribute) as? Bool ?? false
        var settable = DarwinBoolean(false)
        let settableError = AXUIElementIsAttributeSettable(element.ax, kAXValueAttribute as CFString, &settable)
        if settableError == .success { a.settable = settable.boolValue }
        else if !optional(settableError) { throw readFailure(settableError, api: "AXUIElementIsAttributeSettable", attribute: kAXValueAttribute) }
        var names: CFArray?
        let actionError = AXUIElementCopyActionNames(element.ax, &names)
        if actionError == .success {
            a.actions = (names as? [String] ?? []).prefix(16).map { name in
                var description: CFString?
                AXUIElementCopyActionDescription(element.ax, name as CFString, &description)
                return Action(name, description: description as String? ?? "")
            }
        } else if !optional(actionError) { throw readFailure(actionError, api: "AXUIElementCopyActionNames") }
        a.frame = try frame(element)
        return a
    }

    public func value(_ element: MacElement) throws -> JSON {
        guard let raw = try copy(element, kAXValueAttribute) else { return .null }
        if CFGetTypeID(raw) == CFBooleanGetTypeID(), let b = raw as? Bool { return .bool(b) }
        if let n = raw as? NSNumber {
            return n.doubleValue.isFinite ? .number(n.doubleValue) : .null
        }
        if let s = raw as? String { return .string(s) }
        return .null
    }

    public func children(_ element: MacElement, limit: Int) throws -> (elements: [MacElement], truncated: Bool) {
        var count: CFIndex = 0
        let countError = AXUIElementGetAttributeValueCount(element.ax, kAXChildrenAttribute as CFString, &count)
        if optional(countError) { return ([], false) }
        guard countError == .success else { throw readFailure(countError, api: "AXUIElementGetAttributeValueCount", attribute: kAXChildrenAttribute) }
        let bounded = min(max(limit, 0), count)
        guard bounded > 0 else { return ([], count > 0) }
        var array: CFArray?
        let error = AXUIElementCopyAttributeValues(element.ax, kAXChildrenAttribute as CFString, 0, bounded, &array)
        guard error == .success, let array else { throw readFailure(error, api: "AXUIElementCopyAttributeValues", attribute: kAXChildrenAttribute) }
        // AXChildren must contain AXUIElements; reject malformed arrays rather than shifting indices.
        let raw = array as [AnyObject]
        guard raw.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else {
            throw AXFailure("AX_TARGET_NOT_FOUND", "Malformed AXChildren",
                            details: ["axAPI": .string("AXUIElementCopyAttributeValues"), "axAttribute": .string(kAXChildrenAttribute)])
        }
        return (raw.map { MacElement(ax: $0 as! AXUIElement) }, count > bounded)
    }

    public func focusedElement(pid: Int32) throws -> MacElement? {
        let app = MacElement(ax: AXUIElementCreateApplication(pid))
        return element(try copy(app, kAXFocusedUIElementAttribute))
    }

    public func identityEvidence(_ current: MacElement, first: MacElement, pid: Int32) -> ElementIdentityProbe {
        var evidence = ElementIdentityProbe()
        evidence.sameReference = current.ax === first.ax
        evidence.currentEqualsFirst = CFEqual(current.ax, first.ax)
        do {
            evidence.currentRole = try text(current, kAXRoleAttribute)
            evidence.firstRoleNow = try text(first, kAXRoleAttribute)
            func owner(_ element: MacElement) throws -> Int32 {
                var processId: pid_t = 0
                let error = AXUIElementGetPid(element.ax, &processId)
                guard error == .success else { throw readFailure(error, api: "AXUIElementGetPid") }
                return processId
            }
            evidence.currentPid = try owner(current); evidence.firstPid = try owner(first)
            let fresh = MacElement(ax: AXUIElementCreateApplication(pid))
            evidence.freshApplicationRole = try text(fresh, kAXRoleAttribute)
            let child = try children(fresh, limit: 1).elements.first
            evidence.freshChildPresent = child != nil
            if let child {
                evidence.freshFirstChildRole = try text(child, kAXRoleAttribute)
                evidence.freshChildEqualsApplication = CFEqual(child.ax, fresh.ax)
                evidence.freshChildEqualsCurrent = CFEqual(child.ax, current.ax)
            }
        } catch let failure as AXFailure {
            evidence.probeErrorCode = failure.code
            evidence.probeAXErrorCode = failure.details["axErrorCode"]?.number.map(Int.init)
            evidence.probeAXAPI = failure.details["axAPI"]?.string
            evidence.probeAXAttribute = failure.details["axAttribute"]?.string
        } catch { evidence.probeErrorCode = "AX_ACTION_FAILED" }
        return evidence
    }

    public func perform(_ element: MacElement, action: String) throws {
        let error = AXUIElementPerformAction(element.ax, action as CFString)
        guard error != .success else { return }
        if error == .apiDisabled { throw AXFailure("AX_PERMISSION_REQUIRED", "Accessibility permission is required") }
        if error == .notImplemented || error == .actionUnsupported {
            throw DispatchFailure.notDispatched("AX action was not dispatched (\(error.rawValue))")
        }
        throw DispatchFailure.uncertain("AX action outcome is unknown (\(error.rawValue))")
    }

    public func setValue(_ element: MacElement, value: JSON) throws {
        let raw: CFTypeRef
        switch value {
        case .string(let s): raw = s as CFString
        case .number(let n): raw = NSNumber(value: n)
        case .bool(let b): raw = b ? kCFBooleanTrue : kCFBooleanFalse
        default: throw AXFailure.invalid("Expected a scalar AXValue")
        }
        let error = AXUIElementSetAttributeValue(element.ax, kAXValueAttribute as CFString, raw)
        guard error != .success else { return }
        if error == .apiDisabled { throw AXFailure("AX_PERMISSION_REQUIRED", "Accessibility permission is required") }
        if error == .attributeUnsupported || error == .notImplemented || error == .illegalArgument {
            throw DispatchFailure.notDispatched("AXValue was not set (\(error.rawValue))")
        }
        throw DispatchFailure.uncertain("AXValue outcome is unknown (\(error.rawValue))")
    }

    public func key(pid: Int32, key: String) throws {
        let code: CGKeyCode
        let flags: CGEventFlags
        switch key {
        case "escape": code = 53; flags = []
        case "return": code = 36; flags = []
        case "tab": code = 48; flags = []
        case "select-all": code = 0; flags = .maskCommand
        case "go-to-folder": code = 5; flags = [.maskCommand, .maskShift]
        default: throw AXFailure.invalid("Unknown auxiliary key")
        }
        let source = CGEventSource(stateID: .privateState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
            throw DispatchFailure.notDispatched("Unable to create key events")
        }
        down.flags = flags; up.flags = flags
        down.postToPid(pid); up.postToPid(pid)
    }

    public func screenContains(_ point: Point) -> Bool {
        guard point.x.isFinite, point.y.isFinite else { return false }
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count <= 64 else { return false }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return false }
        return displays.prefix(Int(count)).contains { CGDisplayBounds($0).contains(CGPoint(x: point.x, y: point.y)) }
    }

    public func coordinateReady(pid: Int32, target: MacElement, point: Point) throws -> Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, screenContains(point) else { return false }
        var hit: AXUIElement?
        let error = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit)
        guard error == .success, let hit else { return false }
        // A descendant can have a different action (for example Share); only the exact leaf is safe.
        return CFEqual(target.ax, hit)
    }

    public func click(pid: Int32, at point: Point) throws {
        let source = CGEventSource(stateID: .privateState)
        let location = CGPoint(x: point.x, y: point.y)
        guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: location, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: location, mouseButton: .left) else {
            throw DispatchFailure.notDispatched("Unable to create click events")
        }
        down.flags = []; up.flags = []
        down.postToPid(pid); up.postToPid(pid)
    }

    public func drag(pid: Int32, from: Point, to: Point) throws {
        let source = CGEventSource(stateID: .privateState)
        let events: [CGEvent] = try (0...20).map { index in
            let fraction = Double(index) / 20
            let p = CGPoint(x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction)
            let type: CGEventType = index == 0 ? .leftMouseDown : index == 20 ? .leftMouseUp : .leftMouseDragged
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else {
                throw DispatchFailure.notDispatched("Unable to create drag events")
            }
            event.flags = []
            return event
        }
        for event in events { event.postToPid(pid); Thread.sleep(forTimeInterval: 0.01) }
    }

    public func screenshot(pid: Int32) async throws -> Screenshot {
        guard CGPreflightScreenCaptureAccess() else {
            throw AXFailure("SCREEN_CAPTURE_PERMISSION_REQUIRED", "Screen capture permission is required")
        }
        let app = MacElement(ax: AXUIElementCreateApplication(pid))
        let focusedWindow = try element(copy(app, kAXFocusedWindowAttribute))
        let mainWindow = try focusedWindow ?? element(copy(app, kAXMainWindowAttribute))
        guard let focusedWindow = mainWindow,
              let axFrame = try frame(focusedWindow) else { throw AXFailure("AX_TARGET_NOT_FOUND", "Exact Edits window is unavailable") }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let windows = content.windows.filter { window in
                window.owningApplication?.processID == pid && window.owningApplication?.bundleIdentifier == EditsApp.bundleId &&
                window.windowLayer == 0 && window.isOnScreen &&
                abs(window.frame.minX - axFrame.x) < 2 && abs(window.frame.minY - axFrame.y) < 2 &&
                abs(window.frame.width - axFrame.width) < 2 && abs(window.frame.height - axFrame.height) < 2
            }
            guard windows.count == 1, let window = windows.first else {
                throw AXFailure("AX_TARGET_NOT_FOUND", "Edits window is missing or ambiguous in screen capture")
            }
            let current = try status()
            guard current.pid == pid else { throw AXFailure("AX_STALE_TARGET", "Edits process changed before capture") }
            guard current.screenCaptureAllowed else {
                throw AXFailure("SCREEN_CAPTURE_PERMISSION_REQUIRED", "Screen capture permission is required")
            }
            let config = SCStreamConfiguration()
            let scale = min(1, 1280 / max(window.frame.width, window.frame.height))
            config.width = max(1, Int(floor(window.frame.width * scale)))
            config.height = max(1, Int(floor(window.frame.height * scale)))
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            guard image.width <= 1280, image.height <= 1280,
                  let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
                throw AXFailure("AX_ACTION_FAILED", "Unable to encode the bounded window PNG")
            }
            return Screenshot(image: "data:image/png;base64," + png.base64EncodedString(), width: image.width, height: image.height, windowId: window.windowID)
        } catch let failure as AXFailure { throw failure }
        catch { throw AXFailure("AX_ACTION_FAILED", "Window capture failed; no capture or permission request was retried") }
    }

    private func optional(_ error: AXError) -> Bool { [.attributeUnsupported, .noValue, .notImplemented].contains(error) }
    private func advertisesSubrole(_ element: MacElement) throws -> Bool {
        var names: CFArray?
        let error = AXUIElementCopyAttributeNames(element.ax, &names)
        guard error == .success, let names = names as? [String] else {
            throw readFailure(error, api: "AXUIElementCopyAttributeNames")
        }
        return names.contains(kAXSubroleAttribute)
    }
    private func copy(_ element: MacElement, _ attribute: String) throws -> CFTypeRef? {
        var raw: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element.ax, attribute as CFString, &raw)
        if error == .success { return raw }
        if optional(error) { return nil }
        throw readFailure(error, api: "AXUIElementCopyAttributeValue", attribute: attribute)
    }
    private func text(_ element: MacElement, _ attribute: String) throws -> String { try copy(element, attribute) as? String ?? "" }
    private func element(_ raw: CFTypeRef?) -> MacElement? {
        guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return MacElement(ax: raw as! AXUIElement)
    }
    private func frame(_ element: MacElement) throws -> Rect? {
        guard let p = try copy(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = try copy(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        let frame = Rect(x: point.x, y: point.y, width: size.width, height: size.height)
        return frame.valid ? frame : nil
    }
    private func readFailure(_ error: AXError, api: String, attribute: String? = nil) -> AXFailure {
        var details: [String: JSON] = ["axErrorCode": .number(Double(error.rawValue)), "axAPI": .string(api)]
        if let attribute { details["axAttribute"] = .string(attribute) }
        if error == .apiDisabled { return AXFailure("AX_PERMISSION_REQUIRED", "Accessibility permission is required", details: details) }
        if error == .invalidUIElement { return AXFailure("AX_TARGET_NOT_FOUND", "AX element is unavailable", details: details) }
        return AXFailure("AX_ACTION_FAILED", "AX read failed (\(error.rawValue))", details: details)
    }
}
