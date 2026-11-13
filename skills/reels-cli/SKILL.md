---
name: reels-cli
description: Operate a running Reels Dashboard app from a shell with the `reels` CLI - read and edit editing projects, preview frames, start and follow renders, manage content entries and copy registered media. Use only when a task needs Reels Dashboard app operations from a shell. Not for authoring or resuming YAML workflows (use skills/reels-workflow); does not launch the app, publish or upload.
---

# Reels CLI

Most `reels` commands call the running Reels Dashboard app through the same private socket tools as MCP. The app owns projects, Photos access and render jobs. `prepare-media` and `collect-instagram-insights` work directly with local files without the app. The CLI has no queue or retry logic, and it never launches the app. If `reels` is not on `PATH`, run `node <repo>/dist-cli/reels.mjs` instead.

## Start

For app-backed operations:

1. `reels status`: `data.app.online` says whether the app can be called. It exits 0 either way. When it is `false`, ask the user to open Reels Dashboard. Never launch the app yourself.
2. `reels doctor` when something is off: read-only checks of runtime, profile, app, the `~/.local/bin/reels` launcher and `PATH`. Each check has `ok` true, false or null and a `fix` that the CLI never applies.
3. `REELS_USER_DATA` selects the app profile, as it does for the MCP server.

## Discover

- `reels tools`: every tool with its command, read-only flag, summary and `group`, plus the domain groups.
- `reels tools --group <id>`: only one group, such as `editor`, `render`, `content`, `photos`, `delivery`, `forms`, `analysis`, `blog` or `planning`.
- `reels tools <name>`: the input schema, generated flags, options and an example. Read it before calling a tool for the first time.
- `reels <command> --help` or `reels help <command>`: usage text. `reels --version` prints the CLI version.

A tool can be named `reels_get_project`, `get_project` or `get-project`. Flags come from the schema: `expectedUpdatedAt` is `--expected-updated-at`. Objects and arrays take JSON. A value starting with a dash needs `=`. For a whole input use `--input <json|->` or `--input-file <path>`; use one input source only.

## Photos

Photos originals stay untouched by default. The `photos` group only reads (status, search, index, groups, inspect). To bring a visit's Photos material to the dashboard, use `reels import-photos-bundle --project-id <card> --group-id <id> --index-run-id <run>` (optional `--asset-ids '["<id>",...]'` as JSON): it copies every photo and video of the group, Live Photo motion included, into app storage and attaches them to that one card. Videos become linked edit projects without cards of their own. Rerunning is safe; earlier copies are reused. `reels import-photos-video` imports a single video as its own edit card. Both leave the Photos item unchanged. There is no move or delete command. Deleting originals is a desktop-only choice the user makes explicitly; "organize" or "정리" never means delete.

## Ids

`--project-id` takes two kinds of id, and the usage line shows which:

- `<uuid>`: an editing project, `.data.editorProjects[].id` of `reels list-projects`.
- `<string>`: a dashboard content entry, `.data.dashboard.projects[].id` of the same command.

## Read before write

A write that takes `--expected-updated-at` needs the revision you last read; the CLI never fills it in. Some writes, such as `cancel-render`, `import-video`, `set-cover-preferences` and `open-project`, take no revision: `reels tools <name>` shows whether a tool has the flag.

```sh
reels get-project --project-id <uuid>        # .data.updatedAt is the revision
reels update-project --project-id <uuid> --expected-updated-at <rev> --patch '{"cover":{"time":7.25}}'
```

Use the new `.data.updatedAt` for the next write. For `upsert-content`, `merge-projects` and `link-project-edit` the revision is the dashboard's: `.data.dashboard.updatedAt` of `reels list-projects`. On exit 5 (`STALE_*`), run the `next` read, check whether the change still makes sense, then write with the new revision. On exit 6 (`EDITOR_BUSY` and other `*_BUSY`) the app is protecting work in progress: wait, do not work around it.

## Output contract

stdout is always one line of JSON, including errors and help. stderr is for people. No prompts or colors. (`reels help --plain`, `reels tools --plain` and `reels completion` print text for people; do not use them.)

- Success: `{"ok":true,"tool":"…","data":…}`.
- Failure: `{"ok":false,"error":{"code","message","exitCode","retry","writeOutcome",…}}`, sometimes with `next`, `hint`, `issues`, `usage` or `didYouMean`.
- `retry`: `safe`, `fix_input`, `refresh_first`, `wait`, `inspect_first` or `no`.
- `writeOutcome`: `not_applied`, `applied`, `unknown` or `none` (read-only).
- `next`: commands you can run as they are. `hint`: advice that is not a command.

**When `writeOutcome` is `unknown`, never retry the write.** The app may have applied it. Run the `next` read first and decide from the state you see. Treat an empty stdout from a write the same way.

`reels help exit-codes` prints every exit code. The common ones: 0 ok, 2 usage, 3 app offline, 4 tool error, 5 stale revision, 6 busy, 7 outcome uncertain.

## Images

`preview-frame` and `form-media` need `--out <new file>`. Its parent must exist and the file must not. The JSON result only holds `data.image: {path, mimeType, bytes}`, so open the saved image and look at it before claiming a visual change worked.

## Renders

```sh
reels start-render --project-id <uuid> --expected-updated-at <rev> --target video --output-path /absolute/new.mov --wait
reels get-render-job --job-id <id> --wait    # attach later
```

`--wait` polls until the job ends and maps its state to the exit code (8 failed, 9 cancelled, 10 wait timed out while the job keeps running). Ending a wait never stops the render; use `reels cancel-render` for that. Render jobs live in app memory and are gone after an app restart.

## Local media copy

`reels prepare-media --list` shows content projects and their registered media; `reels prepare-media --help` explains copying them into a new folder. It works without the app.

## Instagram collection without the app

`reels collect-instagram-insights --source manual|scheduled` writes one private snapshot and waits until saved. It uses the same `REELS_USER_DATA` profile, requires an existing token-file connection, never retries and refuses `REELS_DEMO=1`. The app need not be opened first. `refresh-instagram-insights` instead starts the running app's asynchronous collection.

On `INSTAGRAM_AUTH`, ask Codex to help renew the Instagram read token through the existing private token file/account connection. Never paste a token into chat or CLI arguments. No app OAuth or automatic renewal is provided. Before persistence, failures say `not_applied`; once persistence starts, inspect `next` and `hint` before repeating. A busy lock says `retry: wait`; a lock left by SIGKILL requires verifying the owner is gone before manual removal, never age-based takeover.

## More

This guide comes from `reels help agent` and matches the installed CLI version. Full documentation lives in the Reels Dashboard repository: `docs/cli-usage.md` (CLI contract and exit codes) and `docs/mcp-usage.md` (what each tool does).
