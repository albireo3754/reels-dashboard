# Edits AX helper

Internal macOS 15+ Swift 6 helper for Reels Dashboard. Dashboard main spawns one child per request, sends one UTF-8 JSON document on stdin and closes the pipe. The child emits one JSON envelope on stdout and exits. There is no daemon, app bundle, installer, authorization request, command-line action interface or persistent project state.

Build and pure tests, from the Dashboard checkout:

```sh
swift test --package-path native/editsax
swift build --package-path native/editsax -c release --product editsax
```

These commands compile the macOS adapter; the tests use only a synthetic backend. They never execute the helper or access live Accessibility, screen capture, Photos or Edits projects. Live status/read/action checks belong to the integration owner through Dashboard main.

The build owner signs and atomically installs the release binary as `.build/editsax` for development and `resources/native/editsax` for packaging. SwiftPM's `.build/release/editsax` output is not that installed artifact. This package does not sign, install or replace either destination. Dashboard TCC attribution remains unverified until tested through the actual development and packaged app.

## Protocol v2

The envelope uses `protocol: 1`, a bounded string `id`, `operation` and object `args`. Supported operations are `status`, `tree`, `find`, `press`, `set-value`, `menu`, `key`, `drag` and `screenshot`. Native `menu` takes an array such as `["File", "Import Media"]`.

- Requests are limited to 1 MiB and encoded responses to 16 MiB. Diagnostics never include request values.
- `status` calls `AXIsProcessTrusted()` and `CGPreflightScreenCaptureAccess()` without request/prompt APIs. Missing permission or a stopped app is a successful status result. Only the exact `/Applications/Edits.app` and `com.burbn.basel.mac` process matches; duplicate exact processes are rejected.
- `status.screenLocked` is `true | false | "unknown"`. A prompt-free `CGSessionCopyCurrentDictionary()` read extracts only `CGSSessionScreenIsLocked` and accepts only a CFBoolean. Missing session/key or other types remain `"unknown"`; numeric 0/1 and strings are not coerced. Session dictionaries and unrelated personal fields are never serialized. This reports lock state only and does not change AX/action policies, attribute the cause of an AX failure or unlock the session.
- `Target.root` is `application` or `menuBar`. `[]` is the corresponding AXApplication or AXMenuBar root; child indices always retain their actual AXChildren positions. Menu bar descendants are exported under the menu bar root even when AXChildren also references them.
- SHA-256 fingerprints cover PID, root, role, identifier, title and description using a length-delimited JSON array. Values are excluded. Actions re-resolve the same root/path immediately before dispatch; they never choose a nearby replacement.
- Tree limits are depth 1–16 and 1–4000 nodes (defaults 12/3000). Each snapshot has a 6 MiB encoded node budget; cycles/read failures mark it truncated. Writes require a complete bounded snapshot. Metadata strings are bounded to approximately 1 KiB, string values to approximately 4 KiB and actions to 16 per node. Secure/login values are not requested from the backend.
- Selector fields are ANDed; role/identifier are exact, and label exactly matches title, description or placeholder. All candidates are returned.
- Nodes preserve a bounded `placeholder` string in both tree and find JSON, including after the field's value changes. Secure/login values remain unread and null; placeholder is metadata and is never substituted from AXValue.
- Requests have an absolute 20-second budget (30 for screenshots), and AX messages have a per-call timeout. Dashboard additionally enforces child lifetime and output bounds. No operation is automatically replayed after an uncertain outcome.

Snapshots additionally contain `diagnostics: {counts, samples, samplesOmitted}`. `counts` maps truncation reason to event count: `depth-limit`, `node-limit`, `byte-limit`, `children-limit`, `duplicate`, `cycle`, `attributes-read-error`, `value-read-error` or `children-read-error`. Every such event still sets `truncated:true`; diagnostic classification never makes a partial tree safe for writes. A duplicate is a previously visited element outside the active ancestor chain; a cycle returns to an active ancestor. Both remain blocked.

At most 16 samples contain `{reason,root,path,firstPath?,errorCode?,axErrorCode?,axAPI?,axAttribute?}`; excess events increment `samplesOmitted`. `firstPath` identifies the original occurrence for duplicate/cycle. Counts describe diagnostic events, not the number of missing nodes. Samples never copy element labels, values, error messages or arbitrary error details. AX read failures additionally expose the numeric AX error and API/attribute in structured error details. Complete snapshots have empty counts/samples and `samplesOmitted:0`. A write rejected for incomplete context also includes `error.details.diagnostics`. An incomplete after observation remains an unknown outcome, and diagnostic changes alone cannot prove a UI state change.

