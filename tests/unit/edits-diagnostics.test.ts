import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAgentSocket, callAgent } from "../../src/shared/lib/agent-socket";
import {
  editsErrorDetails,
  type TreeDiagnostics,
} from "../../src/shared/edits";
import { agentFailure, failureDocument } from "../../src/app/cli/outcome";
import { mcpError } from "../../src/shared/mcp-result";

const diagnostics: TreeDiagnostics = {
  counts: { "attributes-read-error": 1 },
  samples: [
    {
      reason: "attributes-read-error",
      root: "application",
      path: [0, 1, 3],
      axErrorCode: -25200,
      axAPI: "AXUIElementCopyAttributeValue",
      axAttribute: "AXSubrole",
    },
  ],
  samplesOmitted: 0,
  confirmedAbsentSubroles: 0,
  confirmedAbsentSubroleSamples: [],
};

test("Edits error diagnostics survive the private socket, CLI and MCP without arbitrary details", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edits-diagnostics-test-"));
  const stop = await startAgentSocket(root, async () => {
    throw Object.assign(new Error("AX_ACTION_FORBIDDEN: incomplete tree"), {
      code: "AX_ACTION_FORBIDDEN",
      details: {
        diagnostics,
        after: { diagnostics, nodes: ["must-not-leak"] },
        axErrorCode: -25200,
        axAPI: "AXUIElementCopyAttributeValue",
        axAttribute: "AXSubrole",
        secret: "must-not-leak",
      },
    });
  });
  try {
    let failure: unknown;
    try {
      await callAgent(root, "reels_edits_ax_press", {});
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.deepEqual(
      (failure as Error & { details: any }).details.diagnostics,
      diagnostics,
    );
    const cli = agentFailure(failure, () => ({}));
    const document = failureDocument(cli, {
      tool: "reels_edits_ax_press",
      readOnly: false,
    });
    assert.deepEqual(document.document.error.diagnostics, diagnostics);
    assert.deepEqual(document.document.error.after, { diagnostics });
    const mcp = mcpError(failure);
    assert.equal(mcp.isError, true);
    assert.equal(
      (mcp.structuredContent as any).error.code,
      "AX_ACTION_FORBIDDEN",
    );
    assert.deepEqual(
      (mcp.structuredContent as any).error.details.diagnostics,
      diagnostics,
    );
    assert.doesNotMatch(
      JSON.stringify([document, mcp]),
      /must-not-leak|secret/,
    );
    await assert.rejects(
      callAgent(root, "reels_get_app_state", {}),
      (error) => {
        assert.equal((error as any).details, undefined);
        return true;
      },
    );
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic projection rejects unknown reasons and bounds samples", () => {
  assert.deepEqual(editsErrorDetails({ diagnostics, secret: "omit" }), {
    diagnostics,
  });
  assert.equal(
    editsErrorDetails({
      diagnostics: {
        ...diagnostics,
        samples: Array(17).fill(diagnostics.samples[0]),
      },
    }),
    undefined,
  );
  assert.equal(
    editsErrorDetails({
      diagnostics: {
        ...diagnostics,
        samples: [{ ...diagnostics.samples[0], reason: "private-value" }],
      },
    }),
    undefined,
  );
});

test("partial execution attempt and coordinate mode survive socket to CLI/MCP with a safe enum", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edits-partial-outcome-"));
  let attempted = true,
    fallback: "coordinate" | null = "coordinate";
  const stop = await startAgentSocket(root, async () => {
    throw Object.assign(new Error("AX_OUTCOME_UNKNOWN: inspect before retry"), {
      code: "AX_OUTCOME_UNKNOWN",
      details: {
        attempted,
        fallback,
        outcome: "unknown",
        secret: "must-not-leak",
      },
    });
  });
  try {
    for (const partial of [true, false]) {
      attempted = partial;
      fallback = partial ? "coordinate" : null;
      let error: unknown;
      try {
        await callAgent(root, "reels_edits_ax_press", {});
      } catch (e) {
        error = e;
      }
      assert.ok(error instanceof Error);
      const cli = failureDocument(
        agentFailure(error, () => ({})),
        { tool: "reels_edits_ax_press", readOnly: false },
      ).document;
      assert.equal(cli.error.attempted, attempted);
      assert.equal(cli.error.fallback, fallback);
      assert.equal(cli.error.outcome, "unknown");
      const mcp = mcpError(error),
        details = (mcp.structuredContent as any).error.details;
      assert.equal(details.attempted, attempted);
      assert.equal(details.fallback, fallback);
      assert.equal(details.outcome, "unknown");
      assert.doesNotMatch(JSON.stringify([cli, mcp]), /must-not-leak|secret/);
    }
    assert.equal(editsErrorDetails({ attempted: "true" }), undefined);
    assert.equal(editsErrorDetails({ fallback: "keyboard" }), undefined);
    assert.deepEqual(
      editsErrorDetails({ attempted: false, fallback: null, secret: "omit" }),
      { attempted: false, fallback: null },
    );
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
