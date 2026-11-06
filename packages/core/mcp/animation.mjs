#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchMcpServer } from "./launch.mjs";
import { MCP_PACKAGES } from "./servers.mjs";

// Core carries the built animation server beside this shim, exactly as it carries Blender's, so a
// project that installed `@threenative/core` has working animation tools with no network and no
// extra install. The npx fallback below fetches the published `threenative-animation-mcp` at the
// version `servers.mjs` pins, which `prepare-release.ts` keeps equal to the package (PRD-827).
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
