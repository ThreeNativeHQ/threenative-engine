import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODEX_MCP_SERVERS, mergeMcpServers } from "./servers.mjs";

/** The project being installed into, or undefined when this install has no project to write to —
 * a nested dependency install, or core's own workspace build. */
export function installTarget(environment = process.env, cwd = process.cwd()) {
  const target = path.resolve(environment.INIT_CWD ?? cwd);
  if (target.split(path.sep).includes("node_modules")) return undefined;
  const manifestPath = path.join(target, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
    return undefined;
  if (manifest.name === "@threenative/core") return undefined;
  const dependencyGroups = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
  const declaresCore = dependencyGroups.some(
    (dependencies) =>
      typeof dependencies === "object" &&
      dependencies !== null &&
      Object.hasOwn(dependencies, "@threenative/core"),
  );
  return declaresCore ? target : undefined;
}

/** Every agent host that reads a **project-scoped** MCP config, and the file each one reads.
 *
 * Project-scoped is the whole admission rule. A host that only reads a machine-wide config
 * (Windsurf, Cline, Amp, the JetBrains assistants) is deliberately absent: installing a library
 * into one game must never edit a file that governs every other project on the machine. Those
 * hosts are wired by hand, and `docs/architecture/` says so. */
export const MCP_HOSTS = Object.freeze([
  Object.freeze({
    id: "claude-code",
    label: "Claude Code",
    file: ".mcp.json",
    format: "mcpServers",
  }),
  Object.freeze({ id: "leanpi", label: "leanpi", file: ".leanpi/mcp.json", format: "leanpi" }),
  Object.freeze({ id: "codex", label: "Codex", file: ".codex/config.toml", format: "codex" }),
  Object.freeze({ id: "cursor", label: "Cursor", file: ".cursor/mcp.json", format: "mcpServers" }),
  Object.freeze({ id: "vscode", label: "VS Code", file: ".vscode/mcp.json", format: "vscode" }),
  Object.freeze({
    id: "gemini-cli",
    label: "Gemini CLI",
    file: ".gemini/settings.json",
    format: "mcpServers",
  }),
  Object.freeze({
    id: "opencode",
    label: "opencode",
    file: "opencode.json",
    format: "opencode",
    // Written only when this installer creates the file, so a second install still reports
    // "unchanged" rather than rewriting a config the user has since edited.
    seed: Object.freeze({ $schema: "https://opencode.ai/config.json" }),
  }),
  Object.freeze({ id: "zed", label: "Zed", file: ".zed/settings.json", format: "zed" }),
]);

/** Adds the ThreeNative servers to one host's JSON config, creating it when absent. Returns what it
 * did so the installer can say so once and stay quiet otherwise. */
export function ensureJsonMcpConfig(target, file, format, seed = undefined) {
  const configPath = path.join(target, file);
  let existing;
  if (existsSync(configPath)) {
    // A config we cannot parse is still the user's. Rewriting it would drop servers we never wrote.
    try {
      existing = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      return "unreadable";
    }
  }
  let merged;
  try {
    merged = mergeMcpServers(existing, format);
  } catch {
    return "unreadable";
  }
  const { changed, config, conflicts } = merged;
  if (!changed) return conflicts.length > 0 ? "conflict" : "unchanged";
  const written = existing === undefined ? { ...seed, ...config } : config;
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(written, null, 2)}\n`);
  return conflicts.length > 0 ? "conflict" : existing === undefined ? "created" : "updated";
}

/** Adds the ThreeNative servers to `<target>/.mcp.json`, the config Claude Code reads. */
export function ensureMcpConfig(target) {
  return ensureJsonMcpConfig(target, ".mcp.json", "mcpServers");
}

/** Adds any missing ThreeNative servers to Codex's project-scoped MCP config without replacing
 * user-authored settings or server definitions. TOML rather than JSON, so this one appends text
 * instead of re-serialising: a config we cannot parse back is one we must not rewrite. */
export function ensureCodexMcpConfig(target) {
  const directory = path.join(target, ".codex");
  const configPath = path.join(directory, "config.toml");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const missing = CODEX_MCP_SERVERS.filter(
    ({ name }) => !existing.includes(`[mcp_servers.${name}]`),
  );
  if (missing.length === 0) return "unchanged";
  mkdirSync(directory, { recursive: true });
  const separator =
    existing.length === 0 || existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
  writeFileSync(
    configPath,
    `${existing}${separator}${missing.map(({ body }) => body).join("\n\n")}\n`,
  );
  return existing.length === 0 ? "created" : "updated";
}

/** Writes the engine server's tool schemas into leanpi's schema cache, the file its `/mcp refresh`
 * writes. leanpi admits no MCP tool whose schema is not cached, so a cold project offered no engine
 * tool until the user ran that command. Other cached servers are kept. */
export function ensureLeanpiSchemaCache(target, tools) {
  const cachePath = path.join(target, ".leanpi", "cache", "mcp-catalog.json");
  let cache = {};
  const existed = existsSync(cachePath);
  if (existed) {
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf8"));
    } catch {
      return "unreadable";
    }
  }
  const servers = cache?.servers ?? {};
  const wanted = tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  if (JSON.stringify(servers["threenative-engine"]?.tools) === JSON.stringify(wanted))
    return "unchanged";
  const updatedAt = new Date().toISOString();
  const written = {
    ...cache,
    servers: { ...servers, "threenative-engine": { updatedAt, tools: wanted } },
  };
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(written, null, 2)}\n`);
  return existed ? "updated" : "created";
}

/** Wires every host in `MCP_HOSTS`, mapping host id to what the write did. One host's unreadable
 * or unwritable config never stops the rest: a project with a hand-edited `.cursor/mcp.json`
 * should still get its Codex and VS Code tools. */
export function ensureHostMcpConfigs(target) {
  const outcomes = new Map();
  for (const host of MCP_HOSTS) {
    try {
      outcomes.set(
        host.id,
        host.format === "codex"
          ? ensureCodexMcpConfig(target)
          : ensureJsonMcpConfig(target, host.file, host.format, host.seed),
      );
    } catch {
      outcomes.set(host.id, "unreadable");
    }
  }
  return outcomes;
}
