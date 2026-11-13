#!/usr/bin/env node
import { applyThreePatch } from "./apply-three-patch.mjs";
import { runMcpSetup } from "./ensure-mcp.mjs";

await applyThreePatch();
runMcpSetup();
