// PRD-866 Phase 3: three seeds give three forests. Cooks "a spruce forest under mountains" through
// the terrain MCP server (stdio JSON-RPC, as an agent calls it) with seeds 1, 2 and 3 in a scratch
// game project, bakes each with `STRATA_WORLD`, and asserts three ground hashes, three massif poses
// and the backdrop gates on each ring. Then bakes the pinned forest again.
// usage: node scripts/verify-variations.mjs [--keep <dir>]   (network on a cold tile cache)
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { terrainStats } from "@threenative/terrain";

const example = fileURLToPath(new URL("..", import.meta.url));
const repo = join(example, "..", "..");
const keep = process.argv.indexOf("--keep");
const root = keep > 0 ? process.argv[keep + 1] : mkdtempSync(join(tmpdir(), "strata-variations-"));
const REQUEST = "a spruce forest under mountains";
const SEEDS = [1, 2, 3];

// A game project the cook resolves `@threenative/assets` and its asset source from.
mkdirSync(join(root, "node_modules", "@threenative"), { recursive: true });
try {
  symlinkSync(
    join(repo, "packages", "assets"),
    join(root, "node_modules", "@threenative", "assets"),
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
writeFileSync(
  join(root, "threenative.config.ts"),
  'export default { assets: { source: "assets" } };\n',
);

/** One terrain MCP server: `call(name, args)` answers a tools/call with its parsed JSON text. */
function server() {
  const child = spawn(
    process.execPath,
    [join(repo, "packages", "terrain", "dist", "mcp", "server.js")],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const waiting = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  let next = 0;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    async start() {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "verify-variations", version: "1" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    },
    async call(name, args) {
      const { result, error } = await request("tools/call", { name, arguments: args });
      assert(!error, `${name}: ${JSON.stringify(error)}`);
      const text = result.content[0].text;
      assert(!result.isError, `${name}: ${text}`);
      return JSON.parse(text);
    },
    stop: () => child.kill(),
  };
}

const bake = (env) =>
  execFileSync(process.execPath, ["scripts/bake.mjs", "--force"], {
    cwd: example,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
const readWorld = (file) =>
  JSON.parse(readFileSync(join(example, "src", "world", file), "utf8")).forest;

const mcp = server();
await mcp.start();
const results = [];
try {
  for (const seed of SEEDS) {
    const out = `assets/worlds/seed-${seed}`;
    const cooked = await mcp.call("terrain_generate", { request: REQUEST, seed, out });
    assert.deepEqual(cooked.decided.backdrop, { value: "massif", source: "default" });
    assert.equal(cooked.backdrop.source, "massif", `seed ${seed}: no massif in the far ring`);
    bake({ STRATA_WORLD: join(root, out) });
    const ground = readWorld("baked.json");
    const ring = readWorld("horizon.json");
    const stats = terrainStats(ring.heights, ring.resolution, ring.size);
    const row = {
      seed,
      landform: cooked.decided.landform.value,
      ground: createHash("sha256")
        .update(JSON.stringify(ground.heights))
        .digest("hex")
        .slice(0, 16),
      massif: cooked.backdrop.name,
      pose: `${cooked.backdrop.at.join(",")} @${Math.round(cooked.backdrop.rotation)}${cooked.backdrop.mirror ? "m" : ""}`,
      height: Math.round(cooked.backdrop.height),
      relief: Math.round(stats.relief),
      kurtosis: Math.round(stats.curvatureKurtosis * 10) / 10,
      slopeP90: Math.round(stats.slopeP90),
      dir: join(root, out),
    };
    console.log(JSON.stringify(row));
    results.push(row);
  }
} finally {
  mcp.stop();
  const { STRATA_WORLD: _, ...pinned } = process.env;
  execFileSync(process.execPath, ["scripts/bake.mjs", "--force"], {
    cwd: example,
    env: pinned,
    stdio: "ignore",
  });
}

assert.equal(new Set(results.map((row) => row.ground)).size, 3, "three seeds, three grounds");
assert.equal(new Set(results.map((row) => row.pose)).size, 3, "three seeds, three massif poses");
for (const row of results) {
  // The backdrop gates the pinned forest holds, on each cooked ring.
  assert(row.relief >= 500, `seed ${row.seed}: ring relief ${row.relief} m, no mountain stands`);
  assert(row.kurtosis > 40, `seed ${row.seed}: ring curvature kurtosis ${row.kurtosis}, blobs`);
}
console.log(`verify-variations: 3 forests from "${REQUEST}", cooked under ${root}`);
