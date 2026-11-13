import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContentLibrary } from "../../src/features/content-library";
import { startAgentSocket } from "../../src/shared/lib/agent-socket";
import { LocalStore } from "../../src/shared/lib/storage";

// Built by `npm run build:desktop`; run through `npm run test:cli`.
const configured = process.env.REELS_CLI_BUNDLE;
const built = configured ? path.resolve(configured) : "";

function runBundle(
  bundle: string,
  cwd: string,
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
) {
  return new Promise<{ code: number | null; document: any }>((resolve) => {
    const child = spawn(bundle, args, {
      cwd,
      env: { PATH: process.env.PATH, REELS_USER_DATA: root, ...env },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
    child.on("close", (code) =>
      resolve({ code, document: JSON.parse(stdout) }),
    );
  });
}

test(
  "a copy of the bundle runs with no node_modules in reach",
  { skip: !built },
  async () => {
    const cwd = await realpath(
      await mkdtemp(path.join(tmpdir(), "reels-bundle-")),
    );
    const root = path.join(cwd, "user-data");
    // Node resolves imports from the file's own location, so the copy is what
    // proves nothing is left to the repository's node_modules.
    const bundle = path.join(cwd, "reels.mjs");
    const reels = (folder: string, data: string, args: string[]) =>
      runBundle(bundle, folder, data, args);
    try {
      assert.ok((await stat(built)).mode & 0o100);
      assert.equal(
        (await readFile(built, "utf8")).split("\n")[0],
        "#!/usr/bin/env node",
      );
      await copyFile(built, bundle);
      await chmod(bundle, 0o755);
      await assert.rejects(stat(path.join(cwd, "node_modules")));

      const status = await reels(cwd, root, ["status"]);
      assert.equal(status.code, 0);
      assert.equal(status.document.data.app.reason, "no_connection_file");

      // A temp HOME, so doctor never looks at the real ~/.local/bin.
      const home = path.join(cwd, "home");
      const doctor = await runBundle(bundle, cwd, root, ["doctor"], {
        HOME: home,
      });
      assert.equal(doctor.code, 0);
      assert.equal(doctor.document.data.healthy, false);
      assert.equal(doctor.document.data.cli.bundle, bundle);
      assert.equal(doctor.document.data.app.reason, "no_connection_file");
      assert.equal(doctor.document.data.launcher.state, "missing");
      assert.equal(doctor.document.data.checks[0].ok, true);
      await assert.rejects(stat(home));

      // The guide is embedded at build time; the copy has no skills/ to read.
      const guide = await reels(cwd, root, ["help", "agent"]);
      assert.equal(guide.code, 0);
      assert.equal(
        guide.document.data.guide,
        await readFile("skills/reels-cli/SKILL.md", "utf8"),
      );
      assert.equal(guide.document.data.name, "reels-cli");
      await assert.rejects(stat(path.join(cwd, "skills")));

      const tools = await reels(cwd, root, ["tools"]);
      assert.equal(tools.code, 0);
      assert.ok(tools.document.data.count > 0);

      const offline = await reels(cwd, root, ["get-app-state"]);
      assert.equal(offline.code, 3);

      const close = await startAgentSocket(root, async (name) => ({ name }));
      try {
        const online = await reels(cwd, root, ["call", "reels_get_app_state"]);
        assert.equal(online.code, 0);
        assert.equal(online.document.data.name, "reels_get_app_state");
      } finally {
        await close();
      }

      const source = path.join(cwd, "source", "clip.mov");
      await writeFile(
        path.join(cwd, "selection.json"),
        JSON.stringify([source]),
      );
      await mkdir(path.dirname(source));
      await writeFile(source, "synthetic");
      const store = new LocalStore(root);
      await store.initialize();
      await new ContentLibrary(store).upsert(
        {
          id: "sample",
          title: "Sample",
          date: "2026-11-02",
          dateBasis: "capture",
          localNotes: "",
          stage: "captured",
          nextAction: "",
          publicURL: "",
          resources: [{ role: "footage", path: source, label: "source" }],
        },
        (await store.load()).updatedAt,
      );
      const copied = await reels(cwd, root, [
        "prepare-media",
        "--project-id",
        "sample",
        "--selection",
        "selection.json",
        "--destination",
        path.join(cwd, "copy"),
      ]);
      assert.equal(copied.code, 0);
      assert.equal(
        await readFile(copied.document.data.entries[0].path, "utf8"),
        "synthetic",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

/** `ulimit -f` caps file writes, the closest safe stand-in for a full disk. */
function runLimited(cwd: string, root: string, args: string[], redirect = "") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(
        "/bin/sh",
        ["-c", `ulimit -f 1; exec "$@"${redirect}`, "sh", built, ...args],
        {
          cwd,
          env: { PATH: process.env.PATH, REELS_USER_DATA: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
      child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

test(
  "a redirected stdout that cannot be finished is not a success",
  { skip: !built },
  async () => {
    const cwd = await realpath(
      await mkdtemp(path.join(tmpdir(), "reels-bundle-limit-")),
    );
    try {
      const result = await runLimited(
        cwd,
        path.join(cwd, "data"),
        ["tools"],
        " > big.out",
      );
      assert.equal(result.code, 11);
      assert.match(result.stderr, /could not write stdout/);
      assert.equal(result.stderr.split("\n").length, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "an image cut off by a file limit leaves no file, so the retry works",
  { skip: !built },
  async () => {
    const cwd = await realpath(
      await mkdtemp(path.join(tmpdir(), "reels-bundle-image-")),
    );
    const root = path.join(cwd, "data");
    const image = Buffer.alloc(4096, 7);
    const close = await startAgentSocket(root, async () => ({
      image: `data:image/png;base64,${image.toString("base64")}`,
    }));
    const args = [
      "preview-frame",
      "--project-id",
      "11111111-1111-4111-8111-111111111111",
      "--expected-updated-at",
      "2026-10-27T00:00:00.000Z",
      "--kind",
      "cover",
      "--out",
      "cover.png",
    ];
    try {
      const failed = await runLimited(cwd, root, args);
      assert.equal(failed.code, 11);
      const { error } = JSON.parse(failed.stdout);
      assert.equal(error.code, "OUTPUT_WRITE_FAILED");
      assert.equal(error.retry, "safe");
      assert.deepEqual(
        (await readdir(cwd)).filter((name) => name !== "data"),
        [],
      );
      const retried = await runBundle(built, cwd, root, args);
      assert.equal(retried.code, 0);
      assert.deepEqual(await readFile(path.join(cwd, "cover.png")), image);
    } finally {
      await close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "a deleted working folder does not break status",
  { skip: !built },
  async () => {
    const parent = await realpath(
      await mkdtemp(path.join(tmpdir(), "reels-bundle-gone-")),
    );
    try {
      const folder = path.join(parent, "gone");
      await mkdir(folder);
      const script = `cd "$1" && rmdir "$1" && shift && exec "$@"`;
      const { code, stdout } = await new Promise<{
        code: number | null;
        stdout: string;
      }>((resolve) => {
        const child = spawn(
          "/bin/sh",
          ["-c", script, "sh", folder, process.execPath, built, "status"],
          {
            env: {
              PATH: process.env.PATH,
              REELS_USER_DATA: path.join(parent, "data"),
            },
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        let text = "";
        child.stdout.setEncoding("utf8").on("data", (part) => (text += part));
        child.on("close", (exit) => resolve({ code: exit, stdout: text }));
      });
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).data.app.online, false);

      // A relative profile needs the working folder, and status still answers.
      const relative = path.join(parent, "gone-too");
      await mkdir(relative);
      const unresolved = await new Promise<string>((resolve) => {
        const child = spawn(
          "/bin/sh",
          ["-c", script, "sh", relative, process.execPath, built, "status"],
          {
            env: { PATH: process.env.PATH, REELS_USER_DATA: "relative" },
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        let text = "";
        child.stdout.setEncoding("utf8").on("data", (part) => (text += part));
        child.on("close", () => resolve(text));
      });
      assert.equal(
        JSON.parse(unresolved).data.app.reason,
        "user_data_unresolved",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
