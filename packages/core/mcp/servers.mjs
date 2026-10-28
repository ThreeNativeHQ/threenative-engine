// The MCP servers a ThreeNative project always has. `@threenative/core` is a direct dependency of
// every generated game, so `./node_modules/@threenative/core/mcp/<file>` is a path that resolves
// under npm, pnpm and yarn alike — unlike `./node_modules/threenative-asset-mcp/...`, which only
// exists when the package manager hoists, and which a project that never listed the server as a
// direct dependency does not have at all.
export const MCP_SERVERS = Object.freeze({
  "threenative-assets": Object.freeze({
    command: "node",
    args: Object.freeze(["./node_modules/@threenative/core/mcp/assets.mjs"]),
    // Entries rather than an object literal: these are environment variable names, not identifiers,
    // and written as property names they read as names the naming rule must judge.
    env: Object.freeze(
      Object.fromEntries([
        ["ASSET_DOWNLOAD_DIR", "./public/assets"],
        ["AUDIO_DOWNLOAD_DIR", "./public/audio"],
      ]),
    ),
  }),
  "threenative-sculpt": Object.freeze({
    command: "node",
    args: Object.freeze(["./node_modules/@threenative/core/mcp/sculpt.mjs"]),
  }),
  "threenative-engine": Object.freeze({
    command: "node",
    args: Object.freeze(["./node_modules/@threenative/core/mcp/engine.mjs"]),
  }),
  // Drives an installed Blender headlessly so a downloaded .fbx becomes a GLB. It ships no
  // Blender and probes for one only when a tool is called, so a project that never converts a
  // model pays nothing for having this server wired.
  "threenative-blender": Object.freeze({
    command: "node",
    args: Object.freeze(["./node_modules/@threenative/core/mcp/blender.mjs"]),
  }),
  // Cooks a starter terrain kit into a world.glb. The server lives in the optional
  // `@threenative/terrain` package, which the shim resolves from the project at launch.
  "threenative-terrain": Object.freeze({
    command: "node",
    args: Object.freeze(["./node_modules/@threenative/core/mcp/terrain.mjs"]),
  }),
  // Inspects, attaches, edits and verifies character animation. Every operation is a build-time
  // edit of one GLB, so a game that animates nothing pays for nothing.
  "threenative-animation": Object.freeze({
    command: "node",
    args: Object.freeze(["./node_modules/@threenative/core/mcp/animation.mjs"]),
  }),
});

/** The external package each shim launches. Core installs asset and sculpt transitively and bundles
 * engine discovery itself: a game author must never know these package names or install them
 * separately. The pinned engine version remains an emergency fallback for a legacy development
 * checkout whose bundle has not been built. */
export const MCP_PACKAGES = Object.freeze({
  assets: Object.freeze({ name: "threenative-asset-mcp", version: "0.14.0" }),
  terrain: Object.freeze({ name: "@threenative/terrain", version: "0.1.2" }),
  sculpt: Object.freeze({ name: "threenative-sculpt-mcp", version: "0.2.2" }),
  engine: Object.freeze({ name: "threenative-engine-mcp", version: "0.2.6" }),
  blender: Object.freeze({ name: "threenative-blender-mcp", version: "0.1.6" }),
  animation: Object.freeze({ name: "threenative-animation-mcp", version: "0.1.3" }),
});

/** How one host spells a stdio MCP server. Hosts agree on what to run and disagree on where to
 * write it down, so the servers are declared once above and translated here. `key` is the property
 * the host reads its server table from; `entry` is one server in that host's own shape. */
const SERVER_FORMATS = Object.freeze({
  // Claude Code (`.mcp.json`), Cursor and the Gemini CLI all read this one.
  mcpServers: Object.freeze({
    key: "mcpServers",
    entry: (server) => ({
      command: server.command,
      args: [...server.args],
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
    }),
  }),
  // VS Code names the table `servers` and requires an explicit transport per server.
  vscode: Object.freeze({
    key: "servers",
    entry: (server) => ({
      type: "stdio",
      command: server.command,
      args: [...server.args],
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
    }),
  }),
  // opencode folds the command and its arguments into one array and spells the environment
  // `environment`. A server it does not mark enabled is written down and never started.
  opencode: Object.freeze({
    key: "mcp",
    entry: (server) => ({
      type: "local",
      command: [server.command, ...server.args],
      enabled: true,
      ...(server.env === undefined ? {} : { environment: { ...server.env } }),
    }),
  }),
  // Zed calls them context servers and needs `source: "custom"` to accept a command of our own.
  zed: Object.freeze({
    key: "context_servers",
    entry: (server) => ({
      source: "custom",
      command: server.command,
      args: [...server.args],
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
    }),
  }),
});

export const SERVER_FORMAT_NAMES = Object.freeze(Object.keys(SERVER_FORMATS));

/** Adds the ThreeNative servers to an existing config without touching anything else in it, and
 * reports whether the file needs rewriting. Fails closed on a config that is not an object: an
 * unreadable config is the user's, and overwriting it would lose servers we did not write. */
export function mergeMcpServers(existing, format = "mcpServers") {
  const shape = SERVER_FORMATS[format];
  if (shape === undefined) throw new Error(`Unknown MCP config format '${format}'.`);
  const malformed =
    existing !== undefined &&
    (typeof existing !== "object" || existing === null || Array.isArray(existing));
  if (malformed) {
    throw new Error("MCP config root must be an object.");
  }
  const previous = existing ?? {};
  const existingServers = previous[shape.key];
  if (
    existingServers !== undefined &&
    (typeof existingServers !== "object" ||
      existingServers === null ||
      Array.isArray(existingServers))
  ) {
    throw new Error(`MCP config '${shape.key}' must be an object.`);
  }
  const servers = { ...(existingServers ?? {}) };
  for (const [name, server] of Object.entries(servers)) {
    if (typeof server !== "object" || server === null || Array.isArray(server)) {
      throw new Error(`MCP server '${name}' in '${shape.key}' must be an object.`);
    }
  }
  let changed = false;
  const conflicts = [];
  for (const [name, server] of Object.entries(MCP_SERVERS)) {
    const wanted = shape.entry(server);
    if (Object.hasOwn(servers, name)) {
      if (JSON.stringify(servers[name]) !== JSON.stringify(wanted)) conflicts.push(name);
      continue;
    }
    servers[name] = wanted;
    changed = true;
  }
  return { changed, conflicts, config: { ...previous, [shape.key]: servers } };
}

/** One server as a Codex TOML table. Derived from `MCP_SERVERS` rather than written out beside it:
 * two hand-maintained lists of the same three servers drift, and the drift is silent until an
 * agent in Codex quietly has no asset tools. */
function codexServerBlock(name, server) {
  const args = server.args.map((argument) => JSON.stringify(argument)).join(", ");
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${JSON.stringify(server.command)}`,
    `args = [${args}]`,
  ];
  if (server.env !== undefined) {
    lines.push("", `[mcp_servers.${name}.env]`);
    for (const [key, value] of Object.entries(server.env)) {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

export const CODEX_MCP_SERVERS = Object.freeze(
  Object.entries(MCP_SERVERS).map(([name, server]) =>
    Object.freeze({ body: codexServerBlock(name, server), name }),
  ),
);
