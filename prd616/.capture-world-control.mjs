import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { captureVisualSurface, withBrowserCapture } from "../../packages/playtest/dist/runner/index.js";

const root = process.cwd();
const projectPath = resolve(root, "../prd616-before");
const settled = (stats) => stats?.residentTiles === 9 && stats.residentCells === 3 &&
  stats.loadsInFlight === 0 && stats.loadsQueued === 0 && stats.pendingPrewarm === 0 &&
  stats.admission?.backlog === 0;
assert.equal(settled(undefined), false);
assert.equal(settled({ residentTiles: 9 }), false);
assert.equal(settled({ residentTiles: 9, residentCells: 3, loadsInFlight: 0, loadsQueued: 0,
  pendingPrewarm: 0, admission: { backlog: 0 } }), true);
if (process.argv.includes("--selfcheck")) process.exit(0);

for (const run of [1, 2]) {
  const artifactDirectory = resolve(root, `artifacts/prd616/world-scope-before-${run}`);
  await withBrowserCapture({
    artifactDirectory, headless: false, projectPath, port: 0, target: "browser", trace: false,
    scenarioPath: resolve(root, "examples/abyss-framework/playtests/world-warm-up-reuse.playtest.json"),
    server: { command: "pnpm --filter abyss-framework dev --host 127.0.0.1 --port $PORT --strictPort",
      cwd: projectPath, timeoutMs: 120_000 },
    timeoutMs: 60_000, url: "http://127.0.0.1:0/?world",
  }, async (session) => {
    assert.equal(session.provenance.adapter.vendor, "nvidia");
    const deadline = Date.now() + 20_000;
    let snapshot;
    do {
      snapshot = await session.bridge.sample({ entities: ["world"], include: ["resources"], resources: ["state"] });
      if (settled(snapshot.resources?.state?.stats)) break;
      assert.ok(Date.now() < deadline, "World visual control did not reach complete residency");
      await new Promise((done) => setTimeout(done, 16));
    } while (true);
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(resolve(artifactDirectory, "after.png"), await captureVisualSurface(session.page));
    await writeFile(resolve(artifactDirectory, "capture.json"), JSON.stringify({ ...session.provenance,
      sourceCommit: "1d056cec3d84ad0a6aebd89a97d3bd66b8d04de9", purpose: "visual control only",
      stats: snapshot.resources.state.stats }, null, 2));
  });
  console.log(`WORLD_VISUAL_CONTROL_PASS run=${run}`);
}
