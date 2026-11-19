// Invocation-local settings: never rewrite user config, credentials or AGENTS.md.
// Context arrives on stdin, so the child registers no MCP server at all.
export function analysisCodexSettings() {
  const values: Record<string, string | number | boolean | string[]> = {
    approval_policy: "never",
    project_doc_max_bytes: 0,
    "skills.max_context_tokens": 1,
    web_search: "disabled",
    "memories.use_memories": false,
    "memories.generate_memories": false,
  };
  return [
    ...[
      "apps",
      "plugins",
      "memories",
      "shell_tool",
      "skill_search",
      "multi_agent",
    ].flatMap((f) => ["--disable", f]),
    ...Object.entries(values).flatMap(([k, v]) => [
      "-c",
      `${k}=${JSON.stringify(v)}`,
    ]),
  ];
}
export function analysisCodexEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "CODEX_HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.PATH = `${source.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`;
  env.RUST_LOG = "error";
  env.CODEX_LOCAL_CHANNEL_DISABLED = "1";
  return env;
}
