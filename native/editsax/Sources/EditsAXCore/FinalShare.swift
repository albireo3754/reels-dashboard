import CryptoKit
import Foundation

@MainActor public protocol FinalShareBackend: AccessibilityBackend {
    func finalShareWindow(pid: Int32) throws -> Element?
    func finalShareOwns(pid: Int32, element: Element) -> Bool
    func finalShareWindowIdentity(pid: Int32, window: Element) throws -> (id: UInt32, launch: Date)
    func finalShareScreenshot(pid: Int32, window: Element) async throws -> Screenshot
    func finalShareLink(_ element: Element) throws -> String?
    func finalShareOnConsole() -> Bool
}

@MainActor public struct FinalShare<B: FinalShareBackend> {
    private let backend: B
    public init(backend: B) { self.backend = backend }

    public func execute(_ request: Wire.Request, pollSeconds: Double = 45,
                        observation: (String) -> Bool?) async throws -> JSON {
        if request.operation == "final-share-recheck" {
            let args = try Arguments(request.args, allowed: ["lease", "windowKey"])
            return try recheck(lease: args.string("lease")!, windowKey: args.string("windowKey")!, observe: observation)
        }
        let confirm = request.operation == "final-share-confirm"
        let editCaption = request.operation == "final-share-caption"
        var allowed: Set<String> = ["lease"]
        if confirm || editCaption { allowed.formUnion(["fingerprint", "expiresAt"]) }
        if editCaption { allowed.insert("caption") }
        let args = try Arguments(request.args, allowed: allowed)
        let lease = try args.string("lease")!
        let approved = try args.string("fingerprint", required: confirm || editCaption)
        let caption = try editCaption ? captionArgument(args.values["caption"]) : nil
        let budget = RequestBudget(seconds: 8)
        let target: Target
        do {
            let preview = try await capture(lease, observation, budget: budget, editCaption: editCaption)
            target = preview.target
            if let approved, approved != preview.fingerprint {
                throw AXFailure("FINAL_SHARE_CHANGED", "The approved sharing preview changed")
            }
            try requireCurrentWindow(target, lease, observation, budget: budget)
            if confirm || editCaption {
                guard let expiresAt = args.values["expiresAt"]?.number, expiresAt.isFinite,
                      Date().timeIntervalSince1970 * 1000 < expiresAt else {
                    throw AXFailure("FINAL_SHARE_CHANGED", "The confirmation expired")
                }
            }
            if let caption {
                return try await applyCaption(caption, to: target, lease: lease, observation: observation, budget: budget)
            }
            if !confirm { return preview.json }
        } catch let failure as AXFailure where failure.code.hasPrefix("FINAL_SHARE_") {
            throw failure
        } catch let failure as AXFailure where ["AX_PERMISSION_REQUIRED", "SCREEN_CAPTURE_PERMISSION_REQUIRED"].contains(failure.code) {
            throw AXFailure("FINAL_SHARE_PERMISSION", "Accessibility and screen capture permissions are required")
        } catch {
            throw AXFailure("FINAL_SHARE_WINDOW", "The exact Edits sharing window could not be verified")
        }

        // All classified refusals are above this line. Even a lost response after AXPress is pending.
        do { try backend.perform(target.button, action: "AXPress") }
        catch { return pending }
        let verification = RequestBudget(seconds: pollSeconds)
        while !verification.expired {
            do {
                guard try requireSession(lease, observation, needsPreview: false) == target.pid,
                      let window = try backend.finalShareWindow(pid: target.pid), window == target.window,
                      try windowIdentity(pid: target.pid, window: window).key == target.windowKey else { return pending }
                if let url = try confirmation(pid: target.pid, window: window, budget: verification) {
                    return confirmed(url)
                }
                try await Task.sleep(for: .milliseconds(750))
            } catch { return pending }
        }
        return pending
    }

    private var pending: JSON { .object(["state": .string("pending")]) }

    private func confirmed(_ url: String) -> JSON {
        .object(["state": .string("confirmed"), "url": .string(url)])
    }

