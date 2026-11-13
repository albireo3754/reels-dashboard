# Agent interface and module boundaries

Status: implemented and locally verified; PR checks and merge state are tracked separately. This contract is derived from repeated editing workflows, not from exposing every Electron IPC method.

## Workflow evidence

Private Daily Notes and original editing-session messages were inspected locally on 2026-10-27. The private evidence index stays in the content workspace; no transcripts, media names, personal paths, or library identifiers belong in this public repository.

| Observed workflow | Interface requirement |
| --- | --- |
| Reuse an established template while choosing a different cover frame | List actual supported templates; edit cover time independently of video overlays. |
| Move the place pin and description together; move captions independently | Typed partial settings updates with separate `place`, `captions`, and `cover` sections. Preserve omitted fields. |
| Re-render using an updated source video while retaining settings | Import a new source project and optionally copy settings from a revision-checked existing project. Never rewrite the source. |
| Compare a selected moment or cover instead of reviewing every frame | Return an actual PNG and resolved engine manifest for a requested preview. |
| Export a cover independently, or render video without changing the cover | Explicit `video`, `cover`, or `both` render target. |
| Check progress, cancel, and use a versioned output filename | Job IDs, terminal state, output paths and manifests; reject overwrites. |
| Work on what is currently open in the editor | Report active project, time, dirty state and active jobs; synchronize external edits with UI. |

One historical template name was used with changing sizes. A tool must return current template values and output manifests rather than claim pixel parity from its name. Caption heights and exposure intervals are project choices, not global defaults. Color grading and a multi-clip timeline are not implemented by the current engine and must not be advertised as available tools.

## Architecture

`Codex -> stdio MCP -> private Unix socket -> application composition -> shared editor service`

`Agent shell -> reels CLI -> private Unix socket -> application composition -> shared editor service`

There is no HTTP listener. The MCP server and the `reels` CLI are both thin clients of the same socket and the same tool definitions, so they cannot drift apart. Neither has an independent project store or render queue. Electron owns state and jobs; closing an MCP connection or ending a CLI process does not cancel a render. A stopped app produces an explicit connection error, never synthetic data. The app must be opened before editing; an agent does not silently launch a second app instance.

- `src/app`: composition, MCP entry point, `reels` CLI entry point (`src/app/cli`), integration of editor and agent tools.
- `src/features/reel-editing`: existing editor service, importing only lower-level shared contracts/storage. Public API is `index.ts`.
- `src/features/agent-tools`: typed tool definitions and handlers using an injected editor port. It cannot import the sibling editor feature.
- `src/entities/agent-session`: active editor context and revision-aware settings operations.
- `src/shared`: existing contracts and validation; generic private socket transport and local storage.
- `src/desktop` and `src/renderer`: existing Electron/React entry points; consume public module APIs. This change does not claim to migrate the entire application to FSD.

`npm run check:architecture` enforces layer direction and feature/entity public APIs. Shared modules do not import features, entities, app, desktop or renderer. Same-layer feature imports are forbidden. Node-only feature services are not imported into the web renderer.

## Tool contract

Tools cover app state, project listing/loading/opening, source import (optionally with settings from an existing project), supported templates, partial settings updates, preview images and render start/status/cancellation. Project updates and render requests carry the revision returned by a read. An outdated revision fails explicitly; it never retries by overwriting another writer. Unsaved UI changes remain visible and protected.

Photos discovery tools expose only validated status, date indexing, group listing/detail and bounded evidence inspection. Photos permissions still belong to the existing native helper. Copy/move/delete and publication are not implicitly exposed by a generic request tool. An existing Photos selection can be imported through the same checked materialization service used by the UI.

MCP results use structured JSON for state and jobs, and image content for previews. Tool errors are `isError` results with actionable messages. Runtime input validation also happens at the app boundary; MCP validation alone is not trusted.

The `reels` CLI derives its subcommands, flags and schemas from `toolDefinitions`, sends each write exactly once and never fills in a revision for the caller. It reports one JSON document on stdout and a documented exit code; only `reels help --plain` and `reels tools --plain` write text, for people. See [CLI usage](cli-usage.md). An agent that only has the installed `reels` command reads `reels help agent`, the [reels-cli skill](../skills/reels-cli/SKILL.md) embedded in that build. A request that was sent but not answered is `CONNECTION_LOST` or `REQUEST_TIMEOUT`, never `APP_OFFLINE`: only a request the app never received may be reported as not applied. A signal during an app call follows the same rule: the CLI reports the write as unknown, and only after it holds a job id does it report the render as started.

## Acceptance

1. FSD boundary checks, type checks and existing relevant tests pass after extraction.
2. Real stdio MCP initialization, tools listing, tool validation and error results pass.
3. Through MCP and a real non-demo Electron app, import synthetic media, change only requested settings, receive a decoded PNG and manifest, render actual media, inspect completion and cancel a running job.
4. UI reflects agent changes; unsaved UI and stale project writes cannot overwrite each other. Restart/reconnect and app-offline behavior are tested.
5. A project-scoped MCP configuration is installed in the content workspace without replacing other configuration. Its exact command is exercised locally.
6. The `reels` CLI lists exactly the MCP tools with the same input schemas, and its round trip, offline, exit-code, image, wait and local-copy behavior pass against a real private socket with a fake dispatch. Its built bundle runs from outside the repository. CLI behavior against a real running app is verified separately.
7. Public audit excludes personal evidence and runtime data. PR review, CI and merge state are verified separately from local test success.

References: [FSD layers](https://feature-sliced.design/docs/reference/layers), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Codex project MCP configuration](https://developers.openai.com/codex/mcp).
