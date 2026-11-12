# Photo-first drafting

Photo selection belongs at the start of `draft`, after experience answers and follow-up work, before prose/group review. `prepare` inventories relevant owned scenes; `layout` inherits their selected order and grouping and refines crop/size/format. No new graph stage, user approval step, or fixed photo count is introduced.

## Preparation

Data extraction precedes editorial selection. Inventory the complete relevant capture set and all existing individual frames/photos, including scenes not chosen for publication. Keep source/frame/result identities and latest user corrections; do not reduce an already extracted frame set to three samples. The [complete evidence segment](media-evidence.md) provides manifest validation, batch analysis and expected/resolved/missing/failed checks. Verify semantic corrections separately before reducing those results to scenes. A complete result count does not establish complete photo-library coverage or correct interpretation.

For a photo-based new article/full composition, inspect actual previews alongside analysis descriptions, OCR and user corrections, including useful scenes outside the existing shortlist. Similar shots may share one scene. Submit **one** `media-scenes.json` in preparation evidence (or initial tracked inputs):

```json
{
  "version": 1,
  "scenes": [
    {"id":"arrival","source":"CLIP_01@0.2","preview":"media/arrival.jpg","observed":"Entrance and people outside"},
    {"id":"detail","source":"PHOTO_02","preview":"media/detail.jpg","observed":"Object detail"}
  ]
}
```

`preview` is **workspace-root relative**, including for manifests saved in `.workflow-results/<job>/`. This differs from Markdown image links, which are relative to the Markdown file. Invalid preview errors name the workspace-root rule; there is no alternate-path fallback. Files with JPEG/PNG/WebP extensions must exist inside the workspace (at most 4 MB each). They are automatically tracked and hashed; file checks do not decode image content. Optional scene `contextNotes` preserve verified place relationships/capture context and their source attribution separately from `observed`. Do not discard these relationships when reducing saved analysis to a scene inventory. `source` is an original filename/capture ID plus time reference; originals are not copied, opened or hashed by this validator.

One inventory path per run avoids ambiguous snapshots. Update that file and explicitly restart a pending task when its evidence changes, rather than tracking a second inventory. A run may receive its inventory with preparation evidence or its initial tracked inputs, including a shared-form run.

## Draft composition

After checking existing evidence and answers, ask the user when an unresolved scene meaning, place relationship, personal experience or intent materially affects composition. Ask through the existing form or current conversation; do not silently omit a useful scene or invent experience. Continue independent work while awaiting the answer, and preserve unknown/omit choices. Clarification can recur during drafting/review, not only during initial intake.

Read all scene previews and confirmed user experience before writing prose. References guide wording and sentence development; they do not supply the user's experiences or an obligatory scene order. Submit `story-media-plan.json` together with the photo-linked draft:

```json
{
  "version": 1,
  "inventory": "evidence/media-scenes.json",
  "decisions": [
    {"sceneId":"arrival","decision":"use","reason":"Establishes the visit location","handling":"Keep frame","group":"visit","role":"Location context","experienceRefs":["answers.md#arrival"]},
    {"sceneId":"detail","decision":"hold","reason":"Not needed in this draft","handling":"Retain original","resolveWhen":"Reconsider if the user adds a relevant detail experience"}
  ]
}
```

The `inventory` must exactly match a key in the task’s `inputHashes`; copy that workspace-relative path verbatim. Every scene has one `use`, `omit` or `hold` decision with a reason and separate image-handling judgment. `use` requires a group and narrative role. The order of used decisions is the display order; a shared group indicates a pair/group. `hold` means unused in this draft with an explicit reconsideration condition, not an unresolved barrier to submission. Missing information that prevents drafting uses the existing `blocked` outcome. All-omit plans are valid: coverage is consideration, not forced inclusion. The validator does not enforce a count, but the `draft` instruction asks for the fullest composition first (2026-11-12 user direction): use every distinct kind of shot, omit only for burst/same-scene duplicates, faces that a rose sticker or crop cannot hide, or a false factual implication, and turn motion clips into silent GIFs (`reels_convert_gif`, whole length) in the draft instead of asking whether to include them. `review` sends a plan back to composition when it omits scenes for other reasons or defers a motion clip to a question or `hold`. Experience references are descriptive and do not require an intake form.

Draft submission with an inventory requires a valid plan. Unknown/duplicate/missing scene IDs, a mismatched inventory, changed inventory/previews and missing files fail before advancing. Revised plans are validated when submitted; wording-only revisions reuse the latest successful plan, checking its hash and coverage against the frozen inventory/previews. An explicit restart refreshes preview tracking; a changed inventory still needs a compatible plan. The schema is [story-media.ts](../src/shared/story-media.ts), file checks are in [workflow/story-media.ts](../src/app/workflow/story-media.ts).

## Review and layout

Before group prose review, the composition owner checks that the selected scenes appear in the draft and that omitted scenes have substantive reasons. Text-only reviewers receive IDs, roles and context; they do not claim to have seen images. A text-review pass does not certify media composition or rendering.

Layout preserves plan choices, order and groups. Associate output media with `sceneId`; document any changed selection/grouping by scene ID and reason in the existing layout report. No second layout submission gate is added. Face/plate handling and scene usefulness are separate decisions, not a universal omission or blur rule. Layout checks actual images at the affected viewport sizes.

## Scope and limits

The manifest opts the run into structural checks, independent of `collectExperience`. Existing runs without one and text-only work retain their behavior; no live run is rewound. A workflow that omits the inventory entirely is not detected by the machine validator. The preparation/composition procedure must catch that omission for photo-based full work. Do not claim this validates complete photo-library coverage, actual image inspection, good editorial decisions, or automatic selection of a particular scene. Simple edits do not require redoing the full inventory.

Handler semantics use workflow protocol **2**. A running protocol-1 server must be updated before these submission checks are available there; changing source files does not update that process. No installed app/server restart or article rewrite is implicit in this code change.
