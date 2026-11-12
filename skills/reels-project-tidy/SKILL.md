---
name: reels-project-tidy
description: Scan every Reels Dashboard card the video editor created on its own (titled with the footage file name) and fold each into the production project it belongs to, verifying cards in parallel and merging one at a time with the existing merge API. Use when the Dashboard's "프로젝트 정리" button starts a session or the user asks to tidy split project cards. Does not rename, delete, publish or edit content documents.
---

# Reels project tidy

Opening a video in the editor without a project creates a card named after the file (for example `clip.mov`). This skill finds those cards and merges each into its real project. Commands below use the `reels` CLI (`node <repo>/dist-cli/reels.mjs` if `reels` is not on PATH). MCP tool names are the same with a `reels_` prefix. Contracts: [production projects](../../docs/production-projects.md).

1. **Scan.** Run `reels scan-orphan-edits`. It is read-only. Each card has `footage`, `candidates[]` with `folderMatch` and `documentMention`, and `suggestedTargetId` only when exactly one candidate has both. If `cards` is empty, report that and stop.
2. **Verify in parallel.** Check every card independently, read-only. If your runtime can start subagents, give each card its own subagent. Otherwise go through the cards in order. For each card:
   - Read the candidate projects with `reels get-content --project-id <id>` and their linked content documents.
   - Search the private content workspace's post documents for the footage file name. Find it from the repository's `AGENTS.md` routing.
   - Decide `merge <targetId>` or `leave`, with the evidence (document path and line).
   - Use `leave` when the footage is named by a content document that no dashboard project links. That is a new reel cut from an older shoot.
   - Also use `leave` when two projects claim the footage, or when the only evidence is the shared shoot folder.
   - `suggestedTargetId` is a hint, not approval. Confirm it the same way.
3. **Merge one at a time.** Merges share one dashboard revision, so never run them in parallel. For each `merge` decision:
   - Read the current revision from `.data.dashboard.updatedAt` of `reels list-projects`.
   - Run `reels merge-projects --target-id <target> --source-ids '["<card id>"]' --expected-updated-at <revision>`.
   - If the result is stale, read the revision again and retry. If `writeOutcome` is `unknown`, inspect `reels list-projects` before doing anything else.
   - Keep each `backupPath`.
4. **Report.** List the merged cards (card → project, evidence, backup path) and the cards you left alone (with the reason and what the user should decide). Run `reels scan-orphan-edits` again and confirm that the only cards left are the ones you chose to leave.

Do not rename cards, change stage or publication, edit content documents, move or delete media, or create projects. A card you left alone stays as it is until the user decides.
