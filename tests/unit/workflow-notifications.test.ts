import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WorkflowNotifications,
  WorkflowTransitions,
  type WorkflowNotice,
} from "../../src/desktop/workflow-notifications";
import type { WorkflowRun, SdkJob } from "../../src/shared/workflow";

const at = "2026-11-02T03:00:00.000Z";
const run = (id: string, status: SdkJob["status"], createdAt = at) =>
  ({
    runId: `run-${id}`,
    title: `Synthetic workflow ${id}`,
    execution: {
      id: `job-${id}`,
      taskId: `task-${id}`,
      runId: `run-${id}`,
      status,
      createdAt,
    },
  }) as WorkflowRun;

test("initial completed jobs are baseline; new and observed transitions notify once per job", () => {
  const state = new WorkflowTransitions();
  const now = Date.parse(at);
  assert.deepEqual(
    state.update([run("old", "completed"), run("active", "running")], now),
    [],
  );
  const notices = state.update(
    [
      run("old", "completed"),
      run("active", "completed"),
      run("fast", "failed"),
    ],
    now + 1000,
  );
  assert.deepEqual(
    notices.map((n) => n.jobId),
    ["job-active", "job-fast"],
  );
  assert.deepEqual(
    state.update([run("active", "completed"), run("fast", "failed")]),
    [],
  );
  state.update([run("active", "running")]);
  assert.deepEqual(state.update([run("active", "completed")]), []);
  assert.deepEqual(
    state.update([run("historical", "completed", "2020-01-01T00:00:00Z")]),
    [],
  );
  assert.deepEqual(state.update([run("cancelled", "cancelled")]), []);
});

test("task identity, interrupted jobs and mismatched run IDs stay distinct", () => {
  const state = new WorkflowTransitions();
  state.update([run("a", "running")], Date.parse(at));
  const next = run("a", "interrupted");
  assert.equal(state.update([next])[0]?.status, "interrupted");
  const wrong = run("b", "failed");
  wrong.execution!.runId = "another-run";
  assert.deepEqual(state.update([wrong]), []);
});

test("inactive transitions group notices, badge and click route; focus clears unread", async () => {
  let runs = [run("a", "running"), run("c", "running")];
  let focused = false;
  const badges: number[] = [];
  const shown: { notice: WorkflowNotice; count: number; click: () => void }[] =
    [];
  const opened: string[] = [];
  const monitor = new WorkflowNotifications({
    enabled: true,
    list: async () => ({ runs }),
    isActive: () => focused,
    setBadge: (count) => badges.push(count),
    open: (id) => opened.push(id),
    notify: (notice, count, click) => shown.push({ notice, count, click }),
  });
  await monitor.poll();
  runs = [run("a", "completed"), run("c", "failed"), run("b", "running")];
  await monitor.poll();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].count, 2);
  assert.deepEqual(badges, [2]);
  shown[0].click();
  assert.deepEqual(opened, ["run-c"]);
  assert.deepEqual(badges, [2, 0]);
  focused = true;
  runs = [run("a", "completed"), run("b", "failed")];
  await monitor.poll();
  focused = false;
  await monitor.poll();
  assert.equal(
    shown.length,
    1,
    "foreground results never become late notifications",
  );
  monitor.dispose();
});

test("background QA disables polling, OS notifications, badge and focus effects", async () => {
  const calls: string[] = [];
  const monitor = new WorkflowNotifications({
    enabled: false,
    list: async () => {
      calls.push("list");
      return { runs: [] };
    },
    isActive: () => {
      calls.push("active");
      return false;
    },
    notify: () => {
      calls.push("notify");
    },
    setBadge: () => {
      calls.push("badge");
    },
    open: () => {
      calls.push("open");
    },
  });
  monitor.start();
  await monitor.poll();
  monitor.clearUnread();
  monitor.dispose();
  assert.deepEqual(calls, []);
});

test("polls never overlap; failed reads preserve the baseline; disposal ignores an in-flight result", async () => {
  let finish!: (value: { runs: WorkflowRun[] }) => void;
  let calls = 0;
  let fail = false;
  const shown: WorkflowNotice[] = [];
  const monitor = new WorkflowNotifications({
    enabled: true,
    list: async () => {
      calls++;
      if (fail) throw new Error("offline");
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    isActive: () => false,
    notify: (n) => shown.push(n),
    setBadge: () => {},
    open: () => {},
  });
  const first = monitor.poll();
  await monitor.poll();
  assert.equal(calls, 1);
  finish({ runs: [run("a", "running")] });
  await first;
  fail = true;
  await monitor.poll();
  fail = false;
  const second = monitor.poll();
  finish({ runs: [run("a", "failed")] });
  await second;
  assert.equal(shown.length, 1);
  const third = monitor.poll();
  monitor.dispose();
  finish({ runs: [run("b", "completed")] });
  await third;
  assert.equal(shown.length, 1);
});
