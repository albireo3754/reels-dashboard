# Rosy production briefing

A mobile-first, access-controlled Sites dashboard for production progress and on-demand local/iCloud file access. See [architecture and data boundaries](docs/architecture.md).

- Sites D1 stores relational metadata and sync history; R2 is temporary relay storage.
- Desktop originals stay in place. The Mac bridge uses stdio MCP for metadata and a read-only object SDK for registered files.
- Browser views: briefing, content search/stage filters, capture collections, resource details, synchronized caption/comment/reply text with copy buttons, and online media previews when enabled.
- Source metadata is never bundled in the site or migrations.

Develop in the Reels Dashboard monorepo. Build the Site with `npm run build` and run `npm run test:built` from this directory. The standalone Sites checkout is the release projection. The `DB`/`BUCKET` bindings are declared in `.openai/hosting.json`. Generate schema-only migrations with `npm run db:generate`. `BRIDGE_SECRET` is a production runtime secret. A local `.dev.vars` may use a synthetic fixture key for local-only QA.

Deployment verification does not establish PostgreSQL hosting, native Sites tunnel registration, full S3 protocol compatibility or media availability while the Mac is asleep. The actual implementation and limits are recorded in the architecture document.

- Capture route maps are part of content details: time-indexed pins, photo/video filtering, candidate routes and uncertainty controls. The same bounded DTO is projected by the desktop bridge and saved with each snapshot; original-file reads remain separately gated. See [route synchronization](docs/architecture.md#capture-route-synchronization--2026-10-31).

- Home-screen web app: standalone manifest, branded icons, install guidance and a private-data-free offline page. See [installation, connection behavior and QA limits](docs/home-screen.md). Source/API/media responses are never persisted by the service worker.

- Desktop monitoring parity: compact work-first dashboard, canonical weekly goals/booking queue/today pick, channel-aware project state and work-order navigation. See [the contract and verification](docs/architecture.md#desktop-monitoring-parity--2026-11-17).

- Low-resolution video playback: open a content detail and choose **미리보기 재생** on a registered video. See [the preview switch, relay contract and local QA](docs/architecture.md#low-resolution-video-previews).

- Today-pick Paseo request copy: a fixed request with only the validated target and snapshot time, no server write or execution. See [the boundary and checks](docs/architecture.md#paseo-request-copy--2026-11-20).

- Mobile instructions (지시하기): shared, same-origin, rate-limited instruction queue open to anyone the Site lets in; the Mac bridge claims it atomically and status and plain-text results return to the Site. Off unless `INSTRUCTIONS_ENABLED=true`. See [the API, limits and checks](docs/architecture.md#mobile-instructions--2026-11-21).
