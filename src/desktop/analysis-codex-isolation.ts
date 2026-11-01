// Invocation-local settings: never rewrite user config, credentials or AGENTS.md.
export function analysisCodexSettings(
  serverPath: string,
  manifest: string,
  receipt: string,
) {
  const values: Record<string, string | number | boolean | string[]> = {
    approval_policy: "never",
    project_doc_max_bytes: 0,
    "skills.max_context_tokens": 1,
    web_search: "disabled",
    "memories.use_memories": false,
    "memories.generate_memories": false,
    "mcp_servers.reels_analysis.command": process.execPath,
    "mcp_servers.reels_analysis.args": [serverPath, manifest, receipt],
    "mcp_servers.reels_analysis.env.ELECTRON_RUN_AS_NODE": "1",
    "mcp_servers.reels_analysis.required": true,
    "mcp_servers.reels_analysis.enabled_tools": ["get_analysis_context"],
    "mcp_servers.reels_analysis.startup_timeout_sec": 15,
    "mcp_servers.reels_analysis.tool_timeout_sec": 15,
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
