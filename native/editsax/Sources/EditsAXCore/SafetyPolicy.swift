import Foundation

struct PolicyContext {
    let target: Target
    let chain: [Attributes]
    let evidence: [Attributes]
    let windowEvidence: [Attributes]
    let localEvidence: [Attributes]
    let leaf: Bool
    let blockingDialog: Bool
    let unrelatedDialog: Bool
    var a: Attributes { chain.last! }
    var editor: Bool { chain.contains { $0.role == "AXWindow" && $0.identifier == "editor" } }
    var home: Bool { chain.contains { $0.role == "AXWindow" && $0.identifier == "home" } }
    var timeline: Bool {
        chain.dropLast().contains {
            $0.identifier == "editor.timeline" || $0.identifier.hasPrefix("editor.timeline.") || $0.labels.contains("Timeline")
        }
    }
    func panel(_ name: String) -> Bool {
        chain.dropLast().contains {
            ["AXGroup", "AXScrollArea", "AXTabGroup", "AXSplitGroup"].contains($0.role) &&
            ($0.labels.contains(name) || $0.identifier == "editor.panel.\(name.lowercased())" ||
             $0.identifier == "editor.inspector.\(name.lowercased())")
        }
    }
    var importDialog: Bool {
        let dialogs = chain.filter(SafetyPolicy.dialog)
        func filePanel(_ a: Attributes) -> Bool {
            a.labels.contains("Import Media") || a.labels.contains("Open") || a.labels.contains("Import") || a.subrole == "AXOpenDialog"
        }
        return dialogs.contains(where: filePanel) && dialogs.allSatisfy {
            filePanel($0) || $0.labels.contains("Go to Folder") || $0.labels.contains("Go to the folder:") || $0.identifier == "GoToFolder"
        } && windowEvidence.contains { ["AXBrowser", "AXOutline"].contains($0.role) }
    }
    var importPathInput: Bool {
        importDialog && ["AXTextField", "AXComboBox"].contains(a.role) && chain.contains {
            $0.labels.contains("Go to Folder") || $0.labels.contains("Go to the folder:") || $0.identifier == "GoToFolder"
        }
    }
    var importBrowserFocus: Bool {
        importDialog && (["AXBrowser", "AXOutline"].contains(a.role) ||
            (["AXRow", "AXCell"].contains(a.role) && chain.dropLast().contains { ["AXBrowser", "AXOutline"].contains($0.role) }))
    }
    var importPanelFocus: Bool {
        importDialog && ["AXWindow", "AXSheet", "AXDialog"].contains(a.role)
    }
    var durationDialog: Bool {
        chain.contains { SafetyPolicy.dialog($0) && ($0.labels.contains("Clip duration") || $0.labels.contains("Duration")) }
    }
    var timecodeInput: Bool {
        editor && ["AXTextField", "AXTextArea"].contains(a.role) &&
        chain.contains { $0.identifier == "editor.timecode" }
    }
}

