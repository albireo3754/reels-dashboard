import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createAgentDispatch,
  toolDefinitions,
  type AgentPorts,
} from "../../src/features/agent-tools";
import { AgentSession } from "../../src/entities/agent-session";
import {
  ContentLibrary,
  mediaExtensions,
} from "../../src/features/content-library";
import { callAgent, startAgentSocket } from "../../src/shared/lib/agent-socket";
import { LocalStore } from "../../src/shared/lib/storage";
import { cliLauncher } from "../../src/shared/cli-launcher";
import type { RenderJob } from "../../src/shared/editor";
import { exitCodes } from "../../src/app/cli/outcome";
import {
  builtinCommands,
  builtins,
  helpTopics,
  run,
} from "../../src/app/cli/run";
import {
  cliOptions,
  parseToolArgs,
  propertyFlag,
  readToolInput,
  reservedOptions,
  toolExample,
  toolFlags,
  toolNames,
  toolSlug,
  toolUsage,
  type CliIO,
} from "../../src/app/cli/tool-command";
import {
  toolGroupIds,
  toolGroupOf,
  toolGroups,
} from "../../src/app/cli/tool-groups";

const toolSlugs = toolNames.map(toolSlug);
const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const formId = "33333333-3333-4333-8333-333333333333";
const revision = "2026-10-27T00:00:00.000Z";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);
const updateArgs = [
  "update-project",
  "--project-id",
  projectId,
  "--expected-updated-at",
  revision,
  "--patch",
  '{"cover":{"time":1}}',
];
const renderArgs = [
  "start-render",
  "--project-id",
  projectId,
  "--expected-updated-at",
  revision,
  "--target",
  "video",
  "--output-path",
  "/absolute/new.mov",
];
const job = (state: string, extra: object = {}) => ({
  id: jobId,
  projectId,
  state,
  phase: "phase",
  progress: 0,
  ...extra,
});

type Call = { name: string; args: any };
type Dispatch = (name: string, args: any) => Promise<unknown>;

