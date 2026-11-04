import { openFormInput } from "../../shared/input-forms";
import { callAgent } from "../../shared/lib/agent-socket";
import os from "node:os";
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { WorkflowRuntime } from "./runtime";
import { CodexExecutor, type SdkFactory } from "./codex-executor";
import {
  sdkJobIdInput,
  workflowAction,
  WORKFLOW_PROTOCOL_VERSION,
} from "../../shared/workflow";
import { configureObservation } from "../observability/configure";

export async function startWorkflowServer(options: {
  root: string;
  port: number;
  webRoot?: string;
  sdkFactory?: SdkFactory;
  sdkEnv?: NodeJS.ProcessEnv;
  openForm?: (formId: string) => Promise<unknown>;
  /** True when hosted inside the desktop app instead of `npm run start:server`. */
  embedded?: boolean;
}) {
  const runtime = await WorkflowRuntime.open(options.root);
  // Storage identity for the desktop handshake: a client shares this server only
  // when its own data dir resolves to the same path.
  const dataRoot = await realpath(options.root).catch(() =>
    path.resolve(options.root),
  );
  const telemetry = await configureObservation(
    options.sdkEnv ?? process.env,
  ).catch(async (error) => {
    await runtime.close();
    throw error;
  });
  const executor = new CodexExecutor(
    runtime,
    options.root,
    options.sdkFactory,
    options.sdkEnv,
    telemetry.observer,
  );
  const webRoot = path.resolve(options.webRoot ?? "dist");
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (code: number, value: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      // Loopback-only and exact Host/Origin checks prevent remote pages driving local writes.
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : options.port;
      const host = `127.0.0.1:${port}`;
      if (req.headers.host !== host)
        return json(403, { error: "Invalid Host" });
      if (req.headers.origin && req.headers.origin !== `http://${host}`)
        return json(403, { error: "Invalid Origin" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname === "/" && !url.search) {
        res.writeHead(302, { Location: "/?workflow=1" });
        res.end();
        return;
      }
      if (url.pathname === "/api/workflows" && req.method === "GET")
        return json(200, { runs: await runtime.list() });
      if (
        url.pathname === "/api/workflows/capabilities" &&
        req.method === "GET"
      )
        return json(200, {
          ...executor.capabilities(),
          observability: { version: 1, ...telemetry.configuration },
          // Clients compare protocol + actions to detect an outdated server, and the
          // data root to avoid sharing a server that uses another data dir.
          server: {
            protocol: WORKFLOW_PROTOCOL_VERSION,
            actions: workflowAction.options,
            root: dataRoot,
            pid: process.pid,
            embedded: options.embedded ?? false,
          },
        });
      if (url.pathname === "/api/workflows/job" && req.method === "GET") {
        const { jobId } = sdkJobIdInput.parse({
          jobId: url.searchParams.get("id"),
        });
        return json(200, runtime.getJob(jobId));
      }
      if (url.pathname === "/api/workflows/run" && req.method === "GET")
        return json(
          200,
          await runtime.get({ runId: url.searchParams.get("id") }),
        );
      if (url.pathname.startsWith("/api/workflows/") && req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(415, { error: "JSON required" });
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 256000)
            throw new Error("Request too large");
        }
        const input = JSON.parse(body);
        switch (url.pathname) {
          case "/api/workflows/forms-list":
            return json(200, runtime.listForms(input));
          case "/api/workflows/form-create":
            return json(200, await runtime.createForm(input));
          case "/api/workflows/form-get":
            return json(200, runtime.getForm(input));
          case "/api/workflows/form-save":
            return json(200, await runtime.saveForm(input));
          case "/api/workflows/form-results":
            return json(200, runtime.formResults(input));
          case "/api/workflows/form-apply":
            return json(200, await runtime.applyForm(input));
          case "/api/workflows/form-wait":
            return json(200, await runtime.waitForm(input));
          case "/api/workflows/form-artifact":
            return json(200, await runtime.formArtifact(input));
          case "/api/workflows/form-media":
            return json(200, await runtime.formMedia(input));
          case "/api/workflows/form-sync":
            return json(200, await runtime.syncForm(input));
          case "/api/workflows/form-open": {
            const request = openFormInput.parse(input);
            runtime.getForm({ formId: request.formId });
            if (request.surface === "desktop")
              await (
                options.openForm ??
                ((id) =>
                  callAgent(
                    process.env.REELS_USER_DATA ??
                      path.join(
                        os.homedir(),
                        "Library/Application Support/Reels Dashboard",
                      ),
                    "reels_open_input_form",
                    { formId: id },
                  ))
              )(request.formId);
            return json(200, {
              formId: request.formId,
              url: `http://${host}/?workflow=1&form=${encodeURIComponent(request.formId)}`,
              opened: request.surface === "desktop",
            });
          }
          case "/api/workflows/create":
            return json(200, await runtime.create(input));
          case "/api/workflows/followups-open":
            return json(200, await runtime.openFollowups(input));
          case "/api/workflows/experience-save":
            return json(200, await runtime.saveExperience(input));
          case "/api/workflows/experience-media":
            return json(200, await runtime.experienceMedia(input));
          case "/api/workflows/submit":
            return json(200, await runtime.submit(input));
          case "/api/workflows/restart":
            return json(200, await runtime.restart(input));
          case "/api/workflows/execute":
            return json(200, await executor.execute(input));
          case "/api/workflows/review-markup":
            return json(200, await executor.reviewMarkup(input));
          case "/api/workflows/review-bundles":
            return json(200, await executor.reviewBundles(input));
          case "/api/workflows/suggest-inline": {
            // Synchronous and transient: abort the SDK call when the caller goes away.
            const controller = new AbortController();
            res.once("close", () => {
              if (!res.writableFinished)
                controller.abort(new Error("Client disconnected"));
            });
            try {
              return json(
                200,
                await executor.suggestInline(input, controller.signal),
              );
            } catch (error) {
              if (res.destroyed) return;
              throw error;
            }
          }
          case "/api/workflows/chat-blog": {
            const controller = new AbortController();
            res.once("close", () => {
              if (!res.writableFinished)
                controller.abort(new Error("Client disconnected"));
            });
            try {
              return json(200, await executor.chatBlog(input, controller.signal));
            } catch (error) {
              if (res.destroyed) return;
              throw error;
            }
          }
          case "/api/workflows/stop":
            return json(
              200,
              await executor.stop(sdkJobIdInput.parse(input).jobId),
            );
          default:
            return json(404, { error: "Unknown workflow action" });
        }
      }
      if (url.pathname.startsWith("/api/"))
        return json(404, { error: "Unknown API" });
      if (req.method !== "GET")
        return json(405, { error: "Method not allowed" });
      const relative =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname).slice(1);
      const file = await realpath(path.resolve(webRoot, relative));
      if (
        !file.startsWith((await realpath(webRoot)) + path.sep) ||
        !(await stat(file)).isFile()
      )
        return json(404, { error: "Not found" });
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      };
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(await readFile(file));
    } catch (e) {
      json(400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", resolve);
    });
  } catch (e) {
    await telemetry.close();
    await runtime.close();
    throw e;
  }
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    /** SDK jobs and inline suggestions that closing this server would interrupt. */
    runningJobs: () => executor.running,
    close: async () => {
      runtime.stopFormWaits();
      await executor.close();
      await telemetry.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await runtime.close();
    },
  };
}