public enum SafetyPolicy {
    /// Observed Audio list marker: title, artist (possibly multiple), middle-dot duration.
    /// Plain labels, save/settings controls and malformed durations do not prove a song result.
    static func songResultLabel(_ label: String) -> Bool {
        guard label.utf8.count <= 4096 else { return false }
        guard label.range(of: "^[^,\\n]+,\\s*[^\\n]+,\\s*·\\s*[0-9]{1,3}:[0-5][0-9]$", options: .regularExpression) != nil else { return false }
        let fields = label.components(separatedBy: ",")
        return fields.count >= 3 && fields.dropLast().allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private static func songButton(_ a: Attributes) -> Bool {
        let labels = [a.title, a.description].filter { !$0.isEmpty }
        return !labels.isEmpty && Set(labels).count == 1 && labels.allSatisfy(songResultLabel)
    }
    private static func normalized(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .replacingOccurrences(of: "[_-]", with: " ", options: .regularExpression)
    }

    public static func sensitive(_ chain: [Attributes]) -> Bool {
        chain.contains {
            let text = normalized($0.contextText)
            return text.range(of: "secure|password|passphrase|login|log in|sign in|signin|username|e[ -]?mail|비밀번호|암호|로그인", options: .regularExpression) != nil
        }
    }

    static func dialog(_ a: Attributes) -> Bool {
        ["AXSheet", "AXDialog", "AXAlert"].contains(a.role) ||
        ["AXDialog", "AXSystemDialog", "AXOpenDialog", "AXAlert"].contains(a.subrole)
    }

    static func forbidden(_ chain: [Attributes]) -> Bool {
        chain.contains {
            let text = normalized($0.contextText)
            return sensitive([$0]) || text.range(of:
                "\\b(publish|post|share|delete|remove account|permission|authorize|grant access|allow access)\\b|instagram|게시|공유|계정.*삭제|사진.*(삭제|이동)|권한|접근.*허용",
                options: .regularExpression) != nil
        }
    }

    static func requireSafe(_ context: PolicyContext, permitsDialog: Bool = false) throws {
        guard !forbidden(context.chain), context.a.enabled,
              !context.chain.contains(where: { $0.role == "AXAlert" || $0.subrole == "AXAlert" || $0.subrole == "AXSystemDialog" }),
              !context.unrelatedDialog,
              permitsDialog || (!context.blockingDialog && !context.chain.contains(where: dialog)) else {
            throw denied("Target or active dialog is forbidden or unclassified")
        }
    }

    static func press(_ intent: String, action: String, context c: PolicyContext) throws {
        try requireSafe(c, permitsDialog: ["import-confirm", "duration-confirm"].contains(intent))
        guard c.target.root == .application, c.a.role == "AXButton" else { throw denied("Press requires an allowed application button") }
        let isTimecode = c.editor && c.a.identifier == "editor.timecode" &&
            action != "AXDelete" &&
            c.a.actions.contains { $0.name == action && ($0.name == "Edit timecode" || $0.description == "Edit timecode") }
        guard action == "AXPress" || isTimecode else { throw denied("Action is outside the press allowlist") }
        var allowed = false
        switch intent {
        case "editor-control":
            let identifiers = ["editor.tool.toolMode.select", "editor.tool.toolMode.trim", "editor.tool.trimStart", "editor.tool.trimEnd"]
            allowed = c.editor && (
                identifiers.contains(c.a.identifier) ||
                (c.a.identifier == "editor.export" && c.leaf && action == "AXPress") || isTimecode ||
                (c.a.labels.contains { ["Media", "Audio", "Text"].contains($0) && c.panel($0) } && action == "AXPress") ||
                (c.panel("Text") && c.a.labels.contains { ["Text Styles", "None", "Add to timeline"].contains($0) }) ||
                (c.panel("Media") && c.a.labels.contains("Add to timeline")) ||
                (c.panel("Sound") && c.a.labels.contains("Volume"))
            )
        case "timeline-select":
            allowed = action == "AXPress" && (
                (c.editor && c.timeline && UUID(uuidString: c.a.identifier) != nil) ||
                (c.home && c.a.identifier.hasPrefix("home.project.") && UUID(uuidString: String(c.a.identifier.dropFirst("home.project.".count))) != nil)
            )
        case "library-result":
            let list = c.chain.dropLast().contains { ["AXList", "AXTable", "AXOutline"].contains($0.role) }
            let preview = c.chain.dropLast().contains {
                $0.labels.contains("Audio preview") || $0.labels.contains("Track preview") || $0.identifier == "audio.preview"
            }
            allowed = c.editor && c.panel("Audio") && action == "AXPress" &&
                ((list && c.leaf && songButton(c.a)) ||
                 (preview && c.a.labels.contains { ["add thin", "Trim"].contains($0) } &&
                  c.localEvidence.contains { ($0.role == "AXStaticText" || $0.role == "AXButton") && songButton($0) }))
        case "import-confirm": allowed = c.importDialog && action == "AXPress" && c.a.labels.contains { ["Import", "Open"].contains($0) }
        case "duration-confirm": allowed = c.durationDialog && action == "AXPress" && c.a.labels.contains { ["Set", "Cancel"].contains($0) }
        default: throw AXFailure.invalid("Unknown press intent")
        }
        guard allowed else { throw denied("Actual target and ancestors do not prove the requested press intent") }
    }

    static func value(_ intent: String, context c: PolicyContext) throws {
        try requireSafe(c, permitsDialog: ["import-path", "duration"].contains(intent))
        guard c.target.root == .application else { throw denied("Value target must be in application root") }
        let field = ["AXTextField", "AXTextArea", "AXComboBox"].contains(c.a.role)
        var allowed = false
        switch intent {
        case "timecode": allowed = c.timecodeInput
        case "audio-search": allowed = c.editor && c.panel("Audio") && field && c.a.labels.contains("Search audio")
        case "clip-volume":
            allowed = c.editor && c.panel("Sound") && c.a.role == "AXSlider" &&
                c.a.labels.contains { ["Volume value", "Volume slider"].contains($0) } &&
                c.evidence.contains { $0.labels.contains("Clip volume") } &&
                c.evidence.contains { $0.selected && UUID(uuidString: $0.identifier) != nil }
        case "text-content": allowed = c.editor && c.panel("Text") && c.a.role == "AXTextArea" &&
            !c.a.labels.contains { $0.hasPrefix("Search") } && !c.a.contextText.contains("Search tools")
        case "import-path": allowed = c.importPathInput
        case "duration": allowed = c.durationDialog && field && c.a.labels.contains { ["Duration", "Clip duration"].contains($0) }
        default: throw AXFailure.invalid("Unknown value intent")
        }
        guard allowed else { throw denied("Actual field and ancestors do not prove the requested value intent") }
    }

    static func key(_ key: String, context: String, target c: PolicyContext, focus f: PolicyContext) throws {
        try requireSafe(c, permitsDialog: ["import-dialog", "duration-dialog", "menu"].contains(context))
        try requireSafe(f, permitsDialog: ["import-dialog", "duration-dialog", "menu"].contains(context))
        // The actual focus must be the concrete target or its descendant in the same root.
        guard c.target.root == f.target.root, f.target.path.starts(with: c.target.path) else {
            throw denied("Actual focus is outside the concrete key target")
        }
        let allowed: Bool
        switch context {
        case "timecode": allowed = c.timecodeInput && f.timecodeInput && ["return", "tab", "select-all"].contains(key)
        case "import-dialog":
            let classifiedFocus = f.importPathInput || f.importBrowserFocus || f.importPanelFocus
            let permitted: Bool
            switch key {
            case "return": permitted = f.importPathInput || (f.importBrowserFocus && ["AXRow", "AXCell"].contains(f.a.role) && f.a.selected)
            case "select-all": permitted = f.importPathInput
            case "go-to-folder": permitted = f.importBrowserFocus || f.importPanelFocus || f.importPathInput
            case "escape": permitted = classifiedFocus
            default: permitted = false
            }
            allowed = c.importDialog && f.importDialog && classifiedFocus && permitted
        case "duration-dialog": allowed = c.durationDialog && f.durationDialog &&
            (key == "escape" || (["tab", "return", "select-all"].contains(key) && ["AXTextField", "AXComboBox"].contains(f.a.role) &&
                                f.a.labels.contains { ["Duration", "Clip duration"].contains($0) }))
        case "menu": allowed = key == "escape" && c.target.root == .menuBar &&
            c.chain.contains { $0.role == "AXMenu" } && f.chain.contains { $0.role == "AXMenu" }
        default: throw AXFailure.invalid("Unknown key context")
        }
        guard allowed else { throw denied("Key is not allowed in the observed focus/context") }
    }

    static func drag(_ c: PolicyContext, evidence: [Attributes]) throws {
        try requireSafe(c)
        guard c.target.root == .application, c.editor, c.timeline, c.a.role == "AXButton",
              UUID(uuidString: c.a.identifier) != nil,
              (c.a.labels.contains("Video") || c.a.labels.contains("Music") || c.chain.dropLast().contains {
                  $0.labels.contains("Music") || $0.labels.contains("Audio")
              }),
              evidence.contains(where: { $0.identifier == "editor.tool.toolMode.trim" && $0.selected }) else {
            throw denied("Drag requires a timeline clip/music target and selected Slip, Trim, Roll mode")
        }
    }

    static func denied(_ message: String) -> AXFailure { AXFailure("AX_ACTION_FORBIDDEN", message) }
}
