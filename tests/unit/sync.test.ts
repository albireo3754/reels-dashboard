import test from "node:test";
import assert from "node:assert/strict";
import { syncSnapshot } from "../../src/desktop/sync";
import type { Dashboard } from "../../src/shared/contracts";
const dashboard: Dashboard = {
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  projects: [
    {
      id: "one",
      title: "Shared",
      date: "2026-01-01",
      stage: "review",
      nextAction: "Review",
      publicURL: "",
      shared: true,
    },
    {
      id: "two",
      title: "Private",
      date: "2026-01-01",
      stage: "idea",
      nextAction: "",
      publicURL: "",
      shared: false,
    },
  ],
};
test("HTTPS receiver contract sends only selected public fields and prevents credential redirect", async () => {
  let called = 0;
  const transport: typeof fetch = async (url, options) => {
    called++;
    assert.equal(String(url), "https://example.com/api/snapshot");
    assert.equal(options?.method, "PUT");
    assert.equal(options?.redirect, "error");
    assert.equal(
      new Headers(options?.headers).get("OAI-Sites-Authorization"),
      "Bearer test-only-credential",
    );
    const body = JSON.parse(String(options?.body));
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].title, "Shared");
    assert.equal(body.projects[0].shared, undefined);
    return new Response(null, { status: 204 });
  };
  const result = await syncSnapshot(
    dashboard,
    "https://example.com/api/snapshot",
    "test-only-credential",
    transport,
  );
  assert.equal(result.count, 1);
  assert.equal(called, 1);
});
test("rejects insecure endpoints and receiver failures rather than reporting sync success", async () => {
  await assert.rejects(
    syncSnapshot(dashboard, "http://example.com", "", async () => {
      throw new Error("must not call");
    }),
    /HTTPS/,
  );
  await assert.rejects(
    syncSnapshot(
      dashboard,
      "https://example.com",
      "",
      async () => new Response(null, { status: 403 }),
    ),
    /403/,
  );
});
