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
    // The massif at its own spacing: the largest square of its detail grid.
    const { detail } = JSON.parse(readFileSync(join(root, out, "ring.json"), "utf8")).massif;
    const side = Math.min(detail.columns, detail.rows);
    const square = [];
    for (let r = 0; r < side; r++)
      for (let c = 0; c < side; c++) square.push(detail.heights[r * detail.columns + c]);
    const stats = terrainStats(square, side, (side - 1) * detail.spacing);
    // The lower half of the mountain above its foot: 60% or more under 40 degrees (a wooded foot).
    const at = (r, c) => detail.heights[r * detail.columns + c];
    const floor = detail.heights.reduce((low, h) => Math.min(low, h), Number.POSITIVE_INFINITY);
    let lower = 0;
    let gentle = 0;
    for (let r = 1; r < detail.rows - 1; r++)
      for (let c = 1; c < detail.columns - 1; c++) {
        const h = at(r, c);
        if (h < floor + 50 || h > floor + cooked.backdrop.height / 2) continue;
        const dx = (at(r, c + 1) - at(r, c - 1)) / (2 * detail.spacing);
        const dz = (at(r + 1, c) - at(r - 1, c)) / (2 * detail.spacing);
        lower++;
        if (Math.atan(Math.hypot(dx, dz)) < (40 * Math.PI) / 180) gentle++;
      }
    // The heightmap makes sense: a forest floor at true scale, and the square meets its ring with no
    // step. The ring is sampled under the square's border, cell by cell.
    const floorStats = terrainStats(ground.heights, ground.resolution, ground.size);
    const cell = ring.size / (ring.resolution - 1);
    const ringAt = (x, z) => {
      const c = (x + ring.size / 2) / cell;
      const r = (z + ring.size / 2) / cell;
      const c0 = Math.floor(c);
      const r0 = Math.floor(r);
      const g = (rr, cc) => ring.heights[rr * ring.resolution + cc];
      const fc = c - c0;
      const fr = r - r0;
      return (
        (g(r0, c0) * (1 - fc) + g(r0, c0 + 1) * fc) * (1 - fr) +
        (g(r0 + 1, c0) * (1 - fc) + g(r0 + 1, c0 + 1) * fc) * fr
      );
    };
    const n = ground.resolution;
    const step = ground.size / (n - 1);
    const seam = [];
    for (let i = 0; i < n; i++)
      for (const [r, c] of [
        [0, i],
        [n - 1, i],
        [i, 0],
        [i, n - 1],
      ])
        seam.push(
          Math.abs(
            ground.heights[r * n + c] -
              ringAt(c * step - ground.size / 2, r * step - ground.size / 2),
          ),
        );
    seam.sort((a, b) => a - b);
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
      floorRelief: Math.round(floorStats.relief),
      floorSlopeP90: Math.round(floorStats.slopeP90),
      seamP90: Math.round(seam[Math.floor(seam.length * 0.9)] * 10) / 10,
      ring: Math.round(terrainStats(ring.heights, ring.resolution, ring.size).relief),
      relief: Math.round(stats.relief),
      kurtosis: Math.round(stats.curvatureKurtosis * 10) / 10,
      gentle: Math.round((gentle / lower) * 100) / 100,
      lower,
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
  assert(
    row.floorRelief <= 90,
    `seed ${row.seed}: the ground spans ${row.floorRelief} m, no forest floor`,
  );
  assert(
    row.floorSlopeP90 <= 30,
    `seed ${row.seed}: the ground's steepest tenth is ${row.floorSlopeP90} degrees`,
  );
  assert(
    row.seamP90 < 6,
    `seed ${row.seed}: the square and its ring part by ${row.seamP90} m at the seam`,
  );
  // The Phase 1 gates the pinned massif holds, on each cooked massif.
  assert(row.relief >= 500, `seed ${row.seed}: massif relief ${row.relief} m, no mountain stands`);
  // Curvature kurtosis is gated on a flat host (`terrain-survey.spec.ts`, "sharp enough"): inside a
  // real ring the smooth survey around the mountain dilutes it, so here it is reported only.
  assert(row.lower > 2000, `seed ${row.seed}: ${row.lower} lower-slope cells, no foot to measure`);
  assert(row.gentle >= 0.6, `seed ${row.seed}: ${row.gentle} of the lower slopes under 40 degrees`);
}
console.log(`verify-variations: 3 forests from "${REQUEST}", cooked under ${root}`);
