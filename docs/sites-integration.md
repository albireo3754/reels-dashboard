# Shared renderer and ChatGPT Sites

The production web build and the Electron app use the same React dashboard and versioned data contract. Desktop-only operations are supplied through `DashboardBridge`; the normal browser adapter is read-only and never imports Electron or Node modules.

## Static Site

1. In the desktop dashboard, select the projects to share and export `snapshot.json`.
2. Put that file at `public/snapshot.json` in a deployment checkout. Do not commit personal snapshots to this public repository.
3. Run `npm run build:web` and deploy the resulting `dist/` directory as a static Site using the Sites workflow. Preserve the intended access policy (initially private).
4. The shared renderer loads `snapshot.json` and shows its timestamp. Missing, malformed, or unavailable data produces an explicit error; it never falls back to demonstration data.

`?demo=1` is explicitly synthetic development/demo mode. It is not a connection to the desktop or the user's Photos library.

## Update endpoint

The desktop also supports a configured HTTPS update endpoint. It sends a `PUT` with `Content-Type: application/json` and the same snapshot body. When supplied, the transient service credential is sent as `OAI-Sites-Authorization: Bearer …`. Redirects are rejected to avoid forwarding the credential to another destination, and requests have a timeout.

A hosted receiving app must implement this endpoint and persist the snapshot (for example in Sites R2), serve it back to the web renderer, and enforce its access policy. A static Site alone does not implement PUT or a database. A 2xx response is the endpoint's acknowledgement; the application does not invent a live Site deployment or verify a remote database commit from that response.

Sites private service access and any data-write authorization must be configured for the selected Site. Never place credentials in public frontend code, committed snapshots, or local source configuration. The desktop does not save the token.

## Snapshot v1

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-27T00:00:00.000Z",
  "projects": [
    {
      "id": "example-project",
      "title": "Example production",
      "date": "2026-10-27",
      "stage": "editing",
      "nextAction": "Review the opening shot",
      "publicURL": "https://example.com/production"
    }
  ]
}
```

Only explicitly shared projects are exported. The export selects fields rather than copying the desktop records wholesale. Source asset IDs, local paths, OCR, precise location, evidence, plan files and recovery journals are excluded. User-authored titles and next actions remain visible to the selected Site audience.

This repository provides the reusable renderer and the connection contract. Deploying a particular Site and provisioning its receiver are separate operations and are not claimed as completed by browser fixture tests.
