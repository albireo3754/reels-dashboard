# Read-only local object storage

`LocalObjectStore` provides `headObject`, bounded `getObject` byte ranges and paginated `listObjects` for explicitly registered local media. It is an S3-shaped SDK, not an S3 HTTP/SigV4 server or a claim of full AWS SDK compatibility. The current remote viewer uses HEAD/GET and Range through a private HTTPS relay; original files remain in their existing iCloud/Photos-export locations.

Object keys are opaque SHA-256 IDs mapped to canonical paths only on the Mac. Callers cannot submit filesystem paths to `getObject`. Reads validate the registered fingerprint and disallow a replacement symlink. No write/delete operation exists. `projectSnapshot` projects production records returned by the app MCP and omits local paths and private notes. It includes all entries for the explicitly requested owner-private briefing without changing the app's shared flags.

The bridge in `scripts/mobile-briefing/bridge.mjs` reads its Sites credential from macOS Keychain, syncs metadata every minute, heartbeats every ten seconds and polls requested file chunks. It calls the app through stdio MCP. The private Sites database keeps the last completed metadata generation when the Mac is offline; R2 holds requested chunks temporarily until consumed or expired.
