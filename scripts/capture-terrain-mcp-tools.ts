#!/usr/bin/env tsx
// Writes `packages/create-threenative/terrain-mcp-tools.json` from the tool table the terrain MCP
// server serves. The server ships its source in this repository, so `mcp-tool-schemas.spec.ts`
// compares this snapshot to that table and `verify-golden-path.ts` compares its tool names to a
// live `tools/list`.
//
//   pnpm tsx scripts/capture-terrain-mcp-tools.ts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TERRAIN_TOOLS } from "../packages/terrain/src/mcp/tools.js";

const REPO = path.resolve(import.meta.dirname, "..");
const SNAPSHOT = path.join(REPO, "packages/create-threenative/terrain-mcp-tools.json");
const manifest = JSON.parse(
  readFileSync(path.join(REPO, "packages/terrain/package.json"), "utf8"),
) as {
  version: string;
};

const snapshot = {
  comment: `The terrain MCP surface a generated project gets once it installs @threenative/terrain. \`tools\` is set-equal to the tool table version ${manifest.version} serves. Regenerate with \`pnpm tsx scripts/capture-terrain-mcp-tools.ts\`.`,
  version: manifest.version,
  serverInfo: { name: "threenative-terrain", version: manifest.version },
  recommended: ["terrain_generate", "terrain_patch"],
  tools: TERRAIN_TOOLS.map((tool) => tool.name).sort(),
  inputSchemas: Object.fromEntries(TERRAIN_TOOLS.map((tool) => [tool.name, tool.inputSchema])),
  descriptions: Object.fromEntries(TERRAIN_TOOLS.map((tool) => [tool.name, tool.description])),
};
writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
process.stdout.write(`terrain MCP surface: ${snapshot.tools.length} tool(s) -> ${SNAPSHOT}\n`);
