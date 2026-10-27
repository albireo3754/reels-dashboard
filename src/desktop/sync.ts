import type { Dashboard } from "../shared/contracts";
import { toSnapshot } from "../shared/data";
export async function syncSnapshot(
  dashboard: Dashboard,
  endpoint: unknown,
  token: unknown,
  transport: typeof fetch = fetch,
) {
  if (
    typeof endpoint !== "string" ||
    typeof token !== "string" ||
    token.length > 8192
  )
    throw new Error("Invalid connection");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("HTTPS endpoint required");
  const snapshot = toSnapshot(dashboard);
  const response = await transport(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(token ? { "OAI-Sites-Authorization": `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(snapshot),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(`Snapshot sync failed (${response.status})`);
  return { generatedAt: snapshot.generatedAt, count: snapshot.projects.length };
}