    private func recheck(lease: String, windowKey: String, observe: (String) -> Bool?) throws -> JSON {
        do {
            let pid = try requireSession(lease, observe, needsPreview: false)
            guard let window = try backend.finalShareWindow(pid: pid),
                  try windowIdentity(pid: pid, window: window).key == windowKey,
                  let url = try confirmation(pid: pid, window: window, budget: RequestBudget(seconds: 8)),
                  try windowIdentity(pid: pid, window: window).key == windowKey,
                  try requireSession(lease, observe, needsPreview: false) == pid else { return pending }
            return confirmed(url)
        } catch let error as AXFailure where ["FINAL_SHARE_LOCKED", "FINAL_SHARE_SESSION_UNKNOWN"].contains(error.code) {
            throw error
        } catch {
            return pending
        }
    }

    private struct Target {
        let pid: Int32
        let window, button, captionField: B.Element
        let windowID: UInt32
        let windowKey, seal, account, caption: String
        let canSetCaption: Bool

        func matches(_ other: Target) -> Bool {
            pid == other.pid && window == other.window && windowKey == other.windowKey &&
                button == other.button && captionField == other.captionField && account == other.account
        }
    }

    private struct Preview {
        let target: Target
        let screenshot: Screenshot
        let fingerprint: String

        var json: JSON {
            .object(["fingerprint": .string(fingerprint), "windowKey": .string(target.windowKey),
                     "image": .string(screenshot.image), "account": .string(target.account),
                     "caption": .string(target.caption)])
        }
    }

    private func capture(_ lease: String, _ observation: (String) -> Bool?, budget: RequestBudget,
                         editCaption: Bool, initial: Target? = nil) async throws -> Preview {
        let before = try initial ?? inspect(lease, observation, budget: budget, editCaption: editCaption)
        let screenshot = try await backend.finalShareScreenshot(pid: before.pid, window: before.window)
        let target = try inspect(lease, observation, budget: budget, editCaption: editCaption)
        guard before.matches(target), before.seal == target.seal, screenshot.windowId == target.windowID else {
            throw AXFailure("FINAL_SHARE_CHANGED", "The sharing window changed during capture")
        }
        let fingerprint = try digest(JSONEncoder().encode([target.windowKey, target.seal, screenshot.image]))
        return Preview(target: target, screenshot: screenshot, fingerprint: fingerprint)
    }

    private func requireCurrentWindow(_ target: Target, _ lease: String, _ observation: (String) -> Bool?,
                                      budget: RequestBudget) throws {
        try budget.check()
        guard try windowIdentity(pid: target.pid, window: target.window).key == target.windowKey,
              try requireSession(lease, observation) == target.pid else {
            throw AXFailure("FINAL_SHARE_CHANGED", "Edits process changed")
        }
    }

    private func captionArgument(_ value: JSON?) throws -> String {
        guard let caption = value?.string, caption.count <= 2200,
              !caption.utf8.contains(0) else {
            throw captionFailure("Caption must contain at most 2200 characters and no NUL")
        }
        return caption
    }

