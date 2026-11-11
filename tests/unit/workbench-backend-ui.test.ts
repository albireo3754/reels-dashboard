import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptsInput,
  appExitNote,
  backendLockReason,
  backendLocked,
  backendStatus,
  canReattach,
  closeTitle,
  herdrMissingNotice,
  metaAction,
  sessionStateLabel,
} from "../../src/features/dev-workspace/model/backend";
import type {
  TerminalBackendState,
  WorkTerminal,
} from "../../src/shared/workbench";

const term = (over: Partial<WorkTerminal> = {}): WorkTerminal => ({
  id: "t",
  kind: "shell",
  title: "터미널",
  cwd: "/repo",
  backend: "direct",
  state: "running",
  startedAt: "2026-11-10T00:00:00Z",
  ...over,
});
const backend = (over: Partial<TerminalBackendState> = {}): TerminalBackendState => ({
  selected: "herdr",
  effective: "herdr",
  herdrInstalled: true,
  session: "default",
  forcedByEnv: false,
  checking: false,
  ...over,
});

test("session state labels and branches cover running, detached and exited", () => {
  assert.equal(sessionStateLabel(term()), "실행 중");
  assert.equal(sessionStateLabel(term({ state: "detached", backend: "herdr" })), "연결 끊김");
  assert.equal(sessionStateLabel(term({ state: "exited", exitCode: 2 })), "종료 2");
  assert.equal(sessionStateLabel(term({ state: "exited" })), "종료");
  assert.equal(acceptsInput(term()), true);
  assert.equal(acceptsInput(term({ state: "detached", backend: "herdr" })), false);
  assert.equal(acceptsInput(term({ state: "exited" })), false);
  assert.equal(acceptsInput(undefined), false);
  assert.equal(metaAction(term()), "stop");
  assert.equal(metaAction(term({ state: "detached", backend: "herdr" })), "stop");
  assert.equal(metaAction(term({ state: "exited" })), "remove");
});

test("only a detached herdr session can be reattached", () => {
  assert.equal(canReattach(term({ state: "detached", backend: "herdr" })), true);
  assert.equal(canReattach(term({ backend: "herdr" })), false);
  assert.equal(canReattach(term({ state: "exited", backend: "herdr" })), false);
  assert.equal(canReattach(term({ state: "detached" })), false);
  assert.match(closeTitle(term({ backend: "herdr" })), /herdr 세션을 종료/);
  assert.match(closeTitle(term()), /프로세스를 종료/);
});

test("backend choice is locked by env or live sessions and explains why", () => {
  assert.equal(backendLocked([term({ state: "exited" })]), false);
  assert.equal(backendLocked([term({ state: "detached", backend: "herdr" })]), true);
  assert.equal(backendLockReason(backend(), []), "");
  assert.match(backendLockReason(backend({ forcedByEnv: true }), []), /REELS_TERMINAL_BACKEND/);
  assert.match(backendLockReason(backend(), [term()]), /종료한 뒤/);
  assert.equal(herdrMissingNotice(backend({ herdrInstalled: false, effective: "direct" })), true);
  assert.equal(herdrMissingNotice(backend({ selected: "direct", herdrInstalled: false, effective: "direct" })), false);
  assert.equal(herdrMissingNotice(backend()), false);
});

test("app exit note no longer claims every session ends", () => {
  assert.match(appExitNote(backend(), []), /앱을 종료해도 유지/);
  assert.equal(
    appExitNote(backend({ effective: "direct" }), [term()]),
    "앱을 종료하면 모든 세션이 종료돼요.",
  );
  assert.match(
    appExitNote(backend({ effective: "direct" }), [term({ backend: "herdr" })]),
    /앱을 종료해도 유지/,
  );
});

test("while herdr is being checked or is disabled, the status does not claim a backend or a missing install", () => {
  const checking = backend({ checking: true, herdrInstalled: false, effective: "direct" });
  assert.match(backendStatus(checking), /확인 중/);
  assert.equal(herdrMissingNotice(checking), false);
  assert.equal(backendStatus(backend()), "새 쉘·코딩 도구 세션: herdr 세션");
  assert.equal(backendStatus(backend({ effective: "direct" })), "새 쉘·코딩 도구 세션: 직접 실행");
  const disabled = backend({ effective: "direct", error: "REELS_HERDR_SESSION 값이 올바르지 않아요." });
  assert.equal(herdrMissingNotice({ ...disabled, herdrInstalled: false }), false);
  assert.equal(backendStatus(disabled), "새 쉘·코딩 도구 세션: 직접 실행");
});
