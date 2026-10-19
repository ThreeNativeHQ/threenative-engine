// Task-owned frozen-source and readiness proof; no browser or renderer mutations.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import { relative, resolve } from "node:path";
export function launchOrder(count = 40) {
  assert.ok(Number.isSafeInteger(count) && count > 0 && count % 2 === 0);
  return Array.from({ length: count / 2 }, () => ["before", "after", "after", "before"]).flat();
}
export function statistics(values) {
  assert.ok(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maximum: sorted.at(-1),
    method: "nearest rank ceil(0.95*n), one-based",
  };
}
export async function treeFingerprint(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (["node_modules", ".git", "dist", ".vite", "artifacts"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files.push({
          path: relative(root, path),
          sha256: createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        });
      else if (entry.isSymbolicLink())
        files.push({
          path: relative(root, path),
          symlinkTarget: await readlink(path),
          policy: "target text retained; never traversed",
        });
      else throw new Error(`Unqualified source-tree entry: ${path}`);
    }
  }
  await walk(root);
  return { root, files, sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}
export function validateSample(provenance, readiness, observed) {
  assert.equal(provenance.rendererKind, "webgpu");
  assert.equal(provenance.target, "web");
  assert.equal(provenance.adapter.vendor, "nvidia");
  assert.equal(provenance.adapter.architecture, "turing");
  assert.deepEqual(provenance.viewport, { width: 1280, height: 720 });
  assert.equal(readiness.rule, "sustained-frames");
  const startup = readiness.startup;
  assert.equal(startup.phase, "ready");
  const { readyMs, loadStartedMs } = startup.timeline;
  assert.ok(
    Number.isFinite(readyMs) &&
      Number.isFinite(loadStartedMs) &&
      readyMs >= loadStartedMs &&
      loadStartedMs >= 0,
  );
  assert.equal(observed.backendWebGL, false);
  assert.equal(observed.width, 1280);
  assert.equal(observed.height, 720);
  assert.equal(observed.samples, 4);
  assert.ok(!startup.holds?.some((hold) => hold.expired));
  assert.ok((startup.warmup?.observed?.failed ?? 0) === 0, "Reported startup compilation failed");
  return { navigationReadyMs: readyMs, sceneLoadToReadyMs: readyMs - loadStartedMs };
}
