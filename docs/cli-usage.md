# `reels` CLI

`reels` lets an agent work with Reels Dashboard from a shell. It is a thin client: it reuses the MCP tool definitions and the same private Unix socket, so every MCP tool is available and the two cannot drift apart. Electron still owns projects, Photos access and render jobs. The CLI has no project store, no render queue and no retry logic, and it never launches the app.

## Setup

```sh
npm run build:desktop
node /absolute/path/to/reels-dashboard/dist-cli/reels.mjs status
```

`dist-cli/reels.mjs` is a single self-contained file that runs from any directory with Node 22.12 or later. To get a `reels` command, run `npm link` once in the repository and check it with `command -v reels`, or call the file by its absolute path. The file is executable, so an alias or symlink also works.

### Installed with the app

The packaged app ships the bundle as `Contents/Resources/cli/reels.mjs`. Each time the packaged app starts (not the Dev build, not background QA), it writes `~/.local/bin/reels`, a small `sh` launcher that runs the bundle with the app's own executable under `ELECTRON_RUN_AS_NODE=1`. A separate Node install is not needed, and the command always matches the installed app version. If the app moves, the next launch rewrites the path.

The launcher carries the line `# reels-dashboard-managed-cli`. The app writes `~/.local/bin/reels` only when that file is missing or carries the marker. A symlink, such as one from `npm link` to a checkout, or a script of your own is never replaced: remove it once to switch to the app's launcher. The result is logged as `[cli-install] installed|updated|unchanged|skipped`. `~/.local/bin` must be on `PATH`. Code: `src/desktop/cli-install.ts`; the marker and the launcher text live in `src/shared/cli-launcher.ts`, which [`reels doctor`](#diagnostics) also reads. `reels doctor` checks this setup.

`REELS_USER_DATA` selects the app profile, as it does for the MCP server. Without it the CLI uses the normal application-support directory. A relative value needs the working folder: if that folder is gone, tools exit 2 and `reels status` reports `reason: "user_data_unresolved"`.

## Commands