async function temporaryRoot(prefix = "reels-cli-") {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

const terminate = () => process.emit("SIGTERM");

/** Every stdout must be exactly one JSON line and no output may leak the socket secrets. */
const secrets: string[] = [];
async function cli(
  root: string,
  args: string[],
  options: {
    stdin?: string | Buffer;
    tty?: boolean;
    cwd?: string;
    cwdGone?: boolean;
    stdinFails?: boolean;
    /** Sends SIGTERM to this process while the CLI is blocked reading stdin. */
    interruptStdin?: boolean;
    /** Sends SIGTERM right after stdin ends, once the command has started its work. */
    interruptAfterStdin?: boolean;
    onStderr?: (text: string) => void;
    env?: NodeJS.ProcessEnv;
    /** Extra CliIO fields, such as `script` and `versions` for `reels doctor`. */
    io?: Partial<CliIO>;
  } = {},
) {
  let stdout = "",
    stderr = "",
    stdinReads = 0;
  const io: CliIO = {
    stdin() {
      stdinReads++;
      if (options.stdinFails) throw new Error("stdin exploded");
      if (options.interruptStdin) {
        setImmediate(terminate);
        return new Readable({ read() {} });
      }
      const stream = Readable.from(
        options.stdin === undefined ? [] : [Buffer.from(options.stdin)],
      ) as Readable & { isTTY?: boolean };
      stream.isTTY = options.tty;
      if (options.interruptAfterStdin)
        stream.once("end", () => setImmediate(terminate));
      return stream;
    },
    stdout: (text) => (stdout += text),
    stderr: (text) => {
      stderr += text;
      options.onStderr?.(text);
    },
    env: options.env ?? { REELS_USER_DATA: root },
    cwd() {
      if (options.cwdGone) throw new Error("ENOENT: uv_cwd");
      return options.cwd ?? root;
    },
    pollMs: 5,
    ...options.io,
  };
  const code = await run(args, io);
  assert.equal(stdout.split("\n").length, 2, "stdout is one line");
  const document = JSON.parse(stdout);
  assert.equal(document.ok, code === 0);
  if (!document.ok) assert.equal(document.error.exitCode, code);
  for (const secret of secrets) {
    assert.ok(!stdout.includes(secret));
    assert.ok(!stderr.includes(secret));
  }
  return { code, document, stdout, stderr, stdinReads };
}

async function withApp(
  dispatch: Dispatch,
  body: (
    root: string,
    calls: Call[],
    close: () => Promise<void>,
  ) => Promise<void>,
) {
  const root = await temporaryRoot();
  const calls: Call[] = [];
  const close = await startAgentSocket(root, (name, args) => {
    calls.push({ name, args });
    return dispatch(name, args);
  });
  const connection = JSON.parse(
    await readFile(path.join(root, "agent/connection.json"), "utf8"),
  );
  secrets.push(connection.token, connection.socket);
  try {
    await body(root, calls, close);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
}

const offlineRoot = async (body: (root: string) => Promise<void>) => {
  const root = await temporaryRoot();
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const echo: Dispatch = async (_name, args) => args;
const failWith =
  (message: string, code?: string): Dispatch =>
  async () => {
    throw Object.assign(new Error(message), code ? { code } : {});
  };

test("tools list and schemas match the shared definitions and the real MCP server", async () => {
  await offlineRoot(async (root) => {
    const list = await cli(root, ["tools"]);
    assert.equal(list.code, 0);
    assert.deepEqual(
      list.document.data.tools.map((tool: { name: string }) => tool.name),
      Object.keys(toolDefinitions),
    );
    assert.equal(list.document.data.count, Object.keys(toolDefinitions).length);
    assert.match(list.document.data.guidance, /get_app_state/);
    const client = new Client({ name: "reels-cli-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/app/mcp/main.ts"],
      cwd: process.cwd(),
      env: {
        ...(process.env as Record<string, string>),
        REELS_USER_DATA: root,
      },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        [...toolNames].sort(),
      );
      for (const tool of tools) {
        const detail = await cli(root, ["tools", tool.name]);
        assert.deepEqual(detail.document.data.inputSchema, tool.inputSchema);
      }
    } finally {
      await client.close();
      await transport.close();
    }
  });
});

test("the built-in table keeps names unique and help reachable", () => {
  const names = builtins.flatMap(({ name, aliases }) => [
    name,
    ...(aliases ?? []),
  ]);
  assert.equal(new Set(names).size, names.length);
  // A topic is matched before routing, so it would hide a command or tool of the same name.
  const topics = helpTopics.map(({ name }) => name);
  assert.equal(new Set(topics).size, topics.length);
  assert.deepEqual(topics, ["exit-codes", "agent"]);
  for (const topic of topics) {
    assert.ok(!names.includes(topic), topic);
    assert.ok(!toolSlugs.includes(topic), topic);
  }
  for (const entry of builtins) {
    const flag = entry.name.startsWith("-");
    assert.equal(builtinCommands.includes(entry.name), !flag, entry.name);
    // data.builtins lists commands an agent runs, never a flag.
    if (entry.summary) assert.ok(!flag, entry.name);
    if (entry.help) assert.match(entry.help, /Example: reels |\nStart: /);
    if (entry.usage) assert.match(entry.usage, /^reels /);
  }
});

test("generated names never collide with built-ins or CLI options", async () => {
  const slugs = toolNames.map(toolSlug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const command of builtinCommands) assert.ok(!slugs.includes(command));
  for (const name of toolNames) {
    const flags = toolFlags(name).map(({ flag }) => flag.slice(2));
    assert.equal(new Set(flags).size, flags.length);
    for (const flag of flags) assert.ok(!Object.hasOwn(reservedOptions, flag));
  }
  for (const name of Object.keys(cliOptions))
    assert.ok(Object.hasOwn(toolDefinitions, name));
  assert.equal(propertyFlag("expectedUpdatedAt"), "expected-updated-at");
});

test("every tool sits in exactly one group, and group ids name nothing else", () => {
  assert.deepEqual(
    Object.keys(toolGroupOf).sort(),
    Object.keys(toolDefinitions).sort(),
  );
  for (const [name, group] of Object.entries(toolGroupOf))
    assert.ok(Object.hasOwn(toolGroups, group), name);
  for (const id of toolGroupIds) {
    assert.match(id, /^[a-z]+$/);
    assert.ok(
      toolNames.some((name) => toolGroupOf[name] === id),
      id,
    );
    assert.ok(toolGroups[id].length <= 80, id);
    // A group is a filter value, never a command word or a tool.
    assert.ok(!builtinCommands.includes(id), id);
    assert.ok(!toolSlugs.includes(id), id);
    assert.ok(!helpTopics.some(({ name }) => name === id), id);
  }
});

test("reels tools lists groups and filters by --group", async () => {
  await offlineRoot(async (root) => {
    const all = (await cli(root, ["tools"])).document.data;
    assert.deepEqual(
      all.groups.map(({ id }: { id: string }) => id),
      toolGroupIds,
    );
    assert.equal(
      all.groups.reduce(
        (sum: number, { count }: { count: number }) => sum + count,
        0,
      ),
      all.count,
    );
    for (const tool of all.tools)
      assert.equal(
        tool.group,
        toolGroupOf[tool.name as keyof typeof toolGroupOf],
      );
    assert.ok(!Object.hasOwn(all, "group"));
    for (const args of [["--group", "render"], ["--group=render"]]) {
      const filtered = await cli(root, ["tools", ...args]);
      assert.equal(filtered.code, 0, args.join(" "));
      const { data } = filtered.document;
      assert.equal(data.group, "render");
      assert.deepEqual(
        data.tools.map(({ name }: { name: string }) => name),
        toolNames.filter((name) => toolGroupOf[name] === "render"),
      );
      assert.equal(data.count, data.tools.length);
      assert.deepEqual(data.groups, all.groups);
      assert.deepEqual(
        data.tools[0],
        all.tools.find(
          ({ name }: { name: string }) => name === data.tools[0].name,
        ),
      );
    }
    const detail = (await cli(root, ["tools", "start-render"])).document.data;
    assert.equal(detail.group, "render");
    assert.match(
      (await cli(root, ["start-render", "--help"])).document.data.help,
      /^Group: render \(reels tools --group render\)$/m,
    );
    assert.match(
      (await cli(root, ["tools", "--help"])).document.data.help,
      /^Example: reels tools --group render$/m,
    );
  });
});

test("reels tools --group rejects unknown ids, tool names and other flags", async () => {
  await offlineRoot(async (root) => {
    const unknown = await cli(root, ["tools", "--group", "rendr"]);
    assert.equal(unknown.code, 2);
    assert.equal(unknown.document.error.code, "USAGE");
    assert.equal(unknown.document.error.writeOutcome, "none");
    assert.deepEqual(unknown.document.error.didYouMean, ["render"]);
    assert.match(unknown.document.error.message, /Groups: editor, render/);
    assert.match(unknown.document.error.usage, /--group <id>/);
    for (const args of [
      ["tools", "--group"],
      ["tools", "--group", ""],
      ["tools", "start-render", "--group", "render"],
      ["tools", "--group", "render", "start-render"],
      ["tools", "--group", "render", "--group", "forms"],
      ["tools", "--group", "render", "--bogus"],
      ["tools", "--bogus"],
    ]) {
      const { code, document } = await cli(root, args);
      assert.equal(code, 2, args.join(" "));
      assert.equal(document.error.code, "USAGE", args.join(" "));
      assert.equal(document.error.writeOutcome, "none", args.join(" "));
    }
    const named = (
      await cli(root, ["tools", "get-project", "--group", "editor"])
    ).document.error;
    assert.match(named.message, /does not take a tool name/);
    const other = (await cli(root, ["tools", "--bogus"])).document.error;
    assert.equal(other.message, "tools takes at most one tool name.");
  });
});

/** For the opt-in text forms: stdout is text, never JSON, and exactly what `run` wrote. */
async function cliText(root: string, args: string[]) {
  let stdout = "";
  const code = await run(args, {
    stdin: () => Readable.from([]),
    stdout: (text) => (stdout += text),
    stderr: () => {},
    env: { REELS_USER_DATA: root },
    cwd: () => root,
  });
  return { code, stdout };
}
const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

test("help --plain and tools --plain print text for people", async () => {
  await offlineRoot(async (root) => {
    const text = async (...args: string[]) => {
      const result = await cliText(root, args);
      assert.equal(result.code, 0, args.join(" "));
      assert.ok(!isJson(result.stdout), args.join(" "));
      assert.ok(result.stdout.endsWith("\n"), args.join(" "));
      return result.stdout;
    };
    const top = (await cli(root, ["--help"])).document.data.help;
    assert.equal(await text("help", "--plain"), `${top}\n`);
    assert.match(top, /--plain/);

    const list = await text("tools", "--plain");
    for (const id of toolGroupIds)
      assert.match(list, new RegExp(`^${id}: ${toolGroups[id].replace(/[.()]/g, "\\$&")} \\(\\d+\\)$`, "m"));
    for (const slug of toolSlugs)
      assert.match(list, new RegExp(`^  reels ${slug}  `, "m"));
    assert.match(list, /^  reels get-project +Read .*\(read-only\)$/m);
    assert.match(list, /^  reels update-project +Patch .*[^)]$/m);
    assert.match(list, /^Built-in commands:$/m);

    const render = await text("tools", "--plain", "--group", "render");
    assert.equal(await text("tools", "--group=render", "--plain"), render);
    assert.match(render, /^render: /m);
    assert.doesNotMatch(render, /^editor: |reels get-project/m);
    assert.match(render, /^  reels start-render  /m);

    const detail = await text("tools", "--plain", "get-project");
    assert.equal(await text("tools", "reels_get_project", "--plain"), detail);
    assert.match(detail, /^reels get-project \(read-only\)$/m);
    assert.match(detail, /^Usage: reels get-project --project-id <uuid>$/m);
    assert.match(detail, /^Example: reels get-project /m);
    assert.match(detail, /^  --project-id  \(string, uuid, required\)$/m);
    assert.match(detail, /^Group: editor /m);
    const enums = await text("tools", "--plain", "preview-frame");
    assert.match(enums, /--kind  \(one of [a-z|]*cover[a-z|]*, required\)/);
    assert.match(enums, /^  --out <path> +New file for the image\.$/m);
    assert.equal(await text("help", "--plain", "get-project"), detail);
    assert.equal(await text("help", "get-project", "--plain"), detail);

    assert.equal(
      await text("help", "--plain", "status"),
      `${(await cli(root, ["status", "--help"])).document.data.help}\n`,
    );
    const toolsHelp = await text("help", "--plain", "tools");
    assert.equal(await text("tools", "--plain", "--help"), toolsHelp);
    assert.match(toolsHelp, /^--plain  /m);

    const codes = await text("help", "--plain", "exit-codes");
    for (const [name, code] of Object.entries(exitCodes))
      assert.match(codes, new RegExp(`^  ${code} +${name} +\\S`, "m"));
    assert.equal(
      await text("help", "--plain", "agent"),
      await readFile("skills/reels-cli/SKILL.md", "utf8"),
    );
  });
});

test("--plain stays opt-in: failures are JSON and other commands are unchanged", async () => {
  await offlineRoot(async (root) => {
    for (const args of [
      ["help", "--plain", "nope"],
      ["help", "--plain", "--version"],
      ["help", "--plain", "--plain"],
      ["tools", "--plain", "nonexistent"],
      ["tools", "--plain", "--group", "rendr"],
      ["tools", "--plain", "--plain"],
      ["tools", "--plain", "--bogus"],
      ["status", "--plain"],
      ["get-project", "--plain"],
      ["photos-search", "--plain"],
      ["call", "get-project", "--plain"],
      ["--plain"],
    ]) {
      const { code, document } = await cli(root, args);
      assert.equal(code, 2, args.join(" "));
      assert.ok(["USAGE", "UNKNOWN_TOOL"].includes(document.error.code), args.join(" "));
    }
    const group = (await cli(root, ["tools", "--plain", "--group", "rendr"]))
      .document.error;
    assert.deepEqual(group.didYouMean, ["render"]);
    // A schema flag named like a text option is still a schema flag.
    assert.deepEqual(
      parseToolArgs("reels_photos_search", ["--text", "cafe"]).given.map(
        ([flag, value]) => [flag.flag, value],
      ),
      [["--text", "cafe"]],
    );
    const help = await cli(root, ["photos-search", "--text", "cafe", "--help"]);
    assert.equal(help.code, 0);
    assert.match(help.document.data.help, /--text/);
    // Without --plain every form is JSON as before.
    for (const args of [["tools"], ["help", "get-project"], ["help", "agent"]])
      assert.equal((await cli(root, args)).code, 0, args.join(" "));
  });
});

const hasShell = (shell: string) =>
  spawnSync("/bin/sh", ["-c", `command -v ${shell}`]).status === 0;

test("reels completion prints a script built from this version's commands and flags", async () => {
  await offlineRoot(async (root) => {
    const version = JSON.parse(await readFile("package.json", "utf8")).version;
    for (const shell of ["bash", "zsh", "fish"]) {
      const { code, stdout } = await cliText(root, ["completion", shell]);
      assert.equal(code, 0, shell);
      assert.ok(!isJson(stdout), shell);
      assert.match(stdout, new RegExp(`generated by reels ${version.replaceAll(".", "\\.")}`));
      for (const word of [
        ...builtinCommands,
        "get-project",
        "start-render",
        "photos-search",
        "--project-id",
        "--expected-updated-at",
        "--wait-timeout",
        "--text",
        "--plain",
        "--group",
        "--version",
        "exit-codes",
        ...toolGroupIds,
      ])
        assert.match(stdout, new RegExp(`[ '"=(]${word}[ '")|]`), `${shell}: ${word}`);
      // Every tool, and each of its generated flags, is offered.
      for (const name of toolNames) {
        assert.ok(stdout.includes(toolSlug(name)), `${shell}: ${name}`);
        for (const { flag } of toolFlags(name))
          assert.match(stdout, new RegExp(`[ '"(]${flag}[ '")]`), `${shell}: ${name} ${flag}`);
      }
    }
  });
});

test("completion scripts parse in their shells and complete as listed", async (t) => {
  const root = await temporaryRoot();
  try {
    const script = async (shell: string) => {
      const file = path.join(root, `reels.${shell}`);
      await writeFile(file, (await cliText(root, ["completion", shell])).stdout);
      return file;
    };
    const bash = await script("bash");
    assert.equal(spawnSync("/bin/bash", ["-n", bash]).status, 0);
    const complete = (...words: string[]) =>
      spawnSync(
        "/bin/bash",
        [
          "-c",
          `source "$0"; COMP_WORDS=("$@"); COMP_CWORD=$(( $# - 1 )); _reels; printf '%s\\n' "\${COMPREPLY[@]}"`,
          bash,
          ...words,
        ],
        { encoding: "utf8" },
      ).stdout.trim().split("\n");
    assert.deepEqual(complete("reels", "comp"), ["completion"]);
    assert.deepEqual(complete("reels", "completion", ""), ["bash", "zsh", "fish"]);
    assert.deepEqual(complete("reels", "tools", "--group", "ren"), ["render"]);
    assert.deepEqual(complete("reels", "call", "reels_get_project", "--pro"), ["--project-id"]);
    assert.deepEqual(complete("reels", "photos-search", "--te"), ["--text"]);
    assert.deepEqual(complete("reels", "help", "--pl"), ["--plain"]);
    // Past the command, only a word starting with - gets flags. A path, or the value of a
    // flag that takes one, gets an empty reply, so `complete -o default` offers file names.
    const empty = [""];
    assert.deepEqual(complete("reels", "preview-frame", "--out", ""), empty);
    assert.deepEqual(complete("reels", "preview-frame", "--out", "-"), empty);
    assert.deepEqual(complete("reels", "call", "preview-frame", "--out", ""), empty);
    assert.deepEqual(complete("reels", "prepare-media", "--selection", "./"), empty);
    assert.deepEqual(complete("reels", "prepare-media", "--list", ""), empty);
    assert.deepEqual(complete("reels", "status", "--timeout", ""), empty);
    assert.deepEqual(complete("reels", "status", "--t"), ["--timeout"]);
    assert.deepEqual(complete("reels", "prepare-media", "--li"), ["--list"]);
    // A command's own words still come before files.
    assert.ok(complete("reels", "tools", "").includes("get-project"));
    assert.ok(!complete("reels", "tools", "").includes("--group"));
    assert.ok(complete("reels", "help", "").includes("exit-codes"));
    assert.match(await readFile(bash, "utf8"), /^complete -o default -F _reels reels$/m);
    assert.match(await readFile(bash, "utf8"), /^# Load it with: eval "\$\(reels completion bash\)"$/m);

    // zsh falls back to _files in the same cases; fish keeps -f for the command position only.
    const zshScript = await readFile(await script("zsh"), "utf8");
    assert.match(zshScript, /if \(\( \$\{values\[\(Ie\)\$prev\]\} \)\); then\n\s+_files\n\s+return/);
    assert.match(zshScript, /elif \[\[ \$PREFIX == -\* \]\]; then\n\s+candidates=\(\$flags\)/);
    assert.match(zshScript, /else\n\s+_files\n\s+return/);
    assert.match(zshScript, /preview-frame\|reels_preview_frame\) flags=\([^)]*--out[^)]*\) args=\(\) values=\([^)]*--out[^)]*\)/);
    const fishScript = await readFile(await script("fish"), "utf8");
    assert.doesNotMatch(fishScript, /^complete -c reels -f$/m);
    for (const line of fishScript.split("\n").filter((text) => text.startsWith("complete") && / -f /.test(text)))
      assert.match(line, /-n (__fish_use_subcommand|__reels_after_group) /, line);
    assert.match(fishScript, /^complete -c reels -f -n __fish_use_subcommand -a /m);

    await t.test("zsh -n", { skip: !hasShell("zsh") && "zsh is not installed" }, async () => {
      assert.equal(spawnSync("zsh", ["-n", await script("zsh")]).status, 0);
    });
    await t.test("fish -n", { skip: !hasShell("fish") && "fish is not installed" }, async () => {
      assert.equal(spawnSync("fish", ["-n", await script("fish")]).status, 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reels completion needs one known shell and installs nothing", async () => {
  await offlineRoot(async (root) => {
    for (const [args, didYouMean] of [
      [["completion"], ["bash", "zsh", "fish"]],
      [["completion", "bassh"], ["bash"]],
      [["completion", "tcsh"], ["bash", "zsh", "fish"]],
      [["completion", "--bogus"], ["bash", "zsh", "fish"]],
    ] as const) {
      const { code, document } = await cli(root, [...args]);
      assert.equal(code, 2, args.join(" "));
      assert.equal(document.error.code, "USAGE", args.join(" "));
      assert.equal(document.error.writeOutcome, "none", args.join(" "));
      assert.deepEqual(document.error.didYouMean, didYouMean, args.join(" "));
    }
    assert.equal((await cli(root, ["completion", "bash", "zsh"])).code, 2);
    const help = (await cli(root, ["completion", "--help"])).document.data.help;
    assert.match(help, /^Example: reels completion zsh > /m);
    assert.match(help, /installs nothing/);
    assert.equal((await cli(root, ["help", "completion"])).document.data.help, help);
    // It does no work against the app, so data.builtins leaves it out, as it does help and tools.
    assert.ok(builtinCommands.includes("completion"));
    assert.equal(
      (await cli(root, ["tools", "completion"])).document.error.next[0],
      "reels help completion",
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test("tool detail, help and version need no app", async () => {
  await offlineRoot(async (root) => {
    const detail = await cli(root, ["tools", "update-project"]);
    assert.equal(detail.document.data.name, "reels_update_project");
    assert.equal(detail.document.data.command, "reels update-project");
    assert.ok(
      detail.document.data.flags.some(
        (flag: any) =>
          flag.flag === "--expected-updated-at" &&
          flag.property === "expectedUpdatedAt" &&
          flag.required,
      ),
    );
    assert.match(detail.document.data.example, /--patch '\{"cover"/);
    const help = await cli(root, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.document.data.help, /reels status/);
    assert.match(help.document.data.help, /Exit codes/);
    assert.equal(help.stderr, "", "help is not repeated on stderr");
    for (const args of [
      ["status", "--help"],
      ["tools", "--help"],
      ["call", "--help"],
      ["call", "get-project", "--help"],
      ["get-project", "--help"],
      ["prepare-media", "--help"],
    ])
      assert.equal((await cli(root, args)).code, 0, args.join(" "));
    assert.equal(
      (await cli(root, ["--version"])).document.data.version,
      JSON.parse(await readFile("package.json", "utf8")).version,
    );
    assert.equal((await cli(root, [])).code, 2);
    const unknown = await cli(root, ["render"]);
    assert.equal(unknown.code, 2);
    assert.ok(unknown.document.error.didYouMean.includes("start-render"));
    assert.ok(unknown.document.error.didYouMean.length <= 3);
    const unknownTool = await cli(root, ["call", "get-projec"]);
    assert.equal(unknownTool.code, 2);
    assert.equal(unknownTool.document.error.code, "UNKNOWN_TOOL");
    assert.deepEqual(unknownTool.document.error.didYouMean, ["get-project"]);
  });
});

test("every input source reaches the app as the same parsed args", async () => {
  await withApp(echo, async (root, calls) => {
    const expected = {
      directory: "/absolute/한글 폴더",
      offset: 5,
      limit: 100,
    };
    const raw = JSON.stringify({ directory: expected.directory, offset: 5 });
    const file = path.join(root, "input.json");
    await writeFile(file, raw);
    const results = [
      await cli(root, ["list-local-media", "--input", raw]),
      await cli(root, ["list-local-media", "--input-file", "input.json"]),
      await cli(root, ["call", "reels_list_local_media", "--input", "-"], {
        stdin: raw,
      }),
      await cli(root, [
        "call",
        "list-local-media",
        "--directory",
        expected.directory,
        "--offset",
        "5",
      ]),
      await cli(root, [
        "list-local-media",
        "--directory",
        expected.directory,
        "--offset=5",
      ]),
    ];
    for (const result of results) {
      assert.equal(result.code, 0);
      assert.equal(result.document.tool, "reels_list_local_media");
      assert.deepEqual(result.document.data, expected);
    }
    assert.equal(calls.length, results.length);
    for (const call of calls) assert.deepEqual(call.args, expected);
  });
});

test("flag types follow the schema", async () => {
  await withApp(echo, async (root, calls) => {
    assert.equal(
      (
        await cli(root, [
          "form-save",
          "--form-id",
          formId,
          "--expected-revision",
          "3",
          "--answers",
          "[]",
          "--submit",
        ])
      ).code,
      0,
    );
    assert.equal(calls[0].args.expectedRevision, 3);
    assert.equal(calls[0].args.submit, true);
    assert.equal(
      (
        await cli(root, [
          ...updateArgs.slice(0, 5),
          "--patch",
          '{"cover":{"time":7.25}}',
        ])
      ).code,
      0,
    );
    assert.deepEqual(calls[1].args.patch, { cover: { time: 7.25 } });
    assert.equal(
      (
        await cli(root, [
          "form-wait",
          "--form-id",
          formId,
          "--after-revision=-1",
        ])
      ).code,
      0,
    );
    assert.equal(calls[2].args.afterRevision, -1);
    assert.equal(calls[2].args.timeoutMs, 30000);
  });
});

test("null results keep a stable data field", async () => {
  await withApp(
    async () => undefined,
    async (root) => {
      const result = await cli(root, ["get-app-state"]);
      assert.equal(result.code, 0);
      assert.equal(result.document.data, null);
      assert.ok(Object.hasOwn(result.document, "data"));
    },
  );
});

test("input mistakes are usage errors that never reach the app or stdin", async () => {
  await withApp(echo, async (root, calls) => {
    const expectCode = async (
      args: string[],
      code: string,
      options?: Parameters<typeof cli>[2],
    ) => {
      const result = await cli(root, args, options);
      assert.equal(result.code, 2, args.join(" "));
      assert.equal(result.document.error.code, code, args.join(" "));
      assert.equal(result.document.error.retry, "fix_input");
      return result;
    };
    await expectCode(["get-app-state", "--input", "{"], "INVALID_JSON");
    await expectCode(["get-app-state", "--input", "-"], "INVALID_JSON", {
      stdin: "",
    });
    await expectCode(["get-app-state", "--input", "-"], "INVALID_JSON", {
      stdin: "nope",
    });
    await expectCode(["update-project", "--patch", "{"], "INVALID_JSON");
    await expectCode(["get-app-state", "--input", "-"], "USAGE", { tty: true });
    await expectCode(
      ["get-app-state", "--input-file", "missing.json"],
      "USAGE",
    );
    const mixed = await expectCode(
      ["get-project", "--input", "{}", "--project-id", projectId],
      "USAGE",
    );
    assert.equal(mixed.stdinReads, 0);
    await expectCode(
      ["get-app-state", "--input", "{}", "--input-file", "x"],
      "USAGE",
    );
    const duplicate = await expectCode(
      ["get-project", "--project-id", projectId, "--project-id", projectId],
      "USAGE",
    );
    assert.match(duplicate.document.error.message, /more than once/);
    const negative = await expectCode(
      ["form-wait", "--form-id", formId, "--after-revision", "-1"],
      "USAGE",
    );
    assert.match(negative.document.error.message, /--after-revision=-1/);
    await expectCode(["get-project", "--unknown", "x"], "USAGE");
    await expectCode(["get-project", "stray"], "USAGE");
    await expectCode(["get-app-state", "--timeout", "0"], "USAGE");
    await expectCode(["get-app-state", "--timeout", "181"], "USAGE");
    await expectCode(["get-app-state", "--out", "x.png"], "USAGE");
    await expectCode(["get-app-state", "--wait"], "USAGE");
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 32);
    await expectCode(["get-app-state", "--input", "-"], "REQUEST_TOO_LARGE", {
      stdin: big,
    });
    await writeFile(path.join(root, "big.json"), big);
    await expectCode(
      ["get-app-state", "--input-file", "big.json"],
      "REQUEST_TOO_LARGE",
    );
    assert.equal(calls.length, 0);
    const empty = await cli(root, ["get-app-state"]);
    assert.equal(empty.code, 0);
    assert.equal(empty.stdinReads, 0);
    assert.deepEqual(calls[0].args, {});
  });
});

test("schema failures stop before the app with issue paths", async () => {
  await withApp(echo, async (root, calls) => {
    const bad = await cli(root, [
      "get-project",
      "--project-id",
      "../../etc/passwd",
    ]);
    assert.equal(bad.code, 2);
    assert.equal(bad.document.error.code, "INVALID_INPUT");
    assert.deepEqual(bad.document.error.issues[0].path, ["projectId"]);
    assert.match(
      bad.document.error.usage,
      /^reels get-project --project-id <uuid>/,
    );
    const missing = await cli(root, [
      "update-project",
      "--project-id",
      projectId,
      "--patch",
      "{}",
    ]);
    assert.equal(missing.code, 2);
    assert.equal(missing.document.error.writeOutcome, "not_applied");
    assert.ok(
      missing.document.error.issues.some(
        (issue: { path: string[] }) => issue.path[0] === "expectedUpdatedAt",
      ),
    );
    const nan = await cli(root, [
      "list-local-media",
      "--directory",
      "/absolute",
      "--offset",
      "",
    ]);
    assert.equal(nan.code, 2);
    assert.equal(calls.length, 0);
  });
});

test("offline calls exit 3 while status reports the reason and exits 0", async () => {
  await offlineRoot(async (root) => {
    const call = await cli(root, ["get-app-state"]);
    assert.equal(call.code, 3);
    assert.equal(call.document.error.code, "APP_OFFLINE");
    assert.equal(call.document.error.retry, "safe");
    assert.equal(call.document.error.reason, "no_connection_file");
    assert.deepEqual(call.document.error.next, ["reels status"]);
    assert.match(call.document.error.hint, /never launches/);
    const write = await cli(root, updateArgs);
    assert.equal(write.code, 3);
    assert.equal(write.document.error.writeOutcome, "not_applied");
    const missing = await cli(root, ["status"]);
    assert.equal(missing.code, 0);
    assert.deepEqual(missing.document.data.app, {
      online: false,
      reason: "no_connection_file",
    });
    assert.equal(missing.document.data.userData, root);
    assert.match(missing.document.data.hint, /never launches/);
    assert.ok(!Object.hasOwn(missing.document.data, "next"));

    const file = path.join(root, "agent/connection.json");
    await mkdir(path.dirname(file), { mode: 0o700 });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        socket: path.join(root, "dead.sock"),
        token: "a".repeat(64),
        pid: 1,
      }),
      { mode: 0o600 },
    );
    const stale = await cli(root, ["status"]);
    assert.equal(stale.document.data.app.reason, "stale_connection");
    assert.equal((await cli(root, ["get-app-state"])).code, 3);
    await chmod(file, 0o644);
    const unsafe = await cli(root, ["status"]);
    assert.equal(unsafe.code, 0);
    assert.equal(unsafe.document.data.app.reason, "unsafe_connection_file");
  });
});

test("status reports a live app and an unresponsive one", async () => {
  const state = {
    context: { active: true },
    busy: false,
    runtime: {},
    jobs: [],
  };
  await withApp(
    async () => state,
    async (root) => {
      const online = await cli(root, ["status"]);
      assert.deepEqual(online.document.data.app, { online: true, ...state });
      assert.equal(online.document.data.cli.version, "0.1.0");
    },
  );
  await withApp(
    () => new Promise(() => {}),
    async (root, calls) => {
      const hung = await cli(root, ["status", "--timeout", "0.1"]);
      assert.equal(hung.code, 0);
      assert.deepEqual(hung.document.data.app, {
        online: false,
        reason: "unresponsive",
      });
      assert.equal(calls.length, 1);
    },
  );
  await withApp(echo, async (root, calls) => {
    const file = path.join(root, "agent/connection.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...record, token: "b".repeat(64) }));
    const status = await cli(root, ["status"]);
    assert.equal(status.document.data.app.reason, "unresponsive");
    const call = await cli(root, ["get-app-state"]);
    assert.equal(call.code, 3);
    assert.equal(call.document.error.code, "APP_OFFLINE");
    assert.equal(calls.length, 0);
  });
});

test("app errors map to the documented exit codes", async () => {
  const cases: [string, string | undefined, number, string][] = [
    ["STALE_PROJECT: 다시 조회", undefined, 5, "STALE_PROJECT"],
    ["STALE_DASHBOARD: 다시 조회", undefined, 5, "STALE_DASHBOARD"],
    ["STALE_ANALYSIS: 다시 조회", undefined, 5, "STALE_ANALYSIS"],
    [
      "CONTEXT_REVISION_REQUIRED: 먼저 조회",
      undefined,
      5,
      "CONTEXT_REVISION_REQUIRED",
    ],
    ["BUSY", undefined, 6, "BUSY"],
    ["EDITOR_BUSY: 저장 필요", undefined, 6, "EDITOR_BUSY"],
    ["ANALYSIS_BUSY: 진행 중", undefined, 6, "ANALYSIS_BUSY"],
    ["다른 블로그 추출이 진행 중", "BLOG_EXTRACT_BUSY", 6, "BLOG_EXTRACT_BUSY"],
    ["결과 파일 저장 마무리", "RENDER_SAVE_BUSY", 6, "RENDER_SAVE_BUSY"],
    [
      "진행 중인 편집 작업이 끝난 뒤 다시 시도해주세요.",
      "EDITOR_BUSY",
      6,
      "EDITOR_BUSY",
    ],
    ["같은 이름의 결과가 있어요.", "OUTPUT_EXISTS", 2, "OUTPUT_EXISTS"],
    [
      "내보내기 작업을 찾지 못했어요.",
      "RENDER_JOB_NOT_FOUND",
      4,
      "RENDER_JOB_NOT_FOUND",
    ],
    ["FORM_ID_CONFLICT: 중복", undefined, 4, "FORM_ID_CONFLICT"],
    ["PROJECT_ALIAS_CONFLICT: 충돌", undefined, 4, "PROJECT_ALIAS_CONFLICT"],
    ["UNSUPPORTED", undefined, 4, "UNSUPPORTED"],
    ["UNKNOWN_TOOL: 지원하지 않는 도구예요.", undefined, 4, "UNKNOWN_TOOL"],
    ["ENOENT: no such file", "ENOENT", 4, "ENOENT"],
    ["코드 없는 앱 오류", undefined, 4, "TOOL_ERROR"],
    // Local-only codes must not gain their local meaning when the app sends them.
    ["RENDER_FAILED: remote", undefined, 4, "RENDER_FAILED"],
    ["USAGE: remote", undefined, 4, "USAGE"],
  ];
  for (const [message, code, exitCode, expected] of cases)
    await withApp(failWith(message, code), async (root) => {
      const result = await cli(root, updateArgs);
      assert.equal(result.code, exitCode, message);
      assert.equal(result.document.error.code, expected, message);
      assert.equal(result.document.tool, "reels_update_project");
      assert.ok(result.stderr.includes(expected));
    });
});

test("errors say what happened to the write and what to do next", async () => {
  await withApp(
    failWith("STALE_PROJECT: 프로젝트를 다시 조회해주세요."),
    async (root) => {
      const { error } = (await cli(root, updateArgs)).document;
      assert.equal(error.message, "프로젝트를 다시 조회해주세요.");
      assert.equal(error.retry, "refresh_first");
      assert.equal(error.writeOutcome, "not_applied");
      assert.deepEqual(error.next, [
        `reels get-project --project-id ${projectId}`,
      ]);
    },
  );
  await withApp(failWith("STALE_DASHBOARD: 다시 조회"), async (root) => {
    const content = {
      id: "sample-id",
      title: "t",
      date: "2026-11-02",
      dateBasis: "capture",
      localNotes: "",
      stage: "captured",
      nextAction: "",
      publicURL: "",
      resources: [],
    };
    const { error } = (
      await cli(root, [
        "upsert-content",
        "--content",
        JSON.stringify(content),
        "--expected-updated-at",
        revision,
      ])
    ).document;
    // The entry may not exist yet, so get-content would be a dead end.
    assert.deepEqual(error.next, ["reels list-projects"]);
    assert.match(error.hint, /\.data\.dashboard\.updatedAt/);
  });
  await withApp(failWith("STALE_FORM: 다시 조회"), async (root) => {
    const { error } = (
      await cli(root, [
        "form-save",
        "--form-id",
        formId,
        "--expected-revision",
        "1",
        "--answers",
        "[]",
      ])
    ).document;
    assert.deepEqual(error.next, [`reels form-get --form-id ${formId}`]);
  });
  await withApp(failWith("x", "RENDER_JOB_NOT_FOUND"), async (root) => {
    const { error } = (await cli(root, ["get-render-job", "--job-id", jobId]))
      .document;
    assert.deepEqual(error.next, ["reels status"]);
    assert.equal(error.writeOutcome, "none");
  });
  await withApp(
    failWith("UNKNOWN_TOOL: 지원하지 않는 도구예요."),
    async (root) => {
      const { error } = (await cli(root, updateArgs)).document;
      assert.equal(error.writeOutcome, "not_applied");
      assert.match(error.hint, /Rebuild/);
      assert.ok(!Object.hasOwn(error, "next"));
    },
  );
  await withApp(failWith("코드 없는 앱 오류"), async (root) => {
    assert.equal(
      (await cli(root, updateArgs)).document.error.writeOutcome,
      "unknown",
    );
    assert.equal(
      (await cli(root, ["get-app-state"])).document.error.writeOutcome,
      "none",
    );
  });
});

test("an uncertain write is never retried and never reads as offline", async () => {
  await withApp(
    () => new Promise(() => {}),
    async (root, calls) => {
      const write = await cli(root, [...updateArgs, "--timeout", "0.2"]);
      assert.equal(write.code, 7);
      assert.equal(write.document.error.code, "REQUEST_TIMEOUT");
      assert.equal(write.document.error.writeOutcome, "unknown");
      assert.equal(write.document.error.retry, "inspect_first");
      assert.equal(calls.length, 1);
      const read = await cli(root, ["get-app-state", "--timeout", "0.2"]);
      assert.equal(read.code, 7);
      assert.equal(read.document.error.writeOutcome, "none");
      assert.equal(read.document.error.retry, "safe");
      assert.equal(calls.length, 2);
    },
  );
  let close: () => Promise<void> = async () => {};
  await withApp(
    () => {
      setTimeout(() => void close(), 0);
      return new Promise(() => {});
    },
    async (root, calls, stop) => {
      close = stop;
      const lost = await cli(root, updateArgs);
      assert.equal(lost.code, 7);
      assert.equal(lost.document.error.code, "CONNECTION_LOST");
      assert.equal(lost.document.error.writeOutcome, "unknown");
      assert.equal(lost.document.error.retry, "inspect_first");
      assert.equal(calls.length, 1);
    },
  );
});

test("images go to --out and base64 never reaches stdout", async () => {
  const base64 = png.toString("base64");
  const previewArgs = [
    "preview-frame",
    "--project-id",
    projectId,
    "--expected-updated-at",
    revision,
    "--kind",
    "cover",
  ];
  await withApp(
    async (name) =>
      name === "reels_preview_frame"
        ? {
            image: `data:image/png;base64,${base64}`,
            manifest: { ok: true },
            displaySize: { width: 1, height: 2 },
          }
        : { dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
    async (root, calls) => {
      const out = await cli(root, [...previewArgs, "--out", "cover.png"]);
      assert.equal(out.code, 0);
      const file = path.join(root, "cover.png");
      assert.deepEqual(await readFile(file), png);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.ok(!out.stdout.includes(base64));
      assert.deepEqual(out.document.data, {
        manifest: { ok: true },
        displaySize: { width: 1, height: 2 },
        image: { path: file, mimeType: "image/png", bytes: png.length },
      });
      assert.equal(calls.length, 1);

      const missing = await cli(root, previewArgs);
      assert.equal(missing.code, 2);
      assert.equal(missing.document.error.code, "USAGE");
      await writeFile(file, "keep");
      const exists = await cli(root, [...previewArgs, "--out", file]);
      assert.equal(exists.code, 2);
      assert.equal(exists.document.error.code, "OUTPUT_EXISTS");
      assert.equal(await readFile(file, "utf8"), "keep");
      const noParent = await cli(root, [
        ...previewArgs,
        "--out",
        "missing/cover.png",
      ]);
      assert.equal(noParent.code, 2);
      assert.equal(calls.length, 1);

      const media = await cli(root, [
        "form-media",
        "--form-id",
        formId,
        "--question-id",
        "q1",
        "--image-index",
        "0",
        "--out",
        "photo.jpg",
      ]);
      assert.equal(media.code, 0);
      assert.deepEqual(await readFile(path.join(root, "photo.jpg")), jpeg);
      assert.equal(media.document.data.image.mimeType, "image/jpeg");
      assert.ok(!Object.hasOwn(media.document.data, "dataUrl"));
    },
  );
  await withApp(
    async () => ({ image: "not a data url" }),
    async (root) => {
      const invalid = await cli(root, [...previewArgs, "--out", "x.png"]);
      assert.equal(invalid.code, 7);
      assert.equal(invalid.document.error.code, "RESPONSE_INVALID");
      await assert.rejects(stat(path.join(root, "x.png")));
    },
  );
  await withApp(
    async () => ({
      nested: [{ thumbnail: `data:image/png;base64,${base64}` }],
      text: "ok",
    }),
    async (root) => {
      const result = await cli(root, ["get-app-state"]);
      assert.equal(result.code, 0);
      assert.ok(!result.stdout.includes(base64));
      assert.deepEqual(result.document.data.nested[0].thumbnail, {
        omitted: "data_url",
        mimeType: "image/png",
        bytes: png.length,
      });
      assert.equal(result.document.data.text, "ok");
      assert.match(result.stderr, /data URL/);
    },
  );
});

function renderApp(states: unknown[]): Dispatch {
  return async (name) => {
    if (name === "reels_start_render") return job("running");
    if (name === "reels_cancel_render")
      throw new Error("cancel must not be called");
    return states.length > 1 ? states.shift() : states[0];
  };
}
const cancels = (calls: Call[]) =>
  calls.filter((call) => call.name === "reels_cancel_render").length;

test("--wait follows a render to its terminal state", async () => {
  await withApp(
    renderApp([
      job("running", { progress: 50 }),
      job("completed", { progress: 100, outputPath: "/absolute/new.mov" }),
    ]),
    async (root, calls) => {
      const done = await cli(root, [...renderArgs, "--wait"]);
      assert.equal(done.code, 0);
      assert.equal(done.document.data.state, "completed");
      assert.equal(done.document.data.outputPath, "/absolute/new.mov");
      assert.ok(done.stderr.includes(jobId));
      assert.equal(calls[0].name, "reels_start_render");
      assert.equal(
        calls.filter((call) => call.name === "reels_start_render").length,
        1,
      );
      assert.equal(cancels(calls), 0);
    },
  );
  await withApp(
    renderApp([job("failed", { error: "encoder died" })]),
    async (root) => {
      const failed = await cli(root, [...renderArgs, "--wait"]);
      assert.equal(failed.code, 8);
      assert.equal(failed.document.error.code, "RENDER_FAILED");
      assert.equal(failed.document.error.message, "encoder died");
      assert.equal(failed.document.error.writeOutcome, "applied");
      assert.equal(failed.document.error.job.state, "failed");
      assert.equal(failed.document.error.jobId, jobId);
      // Reading a failed job is not itself a failure unless --wait asks for the verdict.
      const read = await cli(root, ["get-render-job", "--job-id", jobId]);
      assert.equal(read.code, 0);
      assert.equal(read.document.data.state, "failed");
      const reattached = await cli(root, [
        "get-render-job",
        "--job-id",
        jobId,
        "--wait",
      ]);
      assert.equal(reattached.code, 8);
      assert.equal(reattached.document.error.writeOutcome, "none");
    },
  );
  await withApp(renderApp([job("cancelled")]), async (root) => {
    const cancelled = await cli(root, [...renderArgs, "--wait"]);
    assert.equal(cancelled.code, 9);
    assert.equal(cancelled.document.error.code, "RENDER_CANCELLED");
  });
});

test("start-render without --wait returns the job immediately", async () => {
  await withApp(renderApp([job("running")]), async (root, calls) => {
    const started = await cli(root, renderArgs);
    assert.equal(started.code, 0);
    assert.equal(started.document.data.id, jobId);
    assert.equal(calls.length, 1);
  });
});

test("a wait timeout leaves the job running", async () => {
  await withApp(renderApp([job("running")]), async (root, calls) => {
    const timedOut = await cli(root, [
      ...renderArgs,
      "--wait",
      "--wait-timeout",
      "0.05",
    ]);
    assert.equal(timedOut.code, 10);
    assert.equal(timedOut.document.error.code, "WAIT_TIMEOUT");
    assert.equal(timedOut.document.error.writeOutcome, "applied");
    assert.equal(timedOut.document.error.retry, "safe");
    assert.equal(timedOut.document.error.jobId, jobId);
    assert.deepEqual(timedOut.document.error.next, [
      `reels get-render-job --job-id ${jobId} --wait`,
    ]);
    assert.equal(cancels(calls), 0);
    assert.equal(
      calls.filter((call) => call.name === "reels_start_render").length,
      1,
    );
    const usage = await cli(root, [...renderArgs, "--wait-timeout", "1"]);
    assert.equal(usage.code, 2);
    assert.equal(
      calls.filter((call) => call.name === "reels_start_render").length,
      1,
    );
  });
});

test("a vanished app ends the wait without pretending the render did not start", async () => {
  await withApp(renderApp([job("running")]), async (root, calls, close) => {
    let closing: Promise<void> | undefined;
    const result = await cli(root, [...renderArgs, "--wait"], {
      onStderr: (text) => {
        if (text.includes("running")) closing ??= close();
      },
    });
    await closing;
    assert.equal(result.code, 3);
    assert.equal(result.document.error.jobId, jobId);
    assert.equal(result.document.error.writeOutcome, "applied");
    assert.equal(result.document.error.job.state, "running");
    assert.deepEqual(result.document.error.next, [
      `reels get-render-job --job-id ${jobId} --wait`,
    ]);
    assert.equal(calls.length, 1);
  });
});

test("poll failures end the wait and a job missing an id is invalid", async () => {
  await withApp(
    async (name) => {
      if (name === "reels_start_render") return job("running");
      throw Object.assign(new Error("내보내기 작업을 찾지 못했어요."), {
        code: "RENDER_JOB_NOT_FOUND",
      });
    },
    async (root, calls) => {
      const lost = await cli(root, [...renderArgs, "--wait"]);
      assert.equal(lost.code, 4);
      assert.equal(lost.document.error.writeOutcome, "applied");
      assert.deepEqual(lost.document.error.next, ["reels status"]);
      assert.equal(calls.length, 2);
    },
  );
  await withApp(
    async () => null,
    async (root) => {
      const invalid = await cli(root, [...renderArgs, "--wait"]);
      assert.equal(invalid.code, 7);
      assert.equal(invalid.document.error.code, "RESPONSE_INVALID");
      assert.equal(invalid.document.error.writeOutcome, "unknown");
    },
  );
});

async function mediaFixture(
  body: (root: string, source: string, out: string) => Promise<void>,
) {
  const root = await temporaryRoot("reels-cli-media-");
  const out = await temporaryRoot("reels-cli-out-");
  try {
    const source = path.join(root, "영상.mov");
    await writeFile(source, "synthetic source");
    const data = path.join(root, "data");
    const store = new LocalStore(data);
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
    await body(data, source, out);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
}

test("prepare-media copies registered media without the app", async () => {
  await mediaFixture(async (data, source, out) => {
    const selection = path.join(out, "selection.json");
    await writeFile(selection, JSON.stringify([source]));
    const dashboard = await readFile(path.join(data, "dashboard.json"), "utf8");
    const args = ["prepare-media", "--project-id", "sample", "--selection"];
    const destination = path.join(out, "copy");
    const copied = await cli(data, [
      ...args,
      selection,
      "--destination",
      destination,
    ]);
    assert.equal(copied.code, 0);
    const copy = copied.document.data.entries[0];
    assert.equal(await readFile(copy.path, "utf8"), "synthetic source");
    assert.equal(
      JSON.parse(await readFile(copied.document.data.receiptPath, "utf8"))
        .entries.length,
      1,
    );
    assert.equal(
      await readFile(path.join(data, "dashboard.json"), "utf8"),
      dashboard,
    );
    await assert.rejects(stat(path.join(data, "agent")));

    const stdin = await cli(
      data,
      [...args, "-", "--destination", path.join(out, "stdin")],
      {
        stdin: JSON.stringify([source]),
      },
    );
    assert.equal(stdin.code, 0);

    const rejected = async (list: string, target: string) => {
      const result = await cli(data, [...args, list, "--destination", target]);
      assert.equal(result.code, 2, target);
      assert.equal(result.document.error.code, "INVALID_INPUT", target);
      assert.equal(result.document.error.retry, "fix_input");
      assert.equal(result.document.error.writeOutcome, "not_applied");
      return result;
    };
    const again = await rejected(selection, destination);
    assert.match(again.document.error.message, /already exists/);

    const unregistered = path.join(out, "list.json");
    await writeFile(
      unregistered,
      JSON.stringify([path.join(out, "other.mov")]),
    );
    await rejected(unregistered, path.join(out, "denied"));
    await assert.rejects(stat(path.join(out, "denied")));

    await writeFile(unregistered, "[]");
    await rejected(unregistered, path.join(out, "empty"));
    await assert.rejects(stat(path.join(out, "empty")));

    const nowhere = await rejected(selection, path.join(out, "missing/parent"));
    assert.doesNotMatch(nowhere.document.error.message, /ENOENT/);

    const unknown = await cli(data, [
      "prepare-media",
      "--project-id",
      "nope",
      "--selection",
      selection,
      "--destination",
      path.join(out, "unknown"),
    ]);
    assert.equal(unknown.code, 2);
    assert.equal(unknown.document.error.code, "INVALID_INPUT");

    await symlink(out, path.join(out, "link"));
    const linked = await rejected(selection, path.join(out, "link/new"));
    assert.match(linked.document.error.hint, /\/private\/tmp/);
    assert.ok(!Object.hasOwn(linked.document.error, "next"));

    const slash = await cli(data, [
      ...args,
      selection,
      "--destination",
      path.join(out, "slash") + "/",
    ]);
    assert.equal(slash.code, 2);
    assert.equal(slash.document.error.code, "USAGE");

    await writeFile(unregistered, '["relative.mov"]');
    const relative = await rejected(unregistered, path.join(out, "relative"));
    assert.doesNotMatch(relative.document.error.message, /origin|prefix/);

    for (const [content, code] of [
      ["{", "INVALID_JSON"],
      ['{"a":1}', "INVALID_INPUT"],
      ["[1]", "INVALID_INPUT"],
    ]) {
      await writeFile(unregistered, content);
      const bad = await cli(data, [
        ...args,
        unregistered,
        "--destination",
        path.join(out, "bad"),
      ]);
      assert.equal(bad.code, 2);
      assert.equal(bad.document.error.code, code);
    }
    assert.equal((await cli(data, ["prepare-media"])).code, 2);
    assert.equal(
      (await cli(data, [...args, selection, "--destination", "relative"])).code,
      2,
    );
  });
});

test("only a failure after the output folder exists reads as unknown", async () => {
  await mediaFixture(async (data, source, out) => {
    const selection = path.join(out, "selection.json");
    await writeFile(selection, JSON.stringify([source]));
    await chmod(source, 0);
    const destination = path.join(out, "partial");
    try {
      const failed = await cli(data, [
        "prepare-media",
        "--project-id",
        "sample",
        "--selection",
        selection,
        "--destination",
        destination,
      ]);
      assert.equal(failed.code, 11);
      assert.equal(failed.document.error.code, "PREPARE_FAILED");
      assert.equal(failed.document.error.retry, "inspect_first");
      assert.equal(failed.document.error.writeOutcome, "unknown");
      assert.ok(failed.document.error.hint.includes(destination));
      assert.ok((await stat(destination)).isDirectory());
    } finally {
      await chmod(source, 0o600);
    }
  });
});

test("prepare-media can find its inputs without the app", async () => {
  await mediaFixture(async (data, source) => {
    const dashboard = await readFile(path.join(data, "dashboard.json"), "utf8");
    const projects = await cli(data, ["prepare-media", "--list"]);
    assert.equal(projects.code, 0);
    assert.deepEqual(projects.document.data.projects, [
      { id: "sample", title: "Sample", resources: 1 },
    ]);
    const detail = await cli(data, [
      "prepare-media",
      "--list",
      "--project-id",
      "sample",
    ]);
    assert.equal(detail.code, 0);
    assert.equal(detail.document.data.resources[0].path, source);
    assert.equal(detail.document.data.resources[0].available, true);
    const missing = await cli(data, [
      "prepare-media",
      "--list",
      "--project-id",
      "nope",
    ]);
    assert.equal(missing.code, 4);
    assert.equal(missing.document.error.code, "CONTENT_NOT_FOUND");
    assert.equal(missing.document.error.writeOutcome, "none");
    assert.deepEqual(missing.document.error.next, [
      "reels prepare-media --list",
    ]);
    const mixed = await cli(data, [
      "prepare-media",
      "--list",
      "--destination",
      "/absolute/out",
    ]);
    assert.equal(mixed.code, 2);
    assert.equal(
      await readFile(path.join(data, "dashboard.json"), "utf8"),
      dashboard,
    );
    await assert.rejects(stat(path.join(data, "agent")));
    const help = await cli(data, ["prepare-media", "--help"]);
    assert.match(help.document.data.help, /JSON array/);
    assert.match(help.document.data.help, /--list/);
    assert.match(help.document.data.help, /must not exist/);
  });
});

test("an unusable dashboard.json is one failure, whichever way it is reached", async () => {
  for (const [content, reason] of [
    ["{bad", /Expected property name/],
    ['{"version":99}', /Unsupported dashboard schema/],
  ] as const)
    await mediaFixture(async (data, source, out) => {
      const file = path.join(data, "dashboard.json");
      const selection = path.join(out, "selection.json");
      await writeFile(selection, JSON.stringify([source]));
      await writeFile(file, content);
      const destination = path.join(out, "copy");
      const commands: [string[], string][] = [
        [["prepare-media", "--list"], "none"],
        [["prepare-media", "--list", "--project-id", "x"], "none"],
        [
          [
            "prepare-media",
            "--project-id",
            "x",
            "--selection",
            selection,
            "--destination",
            destination,
          ],
          "not_applied",
        ],
      ];
      for (const [args, writeOutcome] of commands) {
        const { code, document } = await cli(data, args);
        const { error } = document;
        assert.equal(code, 11, args.join(" "));
        assert.equal(error.code, "STORE_UNREADABLE");
        assert.equal(error.retry, "no");
        assert.equal(error.writeOutcome, writeOutcome);
        assert.ok(error.message.includes(file));
        assert.match(error.message, reason);
        assert.match(error.hint, /update the CLI/);
        assert.ok(!Object.hasOwn(error, "next"));
      }
      await assert.rejects(stat(destination));
    });
});

test("a refused selection names every file and how to see the registered ones", async () => {
  await mediaFixture(async (data, source, out) => {
    const selection = path.join(out, "selection.json");
    const args = [
      "prepare-media",
      "--project-id",
      "sample",
      "--selection",
      selection,
      "--destination",
      path.join(out, "copy"),
    ];
    const refused = path.join(path.dirname(source), "notes.txt");
    const missing = path.join(path.dirname(source), "other.mov");
    await writeFile(refused, "text");
    await writeFile(selection, JSON.stringify([source, refused, missing]));
    const store = new LocalStore(data);
    const updatedAt = (await store.load()).updatedAt;
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
        resources: [
          { role: "footage", path: source, label: "source" },
          { role: "folder", path: path.dirname(source), label: "folder" },
        ],
      },
      updatedAt,
    );
    const { code, document } = await cli(data, args);
    assert.equal(code, 2);
    const { error } = document;
    assert.equal(error.code, "INVALID_INPUT");
    assert.equal(
      error.message,
      `${refused}: ${error.issues[0].message} (+1 more)`,
    );
    assert.match(error.issues[0].message, /Not a supported media file \(\.mov/);
    assert.doesNotMatch(error.message, /미리보기/);
    assert.deepEqual(
      error.issues.map(({ path }: { path: string[] }) => path),
      [[refused], [missing]],
    );
    assert.deepEqual(error.next, [
      "reels prepare-media --list --project-id sample",
    ]);
    await assert.rejects(stat(path.join(out, "copy")));

    const help = (await cli(data, ["prepare-media", "--help"])).document.data
      .help;
    assert.match(help, /\.mov/);
    assert.match(help, /Select files, not folders/);
    const docs = await readFile("docs/cli-usage.md", "utf8");
    for (const extension of mediaExtensions)
      assert.ok(docs.includes(`\`${extension}\``), extension);
  });
});

test("a folder resource is refused as a folder, and the files inside it copy", async () => {
  const root = await temporaryRoot("reels-cli-folder-");
  try {
    const folder = path.join(root, "footage");
    const clip = path.join(folder, "clip.mov");
    await mkdir(folder);
    await writeFile(clip, "synthetic");
    const data = path.join(root, "data");
    const store = new LocalStore(data);
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
        resources: [{ role: "folder", path: folder, label: "footage" }],
      },
      (await store.load()).updatedAt,
    );
    const listed = await cli(data, [
      "prepare-media",
      "--list",
      "--project-id",
      "sample",
    ]);
    assert.equal(listed.document.data.resources[0].role, "folder");
    const copy = (paths: string[], name: string) =>
      cli(
        data,
        [
          "prepare-media",
          "--project-id",
          "sample",
          "--selection",
          "-",
          "--destination",
          path.join(root, name),
        ],
        { stdin: JSON.stringify(paths) },
      );
    const whole = await copy([folder], "whole");
    assert.equal(whole.code, 2);
    assert.match(whole.document.error.message, /Select files, not folders/);
    assert.doesNotMatch(whole.document.error.message, /output folder/);
    await assert.rejects(stat(path.join(root, "whole")));
    assert.equal((await copy([clip], "inside")).code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function spawnCli(
  root: string,
  args: string[],
  { holdStdin = false }: { holdStdin?: boolean } = {},
) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/app/cli/main.ts", ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, REELS_USER_DATA: root },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (!holdStdin) child.stdin.end();
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const done = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done, stderr: () => stderr };
}

test("the real process reports exit codes and keeps large output whole", async () => {
  await offlineRoot(async (root) => {
    const status = await spawnCli(root, ["status"]).done;
    assert.equal(status.code, 0);
    assert.equal(JSON.parse(status.stdout).data.app.online, false);
    const offline = await spawnCli(root, ["get-app-state"]).done;
    assert.equal(offline.code, 3);
    assert.equal(JSON.parse(offline.stdout).error.code, "APP_OFFLINE");
    const usage = await spawnCli(root, []).done;
    assert.equal(usage.code, 2);
  });
  const text = "가".repeat(1024 * 1024);
  await withApp(
    async () => ({ text }),
    async (root) => {
      const large = await spawnCli(root, ["get-app-state"]).done;
      assert.equal(large.code, 0);
      assert.equal(JSON.parse(large.stdout).data.text, text);
      const closed = spawnCli(root, ["get-app-state"]);
      closed.child.stdout.destroy();
      const result = await closed.done;
      assert.doesNotMatch(result.stderr, /EPIPE|at /);
    },
  );
});

for (const [signal, code] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)
  test(`${signal} stops waiting and leaves the render running`, async () => {
    await withApp(renderApp([job("running")]), async (root, calls) => {
      const running = spawnCli(root, [...renderArgs, "--wait"]);
      while (!running.stderr().includes("waiting"))
        await new Promise((resolve) => setTimeout(resolve, 20));
      running.child.kill(signal);
      const result = await running.done;
      assert.equal(result.code, code);
      const { error } = JSON.parse(result.stdout);
      assert.equal(error.code, "INTERRUPTED");
      assert.equal(error.exitCode, code);
      assert.equal(error.writeOutcome, "applied");
      assert.equal(error.retry, "safe");
      assert.equal(error.jobId, jobId);
      assert.deepEqual(error.next, [
        `reels get-render-job --job-id ${jobId} --wait`,
      ]);
      assert.equal(cancels(calls), 0);
    });
  });

const hang: Dispatch = () => new Promise(() => {});
async function untilCalled(calls: Call[]) {
  while (!calls.length) await new Promise((resolve) => setTimeout(resolve, 20));
}

for (const [signal, code] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`${signal} during a write leaves one document saying the outcome is unknown`, async () => {
    await withApp(hang, async (root, calls) => {
      const running = spawnCli(root, updateArgs);
      await untilCalled(calls);
      running.child.kill(signal);
      const result = await running.done;
      assert.equal(result.code, code);
      const { error } = JSON.parse(result.stdout);
      assert.equal(error.code, "INTERRUPTED");
      assert.equal(error.exitCode, code);
      assert.equal(error.writeOutcome, "unknown");
      assert.equal(error.retry, "inspect_first");
      assert.deepEqual(error.next, [
        `reels get-project --project-id ${projectId}`,
      ]);
      assert.equal(calls.length, 1);
    });
  });

  test(`${signal} during a read is safe to repeat`, async () => {
    await withApp(hang, async (root, calls) => {
      const running = spawnCli(root, [
        "get-project",
        "--project-id",
        projectId,
      ]);
      await untilCalled(calls);
      running.child.kill(signal);
      const result = await running.done;
      assert.equal(result.code, code);
      const { error } = JSON.parse(result.stdout);
      assert.equal(error.code, "INTERRUPTED");
      assert.equal(error.writeOutcome, "none");
      assert.equal(error.retry, "safe");
    });
  });
}

test("a signal before the first answer of start-render --wait is not reported as started", async () => {
  await withApp(hang, async (root, calls) => {
    const running = spawnCli(root, [...renderArgs, "--wait"]);
    await untilCalled(calls);
    running.child.kill("SIGTERM");
    const result = await running.done;
    assert.equal(result.code, 143);
    const { error } = JSON.parse(result.stdout);
    assert.equal(error.writeOutcome, "unknown");
    assert.equal(error.retry, "inspect_first");
    assert.ok(!Object.hasOwn(error, "jobId"));
    assert.equal(calls.length, 1);
  });
});

test("a signal while reading stdin sends nothing", async () => {
  await withApp(echo, async (root, calls) => {
    const { code, document } = await cli(
      root,
      ["update-project", "--input", "-"],
      { interruptStdin: true },
    );
    assert.equal(code, 143);
    assert.equal(document.error.code, "INTERRUPTED");
    assert.equal(document.error.writeOutcome, "not_applied");
    assert.equal(document.error.retry, "safe");
    assert.equal(calls.length, 0);
  });
});

test("a signal during prepare-media leaves the copy to be inspected", async () => {
  await mediaFixture(async (data, source, out) => {
    const destination = path.join(out, "copy");
    const { code, document } = await cli(
      data,
      [
        "prepare-media",
        "--project-id",
        "sample",
        "--selection",
        "-",
        "--destination",
        destination,
      ],
      { stdin: JSON.stringify([source]), interruptAfterStdin: true },
    );
    assert.equal(code, 143);
    assert.equal(document.error.code, "INTERRUPTED");
    assert.equal(document.error.writeOutcome, "unknown");
    assert.equal(document.error.retry, "inspect_first");
    assert.ok(document.error.hint.includes(destination));
    // In a real process exit stops the copy; here it runs on until the fixture cleans up.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});

test("--wait-timeout stays inside what a timer can hold", async () => {
  await withApp(renderApp([job("running")]), async (root, calls) => {
    for (const value of ["2147484", "Infinity", "1e308", "NaN"]) {
      const result = await cli(root, [
        "get-render-job",
        "--job-id",
        jobId,
        "--wait",
        "--wait-timeout",
        value,
      ]);
      assert.equal(result.code, 2, value);
      assert.equal(result.document.error.code, "USAGE", value);
    }
    assert.equal(calls.length, 0);
  });
  await withApp(renderApp([job("running")]), async (root) => {
    const running = spawnCli(root, [
      "get-render-job",
      "--job-id",
      jobId,
      "--wait",
      "--wait-timeout",
      "2147483",
    ]);
    while (!running.stderr().includes("waiting"))
      await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(running.child.exitCode, null, "still waiting");
    running.child.kill("SIGTERM");
    assert.doesNotMatch((await running.done).stderr, /TimeoutOverflowWarning/);
  });
});

test("an empty error message is still a failure", async () => {
  await withApp(failWith(""), async (root) => {
    const result = await cli(root, updateArgs);
    assert.equal(result.code, 4);
    assert.equal(result.document.error.code, "TOOL_ERROR");
    assert.equal(result.document.error.writeOutcome, "unknown");
    assert.ok(result.document.error.message);
  });
  // A server that sends the empty string itself must not read as success either.
  const folder = await temporaryRoot("reels-cli-raw-");
  const socketPath = path.join(folder, "s.sock");
  const raw = createServer((socket) => socket.end('{"error":""}\n'));
  await new Promise<void>((resolve) => raw.listen(socketPath, resolve));
  try {
    await mkdir(path.join(folder, "agent"), { mode: 0o700 });
    await writeFile(
      path.join(folder, "agent/connection.json"),
      JSON.stringify({
        version: 1,
        socket: socketPath,
        token: "c".repeat(64),
        pid: 1,
      }),
      { mode: 0o600 },
    );
    assert.equal((await cli(folder, updateArgs)).code, 4);
  } finally {
    raw.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("a large response is read in linear time and --timeout bounds the whole call", async () => {
  const size = 40 * 1024 * 1024;
  await withApp(
    async () => ({ text: "a".repeat(size) }),
    async (root) => {
      const started = Date.now();
      const result = await callAgent(root, "reels_get_app_state", {});
      assert.equal(result.text.length, size);
      assert.ok(Date.now() - started < 8000, "not quadratic");
    },
  );
  const folder = await temporaryRoot("reels-cli-drip-");
  const socketPath = path.join(folder, "s.sock");
  const timers: NodeJS.Timeout[] = [];
  const drip = createServer((socket) => {
    socket.on("error", () => {});
    timers.push(setInterval(() => socket.write("x"), 20));
  });
  await new Promise<void>((resolve) => drip.listen(socketPath, resolve));
  try {
    await mkdir(path.join(folder, "agent"), { mode: 0o700 });
    await writeFile(
      path.join(folder, "agent/connection.json"),
      JSON.stringify({
        version: 1,
        socket: socketPath,
        token: "d".repeat(64),
        pid: 1,
      }),
      { mode: 0o600 },
    );
    const started = Date.now();
    const slow = await cli(folder, ["get-app-state", "--timeout", "0.2"]);
    assert.equal(slow.code, 7);
    assert.equal(slow.document.error.code, "REQUEST_TIMEOUT");
    assert.ok(Date.now() - started < 2000);
  } finally {
    timers.forEach(clearInterval);
    drip.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("a deleted working folder only stops commands that need a relative path", async () => {
  await withApp(echo, async (root) => {
    const gone = { cwdGone: true };
    assert.equal((await cli(root, ["status"], gone)).code, 0);
    assert.equal((await cli(root, ["tools"], gone)).code, 0);
    assert.equal((await cli(root, ["--version"], gone)).code, 0);
    const absolute = path.join(root, "input.json");
    await writeFile(absolute, "{}");
    assert.equal(
      (await cli(root, ["get-app-state", "--input-file", absolute], gone)).code,
      0,
    );
    for (const args of [
      ["get-app-state", "--input-file", "input.json"],
      [
        "preview-frame",
        "--project-id",
        projectId,
        "--expected-updated-at",
        revision,
        "--kind",
        "cover",
        "--out",
        "cover.png",
      ],
      [
        "prepare-media",
        "--project-id",
        "sample",
        "--selection",
        "list.json",
        "--destination",
        "/absolute/out",
      ],
    ]) {
      const result = await cli(root, args, gone);
      assert.equal(result.code, 2, args.join(" "));
      assert.equal(result.document.error.code, "USAGE");
      assert.match(result.document.error.message, /no longer exists/);
    }
  });
});

const hiddenFiles = async (folder: string) =>
  (await readdir(folder)).filter((name) => name.startsWith(".reels-"));

test("a failed image write leaves nothing behind, so the safe retry works", async () => {
  const previewArgs = [
    "preview-frame",
    "--project-id",
    projectId,
    "--expected-updated-at",
    revision,
    "--kind",
    "cover",
  ];
  let folder = "";
  let locked = true;
  await withApp(
    async () => {
      // Writable at the --out check, not when the image is saved.
      await chmod(folder, locked ? 0o500 : 0o700);
      return { image: `data:image/png;base64,${png.toString("base64")}` };
    },
    async (root) => {
      folder = path.join(root, "images");
      await mkdir(folder);
      const target = path.join(folder, "cover.png");
      const failed = await cli(root, [...previewArgs, "--out", target]);
      await chmod(folder, 0o700);
      assert.equal(failed.code, 11);
      assert.equal(failed.document.error.code, "OUTPUT_WRITE_FAILED");
      assert.equal(failed.document.error.retry, "safe");
      assert.equal(failed.document.error.writeOutcome, "none");
      await assert.rejects(stat(target));
      assert.deepEqual(await hiddenFiles(folder), []);

      locked = false;
      const retried = await cli(root, [...previewArgs, "--out", target]);
      assert.equal(retried.code, 0);
      assert.deepEqual(await readFile(target), png);
      assert.equal((await stat(target)).mode & 0o777, 0o600);
      assert.deepEqual(await hiddenFiles(folder), []);
    },
  );
});

test("a relative profile with no working folder is explained, not a crash", async () => {
  await offlineRoot(async (root) => {
    const options = { cwdGone: true, env: { REELS_USER_DATA: "relative" } };
    const status = await cli(root, ["status"], options);
    assert.equal(status.code, 0);
    assert.equal(status.document.data.app.online, false);
    assert.equal(status.document.data.app.reason, "user_data_unresolved");
    assert.equal(status.document.data.userData, null);
    assert.match(status.document.data.hint, /REELS_USER_DATA/);
    for (const args of [
      ["get-project", "--project-id", projectId],
      ["prepare-media", "--list"],
    ]) {
      const { code, document } = await cli(root, args, options);
      assert.equal(code, 2, args.join(" "));
      assert.equal(document.error.code, "USAGE");
      assert.match(document.error.message, /REELS_USER_DATA/);
    }
  });
});

test("the remaining exit code rows hold", async () => {
  const previewArgs = [
    "preview-frame",
    "--project-id",
    projectId,
    "--expected-updated-at",
    revision,
    "--kind",
    "cover",
  ];
  let target = "";
  await withApp(
    async () => {
      // Appears between the --out check and the write, as another writer's file would.
      await writeFile(target, "someone else");
      return { image: `data:image/png;base64,${png.toString("base64")}` };
    },
    async (root) => {
      target = path.join(root, "raced.png");
      const raced = await cli(root, [...previewArgs, "--out", target]);
      assert.equal(raced.code, 2);
      assert.equal(raced.document.error.code, "OUTPUT_EXISTS");
      assert.equal(raced.document.error.retry, "fix_input");
      assert.equal(raced.document.error.writeOutcome, "none");
      assert.equal(await readFile(target, "utf8"), "someone else");
      assert.deepEqual(await hiddenFiles(root), []);
    },
  );
  await offlineRoot(async (root) => {
    const bug = await cli(root, [...updateArgs.slice(0, 1), "--input", "-"], {
      stdinFails: true,
    });
    assert.equal(bug.code, 1);
    assert.equal(bug.document.error.code, "INTERNAL");
    assert.equal(bug.document.error.retry, "no");
    assert.equal(bug.document.error.writeOutcome, "unknown");
  });
});

test("status stays a read when the app answers with an error", async () => {
  await withApp(failWith("런타임 확인 실패"), async (root) => {
    const result = await cli(root, ["status"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.document.data.app, {
      online: true,
      stateError: { code: "TOOL_ERROR", message: "런타임 확인 실패" },
    });
  });
  await offlineRoot(async (root) => {
    const usage = await cli(root, ["status", "--timeout", "0"]);
    assert.equal(usage.code, 2);
    assert.equal(usage.document.error.writeOutcome, "none");
  });
});

test("a schema failure names the flag in its message", async () => {
  await offlineRoot(async (root) => {
    const missing = await cli(root, ["get-project"]);
    assert.equal(
      missing.document.error.message,
      "--project-id (projectId): required",
    );
    assert.match(missing.stderr, /--project-id/);
    const nested = await cli(root, [
      "upsert-content",
      "--expected-updated-at",
      revision,
      "--content",
      "{}",
    ]);
    assert.match(
      nested.document.error.message,
      /^content\.\w+: required \(\+\d+ more\)$/,
    );
    assert.ok(nested.document.error.issues.length > 1);
  });
});

test("a video preview without a time is an input error, for the CLI and for MCP", async () => {
  await withApp(echo, async (root, calls) => {
    const result = await cli(root, [
      "preview-frame",
      "--project-id",
      projectId,
      "--expected-updated-at",
      revision,
      "--kind",
      "video",
      "--out",
      "v.png",
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.document.error.code, "INVALID_INPUT");
    assert.deepEqual(result.document.error.issues[0].path, ["time"]);
    assert.equal(calls.length, 0);
  });
  assert.equal(
    toolDefinitions.reels_preview_frame.input.safeParse({
      projectId,
      expectedUpdatedAt: revision,
      kind: "video",
    }).success,
    false,
  );
});

test("help and tool detail show allowed values and runnable examples", async () => {
  await offlineRoot(async (root) => {
    const help = (await cli(root, ["preview-frame", "--help"])).document.data
      .help;
    assert.match(help, /--kind <video\|cover>/);
    assert.match(help, /--project-id <uuid>/);
    assert.match(help, /--expected-updated-at <iso-datetime>/);
    assert.match(help, /Example: .*--kind cover --out frame\.png/);
    assert.match(help, /--time {2}Seconds\. Required when kind is video\./);
    const { data } = (await cli(root, ["tools", "start-render"])).document;
    assert.match(data.example, /--target video .*--wait$/);
    assert.deepEqual(
      data.flags.find((flag: any) => flag.flag === "--target").enum,
      ["video", "cover", "both"],
    );
    assert.equal(
      data.flags.find((flag: any) => flag.flag === "--project-id").format,
      "uuid",
    );
    assert.match(
      (await cli(root, ["tools", "upsert-content"])).document.data.inputSchema
        .properties.expectedUpdatedAt.description,
      /dashboard\.updatedAt from list_projects/,
    );
  });
});

test("tools resolve by every spelling and suggestions stay relevant", async () => {
  await withApp(echo, async (root) => {
    for (const args of [
      ["call", "get_app_state"],
      ["get_app_state"],
      ["reels_get_app_state"],
      ["get-app-state"],
    ]) {
      const result = await cli(root, args);
      assert.equal(result.code, 0, args.join(" "));
      assert.equal(result.document.tool, "reels_get_app_state");
    }
    assert.equal(
      (await cli(root, ["tools", "get_project"])).document.data.name,
      "reels_get_project",
    );
  });
  await offlineRoot(async (root) => {
    const suggestion = async (...args: string[]) =>
      (await cli(root, args)).document.error.didYouMean;
    assert.deepEqual(await suggestion("tools", "get-projct"), ["get-project"]);
    assert.ok((await suggestion("get-projct")).includes("get-project"));
    assert.deepEqual(await suggestion("-V"), []);
    assert.deepEqual(await suggestion("zzzzzz"), []);
    assert.ok((await suggestion("stauts")).includes("status"));
    for (const args of [
      ["help"],
      ["help", "status"],
      ["help", "get-project"],
    ]) {
      const result = await cli(root, args);
      assert.equal(result.code, 0, args.join(" "));
      assert.ok(result.document.data.help);
    }
  });
});

test("every summary reads as a complete sentence", async () => {
  await offlineRoot(async (root) => {
    const { tools } = (await cli(root, ["tools"])).document.data;
    for (const { name, summary } of tools) {
      const count = (mark: string) => summary.split(mark).length - 1;
      assert.equal(count("("), count(")"), name);
      assert.doesNotMatch(summary, /\b(?:e\.g|i\.e)\.$/, name);
    }
  });
});

const mergeArgs = [
  "merge-projects",
  "--target-id",
  "target",
  "--source-ids",
  '["source"]',
  "--expected-updated-at",
  revision,
];
const importArgs = ["import-video", "--source-path", "/absolute/in.mov"];
const correctArgs = [
  "correct-analysis",
  "--project-id",
  "sample",
  "--sample-id",
  "s1",
  "--expected-revision",
  "1",
  "--fields",
  "{}",
];
const formSaveArgs = [
  "form-save",
  "--form-id",
  formId,
  "--expected-revision",
  "1",
  "--answers",
  "[]",
];
const linkArgs = [
  "link-project-edit",
  "--project-id",
  "sample",
  "--edit",
  JSON.stringify({ kind: "video", id: projectId }),
  "--expected-updated-at",
  revision,
];
const reuseInput = JSON.stringify({
  sourcePath: "/absolute/in.mov",
  reuse: { projectId, expectedUpdatedAt: revision },
});
const failures: [string, string[], string[], RegExp?][] = [
  [
    "STALE_PROJECT",
    updateArgs,
    [`reels get-project --project-id ${projectId}`],
  ],
  [
    "STALE_PROJECT",
    renderArgs,
    [`reels get-project --project-id ${projectId}`],
  ],
  ["STALE_PROJECT", mergeArgs, ["reels list-projects"]],
  ["STALE_PROJECT", importArgs, ["reels list-projects"]],
  [
    "STALE_PROJECT",
    ["import-video", "--input", reuseInput],
    [`reels get-project --project-id ${projectId}`],
  ],
  ["STALE_DASHBOARD", mergeArgs, ["reels list-projects"], /updatedAt/],
  [
    "STALE_ANALYSIS",
    correctArgs,
    ["reels search-analysis --project-id sample"],
    /\.data\.revision/,
  ],
  [
    "CONTEXT_REVISION_REQUIRED",
    [
      "start-analysis",
      "--project-id",
      "sample",
      "--folder",
      "/absolute/folder",
    ],
    ["reels search-analysis --project-id sample"],
    /\.data\.revision/,
  ],
  [
    "STALE_FORM",
    formSaveArgs,
    [`reels form-get --form-id ${formId}`],
    /\.data\.revision/,
  ],
  [
    "STALE_INPUT",
    formSaveArgs,
    [`reels form-get --form-id ${formId}`],
    /\.data\.revision/,
  ],
  [
    "STALE_ARTIFACT",
    ["form-artifact", "--form-id", formId, "--path", "result.md"],
    [`reels form-get --form-id ${formId}`],
    /\.data\.revision/,
  ],
  [
    "REQUEST_TIMEOUT",
    updateArgs,
    [`reels get-project --project-id ${projectId}`],
  ],
  [
    "CONNECTION_LOST",
    updateArgs,
    [`reels get-project --project-id ${projectId}`],
  ],
  [
    "RESPONSE_INVALID",
    updateArgs,
    [`reels get-project --project-id ${projectId}`],
  ],
  ["REQUEST_TIMEOUT", importArgs, ["reels list-projects"]],
  [
    "REQUEST_TIMEOUT",
    ["import-video", "--input", reuseInput],
    [`reels get-project --project-id ${projectId}`],
  ],
  ["REQUEST_TIMEOUT", renderArgs, ["reels status"]],
  ["CONNECTION_LOST", renderArgs, ["reels status"]],
  ["REQUEST_TIMEOUT", mergeArgs, ["reels list-projects"]],
  ["REQUEST_TIMEOUT", linkArgs, ["reels get-content --project-id sample"]],
  [
    "REQUEST_TIMEOUT",
    ["cancel-render", "--job-id", jobId],
    [`reels get-render-job --job-id ${jobId}`],
  ],
  ["REQUEST_TIMEOUT", formSaveArgs, [`reels form-get --form-id ${formId}`]],
  [
    "REQUEST_TIMEOUT",
    correctArgs,
    ["reels search-analysis --project-id sample"],
  ],
  [
    "REQUEST_TIMEOUT",
    ["link-blog-reference", "--directory", "/absolute/folder"],
    ["reels list-blog-references"],
  ],
];

test("every next entry names the right read and is a command the CLI accepts", async () => {
  const entries = new Set<string>();
  const collect = (error: { next?: string[] }) =>
    (error.next ?? []).forEach((entry) => entries.add(entry));
  for (const [code, args, next, hint] of failures)
    await withApp(failWith(`${code}: x`), async (root) => {
      const { error } = (await cli(root, args)).document;
      const label = `${code} ${args[0]}`;
      assert.equal(error.code, code, label);
      assert.deepEqual(error.next, next, label);
      if (hint) assert.match(error.hint, hint, label);
      collect(error);
    });
  await withApp(failWith("UNKNOWN_TOOL: x"), async (root) =>
    collect((await cli(root, updateArgs)).document.error),
  );
  await offlineRoot(async (root) => {
    collect((await cli(root, ["get-app-state"])).document.error);
    collect((await cli(root, ["tools", "nope"])).document.error);
    collect((await cli(root, ["tools", "prepare-media"])).document.error);
    collect(
      (await cli(root, ["get-project", "--project-id", "abc"])).document.error,
    );
    collect(
      (await cli(root, ["prepare-media", "--list", "--project-id", "nope"]))
        .document.error,
    );
    assert.ok(entries.size > 8);
    for (const entry of entries) {
      const [program, command, ...rest] = entry.split(" ");
      assert.equal(program, "reels", entry);
      assert.ok(
        builtinCommands.includes(command) || toolSlugs.includes(command),
        entry,
      );
      assert.doesNotMatch(entry, /<\w+>/, entry);
      // Run for real: with the app closed, only argument errors exit 2.
      const { code } = await cli(root, [command, ...rest]);
      assert.notEqual(code, 2, entry);
    }
  });
});

test("a write cut off without an answer says what to inspect, and a read does not", async () => {
  await withApp(failWith("REQUEST_TIMEOUT: x"), async (root) => {
    const write = (await cli(root, updateArgs)).document.error;
    assert.equal(write.exitCode, 7);
    assert.equal(write.retry, "inspect_first");
    assert.equal(write.writeOutcome, "unknown");
    assert.match(write.hint, /may still apply/);
    const read = (await cli(root, ["get-project", "--project-id", projectId]))
      .document.error;
    assert.equal(read.retry, "safe");
    assert.ok(!Object.hasOwn(read, "next"));
    assert.ok(!Object.hasOwn(read, "hint"));
  });
  // An answer that is not a job leaves the same doubt as no answer.
  await withApp(
    async () => ({ nope: true }),
    async (root) => {
      const { error } = (await cli(root, [...renderArgs, "--wait"])).document;
      assert.equal(error.code, "RESPONSE_INVALID");
      assert.equal(error.writeOutcome, "unknown");
      assert.deepEqual(error.next, ["reels status"]);
    },
  );
});

test("a malformed id points to where ids come from", async () => {
  await offlineRoot(async (root) => {
    const project = (await cli(root, ["get-project", "--project-id", "abc"]))
      .document.error;
    assert.equal(project.code, "INVALID_INPUT");
    assert.deepEqual(project.next, ["reels list-projects"]);
    assert.match(project.hint, /editorProjects/);
    const job = (await cli(root, ["get-render-job", "--job-id", "abc"]))
      .document.error;
    assert.deepEqual(job.next, ["reels status"]);
    const form = (await cli(root, ["form-get", "--form-id", "abc"])).document
      .error;
    assert.deepEqual(form.next, ["reels forms-list"]);
    const other = (await cli(root, ["photos-index", "--date", "soon"])).document
      .error;
    assert.ok(!Object.hasOwn(other, "next"));
  });
});

test("--help as an option's value is a usage error, never a quiet success", async () => {
  await withApp(echo, async (root, calls) => {
    const write = [...updateArgs.slice(0, 5), "--patch"];
    for (const value of ["--help", "-h"]) {
      const result = await cli(root, [...write, value]);
      assert.equal(result.code, 2, value);
      assert.equal(result.document.error.code, "USAGE", value);
      assert.match(result.document.error.message, /starts with a dash/, value);
      assert.equal(result.document.error.writeOutcome, "not_applied", value);
    }
    const copied = await cli(root, ["prepare-media", "--project-id", "--help"]);
    assert.equal(copied.code, 2);
    const timeout = await cli(root, ["status", "--timeout", "--help"]);
    assert.equal(timeout.code, 2);
    assert.equal(calls.length, 0);
    // `=` makes it plainly a value, so it reaches the schema as one.
    const value = await cli(root, [...write.slice(0, 5), "--patch=--help"]);
    assert.equal(value.document.error.code, "INVALID_JSON");
    assert.equal(calls.length, 0);

    for (const args of [
      [...updateArgs, "--help"],
      [...updateArgs, "-h"],
      ["status", "--timeout", "abc", "--help"],
      ["prepare-media", "--list", "--help"],
    ]) {
      const help = await cli(root, args);
      assert.equal(help.code, 0, args.join(" "));
      assert.ok(help.document.data.help, args.join(" "));
    }
    assert.equal(calls.length, 0);
  });
});

test("usage and flags describe values without zod's internal names", async () => {
  for (const name of toolNames) {
    assert.doesNotMatch(toolUsage(name), /starts_with/, name);
    assert.doesNotMatch(toolExample(name), /starts_with/, name);
    for (const flag of toolFlags(name))
      assert.notEqual(flag.format, "starts_with", `${name} ${flag.flag}`);
  }
  assert.match(toolUsage("reels_start_analysis"), /--folder <abs-path>/);
  assert.match(toolUsage("reels_start_render"), /--output-path <abs-path>/);
  assert.match(toolUsage("reels_import_video"), /--source-path <abs-path>/);
  assert.match(toolUsage("reels_photos_index"), /--date <YYYY-MM-DD>/);
  assert.match(toolUsage("reels_photos_search"), /--start-date <YYYY-MM-DD>/);
  assert.match(toolUsage("reels_unlink_blog_reference"), /--id <hex64>/);
  const date = toolFlags("reels_photos_index")[0];
  assert.equal(date.format, "YYYY-MM-DD");
  assert.equal(date.pattern, "^\\d{4}-\\d{2}-\\d{2}$");
  assert.ok(
    !Object.hasOwn(toolFlags("reels_get_project")[0], "pattern"),
    "a named format needs no regular expression",
  );
});

/** Values for what an example leaves as a placeholder. */
const placeholderValues: Record<string, string> = {
  "<uuid>": projectId,
  "<iso-datetime>": revision,
  "<abs-path>": "/absolute/path",
  "<YYYY-MM-DD>": "2026-11-07",
  "<hex64>": "a".repeat(64),
  "<uri>": "https://example.com/post",
  "<string>": "sample",
  "<integer>": "1",
  "<number>": "1",
};
const jsonValues: Record<string, unknown> = {
  form: {
    version: 1,
    title: "Title",
    introduction: "",
    facts: [],
    questions: [{ id: "q", section: "S", prompt: "P" }],
  },
  answers: [],
  evidence: ["result.md"],
  fields: {},
  sourceIds: ["source"],
  paths: ["/absolute/path/final.mp4"],
  files: [{ sourcePath: "/absolute/path/final.mp4", name: "final.mp4", role: "final" }],
  edit: { kind: "video", id: projectId },
  content: {
    id: "sample",
    title: "Title",
    date: "2026-11-07",
    dateBasis: "capture",
    stage: "idea",
    nextAction: "",
    publicURL: "",
    localNotes: "",
    resources: [],
  },
};

test("every tool's example passes its schema once the placeholders are filled in", async () => {
  for (const name of toolNames) {
    const words = [...toolExample(name).matchAll(/'[^']*'|\S+/g)].map(
      ([word]) => word,
    );
    assert.deepEqual(words.slice(0, 2), ["reels", toolSlug(name)], name);
    const args = words.slice(2).map((word, index, all) => {
      if (word === "'<json>'") {
        const flag = toolFlags(name).find((f) => f.flag === all[index - 1]);
        assert.ok(flag && Object.hasOwn(jsonValues, flag.property), word);
        return JSON.stringify(jsonValues[flag.property]);
      }
      if (word.startsWith("'")) return word.slice(1, -1);
      assert.ok(
        !word.startsWith("<") || Object.hasOwn(placeholderValues, word),
        `${name}: ${word}`,
      );
      return placeholderValues[word] ?? word;
    });
    const input = await readToolInput(parseToolArgs(name, args), {} as CliIO);
    const parsed = (toolDefinitions[name].input as any).safeParse(input);
    assert.ok(parsed.success, `${name}: ${parsed.error?.message}`);
  }
  assert.equal(
    toolExample("reels_photos_search"),
    "reels photos-search --text cafe",
  );
});

test("every help page has an example and the top level says where ids come from", async () => {
  await offlineRoot(async (root) => {
    for (const args of [
      ["status", "--help"],
      ["tools", "--help"],
      ["call", "--help"],
      ["prepare-media", "--help"],
    ])
      assert.match(
        (await cli(root, args)).document.data.help,
        /^Example: reels /m,
        args.join(" "),
      );
    assert.match(
      (await cli(root, ["call", "--help"])).document.data.help,
      /--input/,
    );
    const top = (await cli(root, ["--help"])).document.data.help;
    assert.match(top, /reels list-projects/);
    assert.match(top, /editorProjects\[\]\.id/);
    assert.match(top, /dashboard\.projects\[\]\.id/);
    assert.match(top, /REELS_USER_DATA/);
    assert.match(top, /reels help exit-codes/);
    assert.match(top, /reels help agent/);
    assert.ok(top.split("\n").length <= 15, "--help stays short");
  });
});

test("reels help agent prints the reels-cli skill for this version", async () => {
  await offlineRoot(async (root) => {
    const result = await cli(root, ["help", "agent"]);
    assert.equal(result.code, 0);
    assert.equal(result.document.ok, true);
    const { data } = result.document;
    assert.deepEqual(Object.keys(data), ["guide", "name", "version"]);
    assert.equal(data.guide, await readFile("skills/reels-cli/SKILL.md", "utf8"));
    assert.equal(data.name, "reels-cli");
    assert.match(data.guide, /^---\nname: reels-cli\n/);
    assert.equal(
      data.version,
      JSON.parse(await readFile("package.json", "utf8")).version,
    );
  });
});

test("reels help exit-codes needs no repository and matches the documented table", async () => {
  await offlineRoot(async (root) => {
    const { data } = (await cli(root, ["help", "exit-codes"])).document;
    const docs = await readFile("docs/cli-usage.md", "utf8");
    const rows = data.exitCodes as { code: number; meaning: string }[];
    assert.deepEqual(
      rows.map(({ code }) => code),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 129, 130, 143],
    );
    for (const { code, meaning } of rows) {
      assert.match(data.help, new RegExp(`^${code} `, "m"));
      assert.ok(meaning, String(code));
      assert.match(docs, new RegExp(`^\\| (?:129, 130, 143|${code}) \\|`, "m"));
    }
  });
});

test("read-only commands report writeOutcome none for usage errors too", async () => {
  await offlineRoot(async (root) => {
    for (const args of [
      ["status", "--timeout", "0"],
      ["tools", "--foo"],
      ["tools", "nonexistent"],
      ["get-project", "--nope"],
      ["prepare-media", "--list", "--bad"],
      ["prepare-media", "--list", "--destination", "/absolute/out"],
    ]) {
      const { error } = (await cli(root, args)).document;
      assert.equal(error.exitCode, 2, args.join(" "));
      assert.equal(error.writeOutcome, "none", args.join(" "));
    }
    const write = (await cli(root, ["prepare-media", "--bad"])).document.error;
    assert.equal(write.writeOutcome, "not_applied");
  });
});

test("suggestions and tool lookups lead to the command an agent wanted", async () => {
  await offlineRoot(async (root) => {
    const error = async (...args: string[]) =>
      (await cli(root, args)).document.error;
    assert.equal((await error("list")).didYouMean[0], "list-projects");
    assert.equal((await error("project")).didYouMean.length, 3);
    for (const command of ["status", "doctor", "prepare-media", "call", "tools"]) {
      const builtin = await error("tools", command);
      assert.equal(builtin.code, "UNKNOWN_TOOL", command);
      assert.deepEqual(builtin.next, [`reels help ${command}`], command);
      assert.ok(!Object.hasOwn(builtin, "didYouMean"), command);
      assert.equal(await cli(root, ["help", command]).then((r) => r.code), 0);
    }
    assert.deepEqual((await error("call", "status")).next, [
      "reels help status",
    ]);
    assert.ok((await error("tools", "statu")).didYouMean.includes("status"));
    const { data } = (await cli(root, ["tools"])).document;
    assert.deepEqual(
      data.builtins.map(({ command }: { command: string }) => command),
      ["reels status", "reels doctor", "reels prepare-media", "reels collect-instagram-insights"],
    );
  });
});

test("merge, link and upsert all describe the dashboard revision", async () => {
  await offlineRoot(async (root) => {
    for (const tool of [
      "merge-projects",
      "link-project-edit",
      "upsert-content",
    ]) {
      const { data } = (await cli(root, ["tools", tool])).document;
      const flag = data.flags.find(
        ({ flag }: { flag: string }) => flag === "--expected-updated-at",
      );
      assert.match(flag.description, /dashboard\.updatedAt from list_projects/);
      assert.match(
        (await cli(root, ["help", tool])).document.data.help,
        /--expected-updated-at {2}Dashboard revision/,
      );
    }
    for (const [tool, source] of [
      ["correct-analysis", "search_analysis"],
      ["start-analysis", "search_analysis"],
      ["form-save", "form_get"],
      ["form-apply", "form_get"],
    ])
      assert.match(
        (await cli(root, ["help", tool])).document.data.help,
        new RegExp(`--expected-revision {2}revision returned by ${source}`),
      );
  });
});

/** The real dispatch and session, so a change to the app's job or error shape breaks this test. */
function realDispatch(session: AgentSession) {
  const project = {
    id: projectId,
    updatedAt: revision,
    settings: { cover: { time: 1 } },
  };
  const steps = ["running", "completed"];
  const editor = {
    busy: false,
    load: async () => project,
    render: async (): Promise<RenderJob> => ({
      id: jobId,
      projectId,
      state: "running",
      phase: "시작",
      progress: 0,
    }),
    job: async (id: string): Promise<RenderJob> => ({
      id,
      projectId,
      state: steps.shift() as RenderJob["state"],
      phase: "렌더링",
      progress: 100,
      outputPath: "/absolute/new.mov",
    }),
  };
  return createAgentDispatch({
    session,
    editor,
    dashboard: async () => ({}),
    content: {},
    preview: async () => {
      throw new Error("not used");
    },
    open() {},
    photos: async () => null,
  } as unknown as AgentPorts);
}

test("the CLI agrees with the real dispatch on jobs, revisions and busy edits", async () => {
  const session = new AgentSession();
  await withApp(realDispatch(session), async (root) => {
    const done = await cli(root, [...renderArgs, "--wait"]);
    assert.equal(done.code, 0);
    assert.equal(done.document.data.state, "completed");
    assert.equal(done.document.data.id, jobId);

    const stale = await cli(root, [
      ...renderArgs.slice(0, 3),
      "--expected-updated-at",
      "2026-10-27T00:00:01.000Z",
      ...renderArgs.slice(5),
    ]);
    assert.equal(stale.code, 5);
    assert.equal(stale.document.error.code, "STALE_PROJECT");
    assert.deepEqual(stale.document.error.next, [
      `reels get-project --project-id ${projectId}`,
    ]);

    session.update({
      projectId,
      dirty: true,
      time: 0,
      active: true,
      busy: false,
    });
    const busy = await cli(root, updateArgs);
    assert.equal(busy.code, 6);
    assert.equal(busy.document.error.code, "EDITOR_BUSY");
    assert.equal(busy.document.error.retry, "wait");
    assert.equal(busy.document.error.writeOutcome, "not_applied");
  });
});

/** A temp HOME, PATH and bundle for `reels doctor`; nothing outside the temp folder is read. */
async function doctorSetup(root: string) {
  const home = path.join(root, "home");
  const binDir = path.join(home, ".local", "bin");
  const launcher = path.join(binDir, "reels");
  const bundle = path.join(root, "app", "reels.mjs");
  const other = path.join(root, "other-bin");
  // The runtime a managed launcher execs; it stands in for the app's Electron binary.
  const runtime = path.join(root, "app", "Reels Dashboard's", "Electron");
  await mkdir(binDir, { recursive: true });
  await mkdir(path.dirname(runtime), { recursive: true });
  await mkdir(path.dirname(bundle), { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(bundle, "// bundle\n");
  const executable = async (file: string, text: string) => {
    await writeFile(file, text);
    await chmod(file, 0o755);
  };
  await executable(runtime, "#!/bin/sh\n");
  const managed = (target = bundle, runs = runtime) =>
    executable(launcher, cliLauncher(runs, target));
  const doctor = async (
    options: { pathEnv?: string; script?: string; extra?: string[] } = {},
  ) => {
    const result = await cli(root, ["doctor", ...(options.extra ?? [])], {
      env: {
        REELS_USER_DATA: root,
        HOME: home,
        PATH: options.pathEnv ?? binDir,
      },
      io: {
        script: options.script ?? bundle,
        versions: { node: "22.12.0" },
      },
    });
    assert.equal(result.code, 0);
    const checks = Object.fromEntries(
      result.document.data.checks.map((check: { id: string }) => [
        check.id,
        check,
      ]),
    );
    return { ...result, data: result.document.data, checks };
  };
  return { home, binDir, launcher, bundle, other, runtime, executable, managed, doctor };
}

const listTree = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true })).map(String).sort();

test("doctor reports a managed setup with the app closed, and writes nothing", async () => {
  await offlineRoot(async (root) => {
    const { managed, doctor, launcher, bundle, runtime } = await doctorSetup(root);
    await managed();
    const before = await listTree(root);
    const { data, checks, document } = await doctor();
    assert.deepEqual(await listTree(root), before);
    assert.ok(!Object.hasOwn(document, "tool"));
    assert.equal(data.healthy, false);
    assert.deepEqual(
      data.checks.map(({ id }: { id: string }) => id),
      [
        "runtime",
        "profile",
        "app",
        "app_version",
        "launcher",
        "launcher_bundle",
        "path_dir",
        "path_command",
      ],
    );
    for (const id of ["runtime", "profile", "launcher", "launcher_bundle", "path_dir", "path_command"])
      assert.equal(checks[id].ok, true, id);
    assert.equal(checks.app.ok, false);
    assert.match(checks.app.detail, /no_connection_file/);
    assert.match(checks.app.fix, /never launches/);
    assert.equal(checks.app_version.ok, null);
    assert.deepEqual(data.app, { online: false, reason: "no_connection_file" });
    assert.equal(data.userData, root);
    assert.deepEqual(data.launcher, {
      path: launcher,
      state: "managed",
      bundle,
      executable: runtime,
    });
    assert.deepEqual(data.cli, { version: data.cli.version, bundle, node: "22.12.0" });
    // The app verdict is the one `reels status` prints.
    const status = await cli(root, ["status"]);
    assert.deepEqual(status.document.data.app, data.app);
  });
});

test("doctor is healthy when the app answers and the launcher is on PATH", async () => {
  await withApp(echo, async (root) => {
    const { managed, doctor } = await doctorSetup(root);
    await managed();
    const { data, checks } = await doctor();
    assert.equal(checks.app.ok, true);
    assert.equal(data.app.online, true);
    assert.equal(data.healthy, true);
  });
});

test("doctor explains an unresolved profile without calling the app", async () => {
  await offlineRoot(async (root) => {
    const result = await cli(root, ["doctor"], {
      cwdGone: true,
      env: { REELS_USER_DATA: "relative", HOME: root, PATH: "" },
      io: { versions: { node: "22.12.0" } },
    });
    assert.equal(result.code, 0);
    const { data } = result.document;
    const checks = Object.fromEntries(
      data.checks.map((check: { id: string }) => [check.id, check]),
    );
    assert.equal(data.userData, null);
    assert.equal(data.app.reason, "user_data_unresolved");
    assert.equal(checks.profile.ok, false);
    assert.match(checks.profile.detail, /REELS_USER_DATA/);
    assert.equal(checks.app.ok, null);
    assert.equal(checks.launcher_bundle.ok, null);
    assert.equal(data.healthy, false);
  });
});

test("doctor tells a missing, foreign and symlinked launcher apart", async () => {
  await offlineRoot(async (root) => {
    const { doctor, executable, launcher, binDir, bundle, other } =
      await doctorSetup(root);

    const missing = await doctor();
    assert.equal(missing.data.launcher.state, "missing");
    assert.equal(missing.checks.launcher.ok, false);
    assert.match(missing.checks.launcher.fix, /never launches/);
    assert.equal(missing.checks.path_command.ok, false);
    // Another reels on PATH (say, npm link) still works, so the launcher is not a failure.
    await executable(path.join(other, "reels"), "#!/bin/sh\n");
    const elsewhere = await doctor({ pathEnv: `${binDir}:${other}` });
    assert.equal(elsewhere.checks.launcher.ok, null);
    assert.equal(elsewhere.checks.path_command.ok, true);
    // ~/.local/bin off PATH is not a failure then either: the npm-link setup is healthy.
    const linkedOnly = await doctor({ pathEnv: other });
    assert.equal(linkedOnly.checks.launcher.ok, null);
    assert.equal(linkedOnly.checks.path_dir.ok, null);
    assert.match(linkedOnly.checks.path_dir.detail, /instead/);
    assert.equal(linkedOnly.checks.path_command.ok, true);
    // Only the closed app is a failure, so healthy follows the app alone.
    assert.deepEqual(
      linkedOnly.data.checks
        .filter(({ ok }: { ok: boolean | null }) => ok === false)
        .map(({ id }: { id: string }) => id),
      ["app"],
    );
    assert.equal(elsewhere.data.command.onPath, path.join(other, "reels"));

    await executable(launcher, "#!/bin/sh\necho mine\n");
    const foreign = await doctor();
    assert.equal(foreign.data.launcher.state, "foreign");
    assert.equal(foreign.checks.launcher.ok, null);
    assert.match(foreign.checks.launcher.fix, /Remove it once/);
    assert.equal(foreign.checks.launcher_bundle.ok, null);
    assert.equal(foreign.checks.path_command.ok, true);

    await rm(launcher);
    await symlink(bundle, launcher);
    await chmod(bundle, 0o755);
    const linked = await doctor();
    assert.deepEqual(linked.data.launcher, {
      path: launcher,
      state: "symlink",
      target: bundle,
    });
    assert.equal(linked.checks.launcher.ok, null);
    assert.match(linked.checks.launcher.fix, /Remove the symlink once/);
    assert.equal(linked.checks.launcher_bundle.ok, true);

    await rm(launcher);
    await symlink(path.join(root, "gone.mjs"), launcher);
    const dangling = await doctor();
    assert.equal(dangling.checks.launcher.ok, false);
    assert.match(dangling.checks.launcher.detail, /does not exist/);
    assert.equal(dangling.data.healthy, false);
  });
});

test("doctor flags PATH without ~/.local/bin and a reels that shadows the launcher", async () => {
  await offlineRoot(async (root) => {
    const { doctor, managed, executable, other, binDir } =
      await doctorSetup(root);
    await managed();
    const off = await doctor({ pathEnv: `${other}::relative` });
    assert.equal(off.checks.path_dir.ok, false);
    assert.equal(off.checks.path_dir.fix, "Add ~/.local/bin to PATH.");
    assert.equal(off.checks.path_command.ok, false);
    assert.equal(off.data.command.binDirOnPath, false);

    await executable(path.join(other, "reels"), "#!/bin/sh\n");
    const shadowed = await doctor({ pathEnv: `${other}:${binDir}` });
    assert.equal(shadowed.checks.path_dir.ok, true);
    assert.equal(shadowed.checks.path_command.ok, false);
    assert.match(shadowed.checks.path_command.detail, /comes before/);
    assert.match(shadowed.checks.path_command.fix, /before /);
  });
});

test("doctor compares the launcher's bundle with the running one", async () => {
  await offlineRoot(async (root) => {
    const { doctor, managed, bundle } = await doctorSetup(root);
    await managed();
    const elsewhere = path.join(root, "checkout", "reels.mjs");
    const mismatch = await doctor({ script: elsewhere });
    assert.equal(mismatch.checks.launcher.ok, true);
    assert.equal(mismatch.checks.launcher_bundle.ok, false);
    assert.match(mismatch.checks.launcher_bundle.detail, new RegExp(bundle));
    assert.equal(mismatch.data.healthy, false);

    await managed(path.join(root, "moved", "reels.mjs"));
    const moved = await doctor();
    assert.equal(moved.checks.launcher.ok, false);
    assert.match(moved.checks.launcher.detail, /does not exist/);
    assert.equal(moved.checks.launcher_bundle.ok, null);
  });
});

test("doctor checks that the launcher's runtime exists and is executable", async () => {
  await offlineRoot(async (root) => {
    const { doctor, managed, runtime, bundle } = await doctorSetup(root);
    await managed(bundle, path.join(root, "gone", "Electron"));
    const gone = await doctor();
    assert.equal(gone.checks.launcher.ok, false);
    assert.match(gone.checks.launcher.detail, /runtime .*gone.* is missing or not executable/);
    assert.match(gone.checks.launcher.fix, /rewrites the launcher/);
    assert.equal(gone.data.healthy, false);

    await managed();
    await chmod(runtime, 0o644);
    const notExecutable = await doctor();
    assert.equal(notExecutable.checks.launcher.ok, false);
    assert.match(notExecutable.checks.launcher.detail, /not executable/);

    await chmod(runtime, 0o755);
    assert.equal((await doctor()).checks.launcher.ok, true);
  });
});

test("doctor checks the runtime against package.json engines", async () => {
  await offlineRoot(async (root) => {
    const { engines } = JSON.parse(await readFile("package.json", "utf8"));
    const run = (versions: { node: string; electron?: string }) =>
      cli(root, ["doctor"], {
        env: { REELS_USER_DATA: root, HOME: root, PATH: "" },
        io: { versions },
      }).then(({ document }) => document.data);
    const old = await run({ node: "22.11.9" });
    assert.equal(old.checks[0].id, "runtime");
    assert.equal(old.checks[0].ok, false);
    assert.match(old.checks[0].detail, new RegExp(engines.node));
    assert.ok(old.checks[0].fix);
    const electron = await run({ node: "24.1.0", electron: "40.0.0" });
    assert.equal(electron.checks[0].ok, true);
    assert.match(electron.checks[0].detail, /Electron 40\.0\.0 as Node 24\.1\.0/);
    assert.equal(electron.cli.electron, "40.0.0");
  });
});

test("doctor usage errors exit 2 and its help ends in an example", async () => {
  await offlineRoot(async (root) => {
    for (const args of [
      ["doctor", "--timeout", "0"],
      ["doctor", "--fix"],
      ["doctor", "extra"],
    ]) {
      const { code, document } = await cli(root, args);
      assert.equal(code, 2, args.join(" "));
      assert.equal(document.error.writeOutcome, "none", args.join(" "));
      if (args[1] !== "--timeout")
        assert.equal(document.error.usage, "reels doctor [--timeout <s>]");
    }
    const help = (await cli(root, ["help", "doctor"])).document.data.help;
    assert.match(help, /^Example: reels doctor$/m);
    assert.match(help, /never applies/);
  });
});
