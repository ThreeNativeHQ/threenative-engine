#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchMcpServer } from "./launch.mjs";
import { MCP_PACKAGES } from "./servers.mjs";

// Core carries the built animation server beside this shim, exactly as it carries Blender's, so a
// project that installed `@threenative/core` has working animation tools with no network and no
// extra install. It must stay that way for a while: `threenative-animation-mcp` is not published
// yet, so the npx fallback below cannot work — it is the E404 that made the Blender bundle
// mandatory, and `mcp-install.spec.ts` holds the same line for this server.
const localServer = path.resolve(fileURLToPath(import.meta.url), "..", "animation-server.mjs");
if (existsSync(localServer)) {
  const { runServer } = await import("./animation-server.mjs");
  runServer();
} else {
  process.stderr.write(
    `TN_MCP_ANIMATION_FALLBACK: no bundled animation server at ${localServer}; fetching ${MCP_PACKAGES.animation.name}@${MCP_PACKAGES.animation.version} over the network instead.\n`,
  );
  await launchMcpServer(MCP_PACKAGES.animation);
}