`AXSubrole` is [required only when the basic role is insufficient](https://developer.apple.com/documentation/applicationservices/kaxsubroleattribute). A generic `AXUIElementCopyAttributeValue(AXSubrole)` failure (-25200) is not automatically unsupported. Only that exact failure triggers one read of [supported attribute names](https://developer.apple.com/documentation/applicationservices/1459475-axuielementcopyattributenames). If the list succeeds, excludes `AXSubrole`, and the role is one of AXButton/AXGroup/AXToolbar/AXImage/AXStaticText/AXScrollArea/AXSplitGroup/AXSplitter, the absent optional subrole is accepted. Inputs, windows/dialogs, unknown roles, advertised subroles and failed attribute lists retain the original failure; permission failures still propagate. The global optional-error list and value/writing safety checks are unchanged.

This narrow confirmed-absence case is separately audited as `diagnostics.confirmedAbsentSubroles` (event count) and `confirmedAbsentSubroleSamples` (up to 16 `{root,path,role}` records). It is not a truncation event; all existing `counts` reasons remain truncating. Failed Subrole probes add optional `axRole`, `axAttributeListed` and `axAttributeListErrorCode` to read error samples/details. Sensitive data remains protected by [secure text field subrole checks](https://developer.apple.com/documentation/applicationservices/kaxsecuretextfieldsubrole); unknown Subrole failures on input roles are never downgraded to absence. The affected live node's role and advertised attributes must still be confirmed through Dashboard; a passing synthetic test does not establish that this branch resolves a live failure.

## Actions and safety

`press` and `set-value` require the contract's intent; `key` requires a concrete target and context. Caller-supplied intent does not grant permission. The engine checks actual metadata, ancestor/root identity, classified window/panel/dialog context and actual focus where required. Forbidden publishing, sharing, login, secure, deletion and permission contexts are refused. Unknown controls, unrelated dialogs and incomplete context fail closed with `AX_ACTION_FORBIDDEN`.

Panel labels alone do not prove ancestry. Unlabelled panel/timeline containers, unclassified translated controls and dialogs lacking the required identifying metadata remain blocked. Timeline UUIDs require a timeline ancestor; arbitrary UUID buttons are refused. Import confirmation requires a classified AppKit file panel with browser/outline evidence. Duration confirmation requires an explicit Duration/Clip duration dialog. No helper session state is used to guess how a dialog opened.

Coordinate press fallback requires an absent AXPress or an explicit `notImplemented`/`actionUnsupported` non-dispatch, explicit opt-in, another target/context check and a visible, exact hit-tested target center in frontmost Edits. Timeout, cannotComplete, generic failure and successful AX calls with no observed change never cause coordinate replay. Drag is a single explicitly marked coordinate action: a classified video/music timeline button, selected Slip/Trim/Roll mode, finite bounded deltas and onscreen endpoints are required. Unclassified music/text UUID targets are refused.

Import auxiliary keys require classified focus. Return is limited to Go to Folder path inputs or selected browser rows/cells; select-all is limited to those path inputs. Go to Folder/Escape require path/browser/panel focus. Buttons and unknown controls receive none of these keys; Import/Open confirmation uses the explicit `import-confirm` press policy. Every intervening dialog must be a classified file panel or named Go to Folder sheet. A nested Go to Folder sheet uses its containing file panel's browser evidence; unclassified sheets remain blocked.

Audio library presses require a leaf button in the Audio panel's result list with the observed `title, artist, · m:ss` marker (nonempty title/artists and valid seconds). Plain labels such as settings/save, placeholder-only markers, malformed or inconsistent labels are rejected. Preview Add/Trim additionally needs that track marker in its local preview container. Other result label formats remain blocked pending observed evidence.

An application-root cycle still sets `truncated:true` and blocks writes. At most 16 recorded root-cycle samples can contain an `identity` object: roles from the captured node and fresh reads, owning PIDs, reference identity/CFEqual comparisons, plus a newly created application element's role and first AXChildren element's role/comparisons. Probe errors retain their structured AX code/API/attribute. This is one bounded read-only diagnostic, with no AXValue, labels or raw addresses. Neither its success nor an inconsistent result overrides cycle detection, replays a request or substitutes a different root/children source. The next Dashboard read must establish whether the observed root self-reference persists or the identity/observation is inconsistent.

`dryRun` performs reads and plan checks only, returning `attempted:false`, `verified:false`, `fallback:null` and identical before/after snapshots. Set-value can be verified by actual scalar type and exact value readback. Other actions return only observed state changes or an unknown outcome, with `verified:false`; high-level postconditions belong to Dashboard. Failures retain attempted/before/available-after evidence. There is no action polling or automatic retry loop.

Screenshot capture preflights permission, matches the exact app's focused/main AX window to one ScreenCaptureKit window, captures only that window and bounds the longest output dimension to 1280. Missing/ambiguous window matches are errors. The capture path has been compiled, not exercised against a live window.

The package never opens or writes Edits project databases, media, login information or Photos data. No live capability, permission ownership or music/export acceptance is claimed by the pure test results.
