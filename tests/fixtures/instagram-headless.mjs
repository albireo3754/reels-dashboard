// Test-only process preload. The production CLI has no mock API option.
import { appendFile, access, writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.env.REELS_USER_DATA;
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  await appendFile(path.join(root, "test-api-calls"), url.pathname + "\n");
  const failure = process.env.INSTAGRAM_TEST_FAILURE;
  if (failure === "network")
    throw new Error(
      "https://credential.example/?access_token=synthetic-private-token",
    );
  if (failure)
    return Response.json(
      {
        error: {
          code: Number(failure),
          message:
            "https://credential.example/?access_token=synthetic-private-token",
        },
      },
      { status: failure === "4" ? 429 : failure === "190" ? 401 : 403 },
    );
  if (url.pathname.endsWith("/assigned_instagram_accounts"))
    return Response.json({ data: [{ id: "1", username: "creator_demo" }] });
  if (url.pathname.endsWith("/1"))
    return Response.json({ id: "1", username: "creator_demo" });
  if (url.pathname.endsWith("/media"))
    return Response.json({
      data: [
        {
          id: "2",
          permalink: "https://www.instagram.com/reel/Synthetic/",
          timestamp: "2026-11-01T00:00:00Z",
          media_type: "VIDEO",
          media_product_type: "REELS",
        },
      ],
    });
  if (process.env.INSTAGRAM_TEST_GATE === "1") {
    await writeFile(path.join(root, "test-api-ready"), "ready");
    while (
      await access(path.join(root, "test-api-release")).then(
        () => false,
        () => true,
      )
    ) {
      init.signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return Response.json({
    data: url.searchParams
      .get("metric")
      .split(",")
      .map((name) => ({ name, values: [{ value: 250 }] })),
  });
};