| Command | Needs the app | Purpose |
| --- | --- | --- |
| `reels status [--timeout <s>]` | no | Whether the app can be called. Exit 0 even when it cannot, or when it answers with an error. Default limit 5 s. |
| `reels doctor [--timeout <s>]` | no | Read-only [setup checks](#diagnostics): runtime, profile, app, launcher and `PATH`. Exit 0 whatever it finds. Default limit 5 s for the app check. |
| `reels tools` | no | Every tool with its command, read-only flag, summary and `group`, plus the built-in commands that do work (`builtins`) and the domain groups (`groups`: `id`, `summary`, `count`). |
| `reels tools --group <id>` | no | The same list, only the tools in one [group](#tool-groups); `data.group` names it. |
| `reels tools <name\|slug>` | no | Input schema, generated flags, CLI options, an example and the tool's `group`. |
| `reels <slug> [options]` | yes | Any tool. `reels_get_project` is `reels get-project`. |
| `reels call <name\|slug> [options]` | yes | The same, by full tool name. |
| `reels prepare-media ...` | no | [Local media copy](#local-media-copy). |
| `reels --help`, `reels <command> --help`, `reels help [<command>]`, `reels --version` | no | Help and version. |
| `reels help exit-codes` | no | The exit codes as text and as `data.exitCodes`, for when this file is out of reach. |
| `reels help agent` | no | The [agent guide](#agent-guide) for this version as `data.guide` (Markdown), with `data.name` and `data.version`. |
| `reels help --plain [<topic\|command\|tool>]` | no | The same help as [text for people](#text-for-people) instead of JSON. A tool shows the detail of `reels tools --plain <tool>`. |
| `reels tools --plain [<name\|slug> \| --group <id>]` | no | The tool list grouped by domain, or one tool's usage, flags, example and group, as [text for people](#text-for-people). |

### Agent guide

`reels help agent` prints [`skills/reels-cli/SKILL.md`](../skills/reels-cli/SKILL.md), a short skill for operating the app through this CLI: `{"ok":true,"data":{"guide":"<markdown>","name":"reels-cli","version":"0.1.0"}}`. The build embeds the file in `dist-cli/reels.mjs`, so the guide always matches the installed CLI and needs no repository; from source the CLI reads the file. The last line of `reels --help` points agents to it. Edit the skill file, not a copy, and rebuild.

A tool can be named as `reels_get_project`, `get_project` (the form the guidance text uses) or `get-project`, in every place that takes a tool name.

### Text for people

`--plain` belongs to `reels help` and `reels tools` only; it is not a global option, so a tool flag such as `reels photos-search --text` keeps its meaning, and `--plain` on any other command is a usage error (exit 2). Agents should keep reading the JSON forms.

- `reels help --plain`: the top-level help. `reels help --plain <command>` prints that command's help text; `--plain` may come before or after the name.
- `reels help --plain <tool>` and `reels tools --plain <tool>`: usage, every flag with its type, allowed values, format and whether it is required, the CLI options, an example and the group.
- `reels tools --plain [--group <id>]`: the built-in commands, then each group as `<id>: <summary> (<count>)` followed by `  reels <slug>  <summary>` lines; read-only tools end in `(read-only)`.
- `reels help --plain exit-codes`: the exit code table with names. `reels help --plain agent`: the Markdown guide as it is.

### Tool groups

Every tool belongs to one domain group, so an agent can read a short list instead of all of them: `reels tools --group render`. Groups are a filter of `reels tools`, not commands, and the MCP tool definitions do not carry them. The ids are `editor`, `render`, `content`, `photos`, `delivery`, `forms`, `analysis`, `blog` and `planning`; `data.groups` lists each with its summary and tool count, and `reels <slug> --help` ends with the tool's group. An unknown id exits 2 with `didYouMean` and the valid ids in the message. `--group` does not combine with a tool name, and `reels tools` still rejects any other option with exit 2.

Flags come from the tool's input schema: `expectedUpdatedAt` is `--expected-updated-at`. Strings and enums pass through, numbers are converted, a boolean is a flag without a value, and objects and arrays take JSON. A value starting with a dash needs `=`, as in `--after-revision=-1`. Repeating a flag is an error. `--help` and `-h` mean help only as options of their own: as the value of another option they are a usage error, so `--patch --help` exits 2 and never reads as a successful write. Usage lines and `reels tools <name>` show allowed values and formats, as in `--kind <video|cover>`, `--project-id <uuid>`, `--folder <abs-path>` and `--date <YYYY-MM-DD>`. In `flags`, a format that has no name of its own keeps its regular expression in `pattern`. `inputSchema` is the MCP schema unchanged, so it still carries Zod's `starts_with`.

`--project-id` covers two kinds of id, and the flag shows which one a tool takes. `<uuid>` is an editing project: `.data.editorProjects[].id` of `reels list-projects`. `<string>` is a dashboard entry: `.data.dashboard.projects[].id` of the same command, or the `id` from `reels prepare-media --list`.

| Option | Applies to | Behavior |
| --- | --- | --- |
| `--input <json\|->` | any tool | The whole input as JSON. `-` reads stdin. |
| `--input-file <path>` | any tool | The whole input from a file. |
| `--timeout <s>` | any tool | Limit for one whole app call, including reading its answer, up to 180 (the default). Also applies to each `--wait` poll. |
| `--out <path>` | image tools | Required. A new file for the image. |
| `--wait` | `start-render`, `get-render-job` | Wait until the job is terminal. |
| `--wait-timeout <s>` | with `--wait` | Stop waiting after this long, up to 2147483 (a timer cannot hold more). Default: no limit. |

Use one input source: schema flags, `--input` or `--input-file`. With none, the input is `{}`. stdin is read only for an explicit `-`, and a terminal stdin is a usage error. Input over 2 MiB is rejected. Input is validated against the schema before the app is called, and the validated value (with defaults applied) is what is sent.

## Output

stdout is one line holding one JSON document, including for failures, `--help` and SIGHUP, SIGINT or SIGTERM at any point of a command. Four things can still leave it empty: SIGKILL, SIGQUIT (which keeps its core-dump meaning), a signal in the first moments before the CLI has finished loading, and a second signal after the first. Treat an empty stdout from a write as `writeOutcome: "unknown"`. If the document cannot be written in full, for example on a full disk, the CLI says so in one stderr line and exits non-zero, keeping the command's own failure code and using 11 if the command had succeeded. stdout then holds cut-off JSON, so treat it like an empty one. A reader closing the pipe early is not such a failure. stderr carries a one-line diagnostic and `--wait` progress for people; `--help` writes only to stdout. There are no prompts, colors or spinners.

The only exception is opt-in text for people: `reels help --plain ...` and `reels tools --plain ...` write plain text instead of the JSON document. Nothing else writes text, and without `--plain` these two commands print JSON as before. A failure of either, including a bad `--plain` form, is still the one-line JSON document with its usual exit code, and text that cannot be written in full exits 11 like JSON does.

```json
{"ok":true,"tool":"reels_get_project","data":{"id":"…","updatedAt":"…"}}
{"ok":false,"tool":"reels_update_project","error":{"code":"STALE_PROJECT","message":"…","exitCode":5,"retry":"refresh_first","writeOutcome":"not_applied","next":["reels get-project --project-id <id>"]}}
{"ok":false,"tool":"reels_update_project","error":{"code":"INVALID_INPUT","message":"--project-id (projectId): Invalid UUID","exitCode":2,"retry":"fix_input","writeOutcome":"not_applied","issues":[{"path":["projectId"],"message":"Invalid UUID"}],"usage":"reels update-project --project-id <uuid> …"}}
```

`data` is the app's result unchanged, or `null` when there is none. Errors may also carry `reason`, `issues`, `usage`, `didYouMean`, `next`, `hint`, `jobId` and `job`. For `INVALID_INPUT` the message names the first failed field and how many more follow; `issues` lists them all.

- `retry`: `safe`, `fix_input`, `refresh_first` (read again first), `wait` (the app is busy), `inspect_first` (check state before doing anything), `no`.
- `writeOutcome`: `not_applied`, `applied`, `unknown`, or `none`. Read-only tools always report `none`.
- `next`: always an array of commands you can run as they are, filled in from your input. With `--wait`, `retry` refers to the `next` command, never to rerunning `start-render`.
- `hint`: a sentence for anything that is not a command, such as opening the app or which field to read from a `next` command's output.

`reels status` when the app cannot be called:

```json
{"ok":true,"data":{"app":{"online":false,"reason":"no_connection_file"},"cli":{"version":"0.1.0"},"userData":"/absolute/profile","hint":"Open Reels Dashboard; this CLI never launches it."}}
```

`reason` is `no_connection_file`, `stale_connection`, `unsafe_connection_file`, `unresponsive` or `user_data_unresolved` (a relative `REELS_USER_DATA` with no working folder: `userData` is `null` and `hint` says what to fix). `online: false` means the app cannot be called right now, not that it is certainly closed. When online, `app` holds `reels_get_app_state`: `context`, `busy`, `runtime` and `jobs`. If the app answers but cannot produce that state, `status` still exits 0 with `"app":{"online":true,"stateError":{"code":"…","message":"…"}}`.

## Diagnostics

`reels doctor` answers "why can't I, or an agent, use `reels` right now". It only reads: it stats files, reads the launcher, walks `PATH` without running anything, and asks the app for its state the same way `reels status` does, so the two never disagree about the app. It never launches the app, writes the launcher or changes `PATH`. It exits 0 for every state it can diagnose; a bad option exits 2.

| `id` | Checks | `ok: false` when |
| --- | --- | --- |
| `runtime` | Node version against `engines.node` in `package.json` (`>=22.12.0`); under the app's launcher it reports Electron as Node | the version is older |
| `profile` | The profile folder, from `REELS_USER_DATA` or the default | it cannot be resolved (`user_data_unresolved`) or is not a folder |
| `app` | The `reels status` verdict | the app cannot be called, or answers without its state. `null` when the profile is unresolved |
| `app_version` | Always `null`: the app does not report its version to the CLI | never |
| `launcher` | `<HOME>/.local/bin/reels`: `missing`, `managed` (carries the marker), `foreign` (a file of your own) or `symlink` (with its `target`) | missing with no other `reels` on `PATH`, managed but its bundle is gone, or a dangling symlink. `null` for a foreign file, a working symlink, or a missing launcher while another `reels` is on `PATH` |
| `launcher_bundle` | Whether the bundle this process runs (`process.argv[1]`) is the one the launcher runs, after resolving symlinks | they differ. `null` when there is nothing to compare |
| `path_dir` | `<HOME>/.local/bin` is a `PATH` entry | it is not |
| `path_command` | The first executable `reels` on `PATH` (absolute entries only) | there is none, or another one comes before the launcher |

`ok: null` means the check could not decide. `healthy` is true when no check is `false`. `fix` is advice for a person or agent, such as opening the app or editing `PATH`; the CLI never applies it, and `doctor` has no `next`. The result also carries `cli` (`version`, `bundle`, `node`, and `electron` under the launcher), `userData`, `app` as `reels status` prints it, `launcher` and `command` (`onPath`, `binDir`, `binDirOnPath`).

With the app closed and no launcher installed (`checks` shortened):

```json
{"ok":true,"data":{"healthy":false,"checks":[{"id":"runtime","ok":true,"detail":"Node 22.12.0; needs Node >=22.12.0."},{"id":"app","ok":false,"detail":"Reels Dashboard cannot be called (no_connection_file).","fix":"Open Reels Dashboard; this CLI never launches it."},{"id":"app_version","ok":null,"detail":"Unknown: the app does not report its version to the CLI. …"},{"id":"launcher","ok":false,"detail":"/Users/example/.local/bin/reels does not exist.","fix":"Open the packaged Reels Dashboard once; it writes ~/.local/bin/reels on launch. This CLI never launches it."},{"id":"path_dir","ok":false,"detail":"/Users/example/.local/bin is not on PATH.","fix":"Add ~/.local/bin to PATH."}],"cli":{"version":"0.1.0","bundle":"/absolute/dist-cli/reels.mjs","node":"22.12.0"},"userData":"/absolute/profile","app":{"online":false,"reason":"no_connection_file"},"launcher":{"path":"/Users/example/.local/bin/reels","state":"missing"},"command":{"onPath":null,"binDir":"/Users/example/.local/bin","binDirOnPath":false}}}
```

Code: `src/app/cli/doctor.ts` and `doctor` in `src/app/cli/run.ts`.

## Exit codes

| Code | Meaning | Error codes | `writeOutcome` for writes | `retry` |
| --- | --- | --- | --- | --- |
| 0 | Success | Includes offline `status`, every `doctor` result and a completed `--wait` | | |
| 1 | CLI bug | `INTERNAL` | `unknown` | `no` |
| 2 | Usage | `USAGE`, `UNKNOWN_TOOL` (from the CLI), `INVALID_JSON`, `INVALID_INPUT`, `REQUEST_TOO_LARGE`, `OUTPUT_EXISTS`. Includes every `prepare-media` refusal before the destination exists | `not_applied` | `fix_input` |
| 3 | App offline | `APP_OFFLINE` | `not_applied` | `safe`, after opening the app |
| 4 | Tool error | Anything else, such as `CONTENT_NOT_FOUND`, `RENDER_JOB_NOT_FOUND`, `*_CONFLICT`, `UNSUPPORTED`, `UNKNOWN_TOOL` (from the app, which needs rebuilding), or `TOOL_ERROR` for an error without a code | `unknown`; `not_applied` for `UNSUPPORTED` and `UNKNOWN_TOOL` | `no` |
| 5 | Revision conflict | `STALE_*`, `CONTEXT_REVISION_REQUIRED` | `not_applied` | `refresh_first` |
| 6 | Busy | `BUSY`, `*_BUSY`, such as `EDITOR_BUSY`, `BLOG_EXTRACT_BUSY`, `RENDER_SAVE_BUSY` | `not_applied` | `wait` |
| 7 | Outcome uncertain | `REQUEST_TIMEOUT`, `CONNECTION_LOST`, `RESPONSE_INVALID` | `unknown` | writes `inspect_first`, reads `safe` |
| 8 | Render failed | `RENDER_FAILED` | `applied` | `no` |
| 9 | Render cancelled | `RENDER_CANCELLED` | `applied` | `no` |
| 10 | Wait timed out; the job is still running | `WAIT_TIMEOUT` | `applied` | `safe` |
| 11 | Local file failure | `OUTPUT_WRITE_FAILED` (the app call succeeded, saving the image did not, and nothing is left at `--out`), `PREPARE_FAILED` (after the destination folder was created), `STORE_UNREADABLE` (`prepare-media` could not use `dashboard.json`). Also a stdout that could not be written, which has no document | `none`, `unknown`, `not_applied` | `safe`, `inspect_first`, `no` |
| 129, 130, 143 | SIGHUP, SIGINT or SIGTERM before the input was sent | `INTERRUPTED` | `not_applied` | `safe` |
| 129, 130, 143 | SIGHUP, SIGINT or SIGTERM during an app call or a `prepare-media` copy, including the first call of `start-render --wait` | `INTERRUPTED` | `unknown` | writes `inspect_first`, reads `safe` |
| 129, 130, 143 | SIGHUP, SIGINT or SIGTERM while `--wait` follows a job whose id it holds | `INTERRUPTED` | `applied` for `start-render` | `safe`, meaning the `next` command |

Read-only commands report `writeOutcome: "none"` in every row.

**Never retry a write while `writeOutcome` is `unknown`.** That covers exit 7 and an interrupted call: the app may have applied it, and may still be applying it. Inspect state first: `next` holds the read for that write, filled in from your input. It is `reels get-project` for an editing write, `reels get-content`, `reels search-analysis` or `reels form-get` for the matching tools, `reels list-projects` for `import-video`, `merge-projects` and `upsert-content`, and `reels status` for `start-render`, whose running jobs it lists.

On exit 5, `next` is the read that returns the current revision. `STALE_PROJECT` reads `get-project`, `STALE_DASHBOARD` reads `list-projects`, `STALE_ANALYSIS` and `CONTEXT_REVISION_REQUIRED` read `search-analysis`, and `STALE_FORM`, `STALE_INPUT` and `STALE_ARTIFACT` read `form-get`. Any other `STALE_*` code follows the same rule, from the ids in your input. `hint` names the field to use.

When `--wait` fails after a job is known, the error carries the job id and the last known job. `writeOutcome` is `applied` for `start-render --wait` and `none` for `get-render-job --wait`. `next` depends on the failure:

- `WAIT_TIMEOUT`, `INTERRUPTED` and a failed poll such as `APP_OFFLINE`: `next` resumes waiting.
- `RENDER_JOB_NOT_FOUND`: the job is gone, so `next` is `reels status`.
- `RENDER_FAILED` and `RENDER_CANCELLED`: the job is finished, so there is no `next`.

## Writing safely

```sh
reels status
reels get-project --project-id <id>
# .data.updatedAt is the revision
reels update-project --project-id <id> --expected-updated-at <rev> --patch '{"cover":{"time":7.25}}'
# .data.updatedAt is the new revision
reels preview-frame --project-id <id> --expected-updated-at <rev> --kind cover --out /absolute/cover.png
reels start-render --project-id <id> --expected-updated-at <rev> --target video --output-path /absolute/new.mov --wait
```

The revision is always yours to supply. The CLI has no way to pick the latest one, because that would remove the conflict protection. On exit 5, read again, check whether your change still makes sense, then write with the new revision. On exit 6 with `EDITOR_BUSY`, unsaved UI work is being protected, so do not work around it.

Before `reels start-analysis`, follow [context intake](media-analysis.md#context-intake-before-every-analysis). See [MCP usage](mcp-usage.md) for what each editing tool does.

## Images

`preview-frame` and `form-media` require `--out`. The target is resolved against the working directory, its parent must exist and it must not exist. Both are checked before the app is called. The file is created with mode 0600 and never overwrites anything: the image goes to a hidden temporary file in the same folder and is hard-linked to the target, so `--out` is either complete or absent. That needs a file system with hard links; on one without, such as exFAT, the save fails with `OUTPUT_WRITE_FAILED` and `--out` must point somewhere else. A file that appears at the target while the app is working is kept and reported as `OUTPUT_EXISTS`. The result replaces the base64 field with `data.image: {path, mimeType, bytes}` and keeps the other fields.

Base64 never reaches stdout: a data URL in any other result becomes `{omitted: "data_url", mimeType, bytes}` with a warning on stderr. The JSON result does not show you the image, so open the saved file and look at it before claiming a visual change worked.

## Renders

`start-render` returns a job at once. `.data` is the same job shape with or without `--wait`. `--wait` prints the job id to stderr and polls once a second until the job is terminal. `get-render-job --job-id <id> --wait` attaches to a job later. Without `--wait`, reading a failed job is a successful read (exit 0); only `--wait` turns the job's state into an exit code.

Waiting never controls the job. SIGINT, SIGTERM and `--wait-timeout` end the wait and leave the render running. A failed poll ends the wait without retrying. Use `reels cancel-render` to cancel. A signal that arrives before the app has returned the job id is an interrupted write, not an interrupted wait: see the exit code table.

## Local media copy

```sh
reels prepare-media --list                      # projects and how many resources each has
reels prepare-media --list --project-id <id>    # one project's registered paths
reels prepare-media --project-id <id> --selection /absolute/selection.json --destination /absolute/new-directory
echo '["/absolute/clip.mov"]' | reels prepare-media --project-id <id> --selection - --destination /absolute/new-directory
```

This copies media already registered to a content project into a new folder and writes `receipt.json`. It reads the app's saved data directly, so the app does not need to be running, and it does not write to the app's store. `--list` is read-only and also works without the app. `--list` shows a registered folder as the folder itself. The folder cannot be selected: put the paths of the files inside it in `--selection`. Selected files must be media: `.mov`, `.mp4`, `.m4v`, `.jpg`, `.jpeg`, `.png`, `.heic`, `.webp`, `.m4a`, `.mp3`, `.wav`, `.zip`.

`--selection` is the path of a JSON file holding an array of absolute paths, or `-` to read that array from stdin. Inline JSON is not accepted. The destination must be a new folder given as a normalized absolute path, without a trailing slash. Its parent must exist and must not be a symlink; on macOS `/tmp` is one, so use `/private/tmp`. See [handing media to a local editor](local-editor-handoff.md) for the checks it performs.

Anything refused before the destination folder exists is `INVALID_INPUT` (exit 2, `not_applied`): an unknown project, an unregistered or empty selection, colliding names, a destination that already exists. When specific files are refused, the message starts with the first path, `issues` has one `{path, message}` per refused file and `next` lists the project's registered paths. Only a failure after the destination exists is `PREPARE_FAILED` (exit 11, `unknown`), and the folder may be incomplete.

If `dashboard.json` is damaged, unreadable or from a newer app, every form of the command reports `STORE_UNREADABLE` (exit 11, `retry: "no"`, `not_applied`, or `none` with `--list`). The message gives the file and the cause. Changing the input does not help; for a newer app, update the CLI.

## Limits

- One app call lasts at most 180 seconds, the socket's limit. A slow `reels_import_video` can outlive it: the app keeps working and the CLI exits 7.
- A preview also returns `EDITOR_BUSY` while the UI has unsaved changes to that project.
- Render jobs live in app memory. After an app restart they are gone and `get-render-job` reports `RENDER_JOB_NOT_FOUND`.
- A `--timeout` shorter than `reels_form_wait`'s `timeoutMs` produces a false timeout. Keep `--timeout` longer.
- For `upsert-content`, `merge-projects` and `link-project-edit`, `--expected-updated-at` is the dashboard revision, not a project's `updatedAt`, even though `link-project-edit` also takes `--project-id`. Read it from `.data.dashboard.updatedAt` of `reels list-projects`, which also works for an entry that does not exist yet, or from the top-level `.data.updatedAt` of `reels get-content`. `.data.project` has no `updatedAt`.
- The running app must be at least as new as the CLI. Otherwise a new tool returns the app's `UNKNOWN_TOOL`, and some errors lose their code and fall back to exit 4.
- The packaged app ships the CLI bundle and installs the `~/.local/bin/reels` launcher on launch ([Installed with the app](#installed-with-the-app)). The Dev build and a source checkout do not: there, build `dist-cli/reels.mjs` and run it as in [Setup](#setup).

## Validation

```sh
npm run typecheck
npm run check:architecture
node --import tsx --test tests/unit/reels-cli.test.ts tests/unit/agent.test.ts
npm run build:desktop
npm run test:cli
```

`tests/unit/reels-cli.test.ts` drives the CLI against a real private socket under a temporary profile, mostly with a fake dispatch and once with the real `createAgentDispatch` over stub ports, and compares every schema with a real stdio MCP server. `npm run test:cli` copies the built bundle to a temporary folder with no `node_modules` and runs the copy. Neither touches a running app.
