#!/usr/bin/env node
import { launchMcpServer } from "./launch.mjs";
import { MCP_PACKAGES } from "./servers.mjs";

await launchMcpServer(MCP_PACKAGES.devtools);