    private func applyCaption(_ caption: String, to target: Target, lease: String, observation: (String) -> Bool?,
                              budget: RequestBudget) async throws -> JSON {
        guard target.canSetCaption else { throw captionFailure("The caption field cannot be edited") }
        do { try backend.setValue(target.captionField, value: .string(caption)) }
        catch let failure as AXFailure where failure.code == "AX_PERMISSION_REQUIRED" { throw failure }
        catch { throw captionFailure("The caption could not be set") }

        let readback = RequestBudget(seconds: 0.4)
        while true {
            let current = try inspect(lease, observation, budget: budget, editCaption: true)
            guard target.matches(current) else {
                throw AXFailure("FINAL_SHARE_CHANGED", "The sharing window, caption field or account changed")
            }
            // String equality accepts canonically equivalent text. The input must survive verbatim.
            if current.caption.utf8.elementsEqual(caption.utf8) {
                let preview = try await capture(lease, observation, budget: budget, editCaption: true, initial: current)
                try requireCurrentWindow(preview.target, lease, observation, budget: budget)
                return preview.json
            }
            guard !readback.expired else { throw captionFailure("Edits did not return the exact caption") }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    private func captionValue(_ field: B.Element) throws -> JSON {
        do { return try backend.value(field) }
        catch let failure as AXFailure where failure.code == "AX_PERMISSION_REQUIRED" { throw failure }
        catch { throw captionFailure("The caption field could not be read") }
    }

    private func captionFailure(_ message: String) -> AXFailure {
        AXFailure("FINAL_SHARE_CAPTION", message)
    }

    private func requireSession(_ lease: String, _ observe: (String) -> Bool?, needsPreview: Bool = true) throws -> Int32 {
        let status = try backend.status()
        guard status.screenLocked != .locked else { throw AXFailure("FINAL_SHARE_LOCKED", "Screen is locked") }
        guard backend.finalShareOnConsole(), let observedUnlock = observe(lease),
              status.screenLocked == .unlocked || observedUnlock else {
            throw AXFailure("FINAL_SHARE_SESSION_UNKNOWN", "An active and unlocked console session could not be confirmed")
        }
        guard status.trusted && (!needsPreview || status.screenCaptureAllowed) else {
            throw AXFailure("FINAL_SHARE_PERMISSION", "Accessibility and screen capture permissions are required")
        }
        guard status.installed, let pid = status.pid else {
            throw AXFailure("FINAL_SHARE_WINDOW", "The installed Edits app is not running")
        }
        return pid
    }

    private func windowIdentity(pid: Int32, window: B.Element) throws -> (id: UInt32, key: String) {
        let identity = try backend.finalShareWindowIdentity(pid: pid, window: window)
        let key = digest(try JSONEncoder().encode([String(pid), String(identity.id),
                                                 String(identity.launch.timeIntervalSinceReferenceDate)]))
        return (identity.id, key)
    }

    private func inspect(_ lease: String, _ observation: (String) -> Bool?, budget: RequestBudget,
                         editCaption: Bool) throws -> Target {
        let pid = try requireSession(lease, observation)
        guard let window = try backend.finalShareWindow(pid: pid) else { throw missingWindow() }
        let identity = try windowIdentity(pid: pid, window: window)
        let nodes = try tree(window, pid: pid, budget: budget, editCaption: editCaption)
        guard let root = nodes.first, root.attributes.role == "AXWindow",
              root.attributes.subrole != "AXSystemDialog",
              (root.attributes.title.isEmpty ? root.attributes.description : root.attributes.title) == "Share to Instagram",
              !nodes.dropFirst().contains(where: {
                  $0.attributes.role == "AXWindow" || SafetyPolicy.dialog($0.attributes)
              }) else { throw missingWindow() }
        let buttons = nodes.filter { node in
            let a = node.attributes
            let labels = [a.title, a.description].filter { !$0.isEmpty }
            return a.role == "AXButton" && labels.contains("Share")
        }
        let accounts = nodes.filter { $0.attributes.role == "AXStaticText" }
            .flatMap(\.labels).compactMap { accountName($0) }
        let captions = nodes.filter { isCaptionRole($0.attributes.role) }
        // The separate final window contains a single caption field and a visible account label.
        guard buttons.count == 1, let button = buttons.first, button.leaf, button.attributes.enabled,
              [button.attributes.title, button.attributes.description].filter({ !$0.isEmpty }).allSatisfy({ $0 == "Share" }),
              button.attributes.actions.contains(where: { $0.name == "AXPress" }),
              let buttonFrame = button.attributes.frame, buttonFrame.valid,
              root.attributes.frame?.contains(buttonFrame.center) == true,
              Set(accounts).count == 1, let account = accounts.first,
              captions.count == 1, let field = captions.first else { throw missingWindow() }
        guard let caption = field.value.string else {
            throw editCaption ? captionFailure("The caption value is unavailable") : missingWindow()
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let state = nodes.map { node -> JSON in
            let a = node.attributes
            return .array([.string(a.role), .string(a.subrole), .string(a.identifier), .string(a.title),
                           .string(a.description), .string(a.placeholder), .bool(a.enabled), .bool(a.selected),
                           node.value, .number(Double(node.depth)), .bool(node.leaf)])
        }
        return Target(pid: pid, window: window, button: button.element, captionField: field.element,
                      windowID: identity.id, windowKey: identity.key, seal: digest(try encoder.encode(state)),
                      account: "@\(account)", caption: caption, canSetCaption: field.attributes.enabled && field.attributes.settable)
    }

    private func isCaptionRole(_ role: String) -> Bool { role == "AXTextArea" || role == "AXTextField" }

    private func accountName(_ label: String) -> String? {
        let pattern = #"\A(?:[0-9]{1,4}/2200 )?Sharing as @?[A-Za-z0-9._]{1,30}\z"#
        guard label.range(of: pattern, options: .regularExpression) != nil else { return nil }
        if let count = label.split(separator: "/").first.flatMap({ Int($0) }), count > 2200 { return nil }
        return label.split(separator: " ").last?.trimmingCharacters(in: CharacterSet(charactersIn: "@")).lowercased()
    }

    private struct Entry {
        let element: B.Element
        let attributes: Attributes
        let value: JSON
        let depth: Int
        let leaf: Bool
        var labels: [String] { [attributes.title, attributes.description, value.string ?? ""].filter { !$0.isEmpty } }
    }

    private func tree(_ root: B.Element, pid: Int32, budget: RequestBudget, editCaption: Bool = false) throws -> [Entry] {
        var seen = Set<B.Element>()
        var entries = [Entry]()
        var fieldBytes = 0
        func visit(_ element: B.Element, depth: Int) throws {
            try budget.check()
            guard entries.count < 160, depth <= 12, seen.insert(element).inserted,
                  backend.finalShareOwns(pid: pid, element: element) else { throw missingWindow() }
            let a = try backend.attributes(element)
            guard !SafetyPolicy.sensitive([a]) else { throw missingWindow() }
            let branch = try backend.children(element, limit: 160 - entries.count)
            guard !branch.truncated else { throw missingWindow() }
            let field = isCaptionRole(a.role)
            let value = try editCaption && field ? captionValue(element) : backend.value(element)
            if let text = value.string {
                if field {
                    // A grapheme can contain multiple scalars. Bound caption reads by the wire cap.
                    fieldBytes += text.utf8.count
                    guard fieldBytes <= Wire.maxInputBytes else { throw missingWindow() }
                } else if text.utf8.count > 16_384 { throw missingWindow() }
            }
            entries.append(Entry(element: element, attributes: a, value: value, depth: depth, leaf: branch.elements.isEmpty))
            for child in branch.elements { try visit(child, depth: depth + 1) }
        }
        try visit(root, depth: 0)
        return entries
    }

    private func confirmation(pid: Int32, window: B.Element, budget: RequestBudget) throws -> String? {
        let nodes = try tree(window, pid: pid, budget: budget)
        guard nodes.first?.attributes.role == "AXWindow",
              nodes.contains(where: { $0.attributes.role == "AXStaticText" && $0.labels.contains("Shared successfully.") }),
              !nodes.contains(where: { $0.attributes.role == "AXButton" && $0.labels.contains("Share") }) else { return nil }
        var urls = Set<String>()
        for node in nodes where ["AXLink", "AXStaticText"].contains(node.attributes.role) &&
            node.labels.contains(where: { $0 == "View on Instagram" || $0.hasPrefix("View on Instagram: ") }) {
            var links = node.labels.filter { $0.hasPrefix("View on Instagram: ") }.map { String($0.dropFirst("View on Instagram: ".count)) }
            if node.attributes.role == "AXLink", let url = try backend.finalShareLink(node.element) { links.append(url) }
            for link in links {
                let candidate = link.hasPrefix("instagram.com/") ? "https://\(link)" : link
                if let components = URLComponents(string: candidate), components.scheme == "https",
                   ["instagram.com", "www.instagram.com"].contains(components.host ?? ""),
                   components.user == nil, components.password == nil, components.port == nil, components.query == nil, components.fragment == nil,
                   components.percentEncodedPath.range(of: #"^/(p|reel)/[A-Za-z0-9_-]+/?$"#, options: .regularExpression) != nil {
                    let suffix = components.path.hasSuffix("/") ? "" : "/"
                    urls.insert("https://www.instagram.com\(components.path)\(suffix)")
                }
            }
        }
        return urls.count == 1 ? urls.first : nil
    }

    private func missingWindow() -> AXFailure {
        AXFailure("FINAL_SHARE_WINDOW", "Open the exact Share to Instagram window with its account, caption and final Share button")
    }
    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
