#!/usr/bin/env node
import { launchMcpServer } from "./launch.mjs";
import { MCP_PACKAGES } from "./servers.mjs";

// The terrain server is not bundled here: `@threenative/terrain` already depends on core, so core
// carrying it would close a dependency cycle through `@threenative/assets`. The shim starts the
// project's installed `@threenative/terrain` bin and falls back to the pinned version over npx.
await launchMcpServer(MCP_PACKAGES.terrain);
