// Task-owned matched generated-template proof. Invoke with local tsx; no network install.
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileAssets } from "../../../../assets/dist/index.js";
import {
  parseStandalonePlaytestArgs,
  withBrowserCapture,
} from "../../../../playtest/dist/runner/index.js";
import { createProject } from "../../../src/index.ts";
import { admitted, command, fingerprint } from "./template-matrix-files.mjs";
const cwd = process.cwd();
const base = resolve(
  process.env.TN_BACKLIGHT_MATRIX_OUTPUT ?? "artifacts/backlight-defaults/template-matrix1",
);
const templates = process.argv.slice(2);
assert.ok(templates.length > 0, "Name templates; start with minimal");
assert.ok(templates.every((t) => admitted.includes(t))); // Rain intentionally excluded.
await mkdir(base, { recursive: true });
const archiveRoot = resolve("artifacts/backlight-defaults/template-before-source");
try {
  await readFile(resolve(archiveRoot, "source.json"));
} catch {
  await mkdir(archiveRoot, { recursive: true });
  const archive = resolve(archiveRoot, "before.tar");
  await command(
    "git",
    ["archive", "--format=tar", `--output=${archive}`, "8cb5d3e8b", "packages/create-threenative"],
    cwd,
    resolve(base, "archive.log"),
  );
  await command("tar", ["-xf", archive, "-C", archiveRoot], cwd, resolve(base, "extract.log"));
  await writeFile(
    resolve(archiveRoot, "source.json"),
    JSON.stringify({ base: "8cb5d3e8b", method: "git archive own task checkpoint" }),
  );
}
const flags = [
  "--ozone-platform=x11",
  "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan",
  "--use-angle=vulkan",
  "--use-vulkan=native",
  "--disable-vulkan-fallback-to-gl-for-testing",
];
let results = [];
try {
  results = JSON.parse(await readFile(resolve(base, "matrix.json"), "utf8")).results;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
assert.ok(
  !templates.some((template) => results.some((row) => row.template === template)),
  "Already recorded template; use a separate matrix directory for retry",
);
for (const template of templates) {
  const pair = { template, pass: false, arms: {} };
  for (const arm of ["before", "after"]) {
    const project = resolve(base, `${template}-${arm}`);
    const output = resolve(base, `${template}-${arm}-capture`);
    const row = { project, output, pass: false };
    pair.arms[arm] = row;
    try {
      const root =
        arm === "before"
          ? resolve(archiveRoot, "packages/create-threenative/templates")
          : resolve("packages/create-threenative/templates");
      await createProject({ target: project, template, install: false }, cwd, root);
      await symlink(
        resolve("artifacts/backlight-defaults/clean-starter-before2/node_modules"),
        resolve(project, "node_modules"),
        "dir",
      );
      row.source = await fingerprint(project);
      const { default: config } = await import(
        pathToFileURL(resolve(project, "threenative.config.ts")).href
      );
      await compileAssets({ config: config.assets, cwd: project, platform: "web" });
      await command(
        "node",
        [resolve(project, "node_modules/vite/bin/vite.js"), "build"],
        project,
        resolve(base, `${template}-${arm}-build.log`),
      );
      row.cooked = await fingerprint(resolve(project, "public"));
      // Vite dev serves exact generated source; its existing asset watcher reuses cooked assets.
      const capture = parseStandalonePlaytestArgs([
        "--project",
        project,
        "--scenario",
        resolve(
          "packages/create-threenative/__tests__/fixtures/backlight-defaults/cost.playtest.json",
        ),
        "--url",
        "http://127.0.0.1:5196/",
        "--port",
        "5196",
        "--server-command",
        `node ${resolve(project, "node_modules/vite/bin/vite.js")} --host 127.0.0.1 --port 5196 --strictPort > ${resolve(base, `${template}-${arm}-server.log`)} 2>&1`,
        "--timeout",
        "60000",
        "--artifacts",
        output,
        ...flags.flatMap((f) => ["--browser-arg", f]),
      ]);
      await withBrowserCapture(capture, async (session) => {
        row.captureSession = JSON.parse(
          await readFile(resolve(output, "capture-session.json"), "utf8"),
        );
        row.provenance = session.provenance;
        assert.equal(row.provenance.adapter.vendor, "nvidia");
        assert.equal(row.provenance.adapter.architecture, "turing");
        assert.equal(row.provenance.rendererKind, "webgpu");
        assert.deepEqual(row.provenance.viewport, { width: 1280, height: 720 });
        row.snapshot = await session.bridge.sample({
          include: ["components", "state", "scene", "runtimeObservations", "renderChain"],
          label: "matched-template-ready",
        });
        row.observed = await session.page.evaluate(async () => {
          const { default: game } = await import("/src/game.ts");
          const raw = game.ctx.renderer.raw;
          return {
            width: raw.domElement.width,
            height: raw.domElement.height,
            backendWebGL: raw.backend.isWebGLBackend === true,
            samples: raw.samples,
            camera: {
              position: game.ctx.camera.position.toArray(),
              rotation: game.ctx.camera.quaternion.toArray(),
            },
          };
        });
        assert.equal(row.observed.backendWebGL, false);
        assert.equal(row.observed.width, 1280);
        assert.equal(row.observed.height, 720);
        assert.ok(!row.snapshot.diagnostics?.some((r) => r?.severity === "error"));
        await session.screenshot("default-template-ready");
        await writeFile(resolve(output, "snapshot.json"), JSON.stringify(row, null, 2));
      });
      row.pass = true;
    } catch (error) {
      row.error = { message: error.message, stack: error.stack };
    }
    await writeFile(resolve(base, `${template}-${arm}-result.json`), JSON.stringify(row, null, 2));
    console.log(`${template} ${arm}: ${row.pass ? "PASS" : row.error.message}`);
  }
  if (pair.arms.before.pass && pair.arms.after.pass) {
    try {
      assert.deepEqual(
        pair.arms.before.observed,
        pair.arms.after.observed,
        "Camera/buffer/backend mismatch",
      );
      assert.deepEqual(
        pair.arms.before.snapshot.clock,
        pair.arms.after.snapshot.clock,
        "Pose clock mismatch",
      );
      assert.deepEqual(
        pair.arms.before.snapshot.state,
        pair.arms.after.snapshot.state,
        "Content state mismatch",
      );
      assert.equal(
        pair.arms.before.cooked.sha256,
        pair.arms.after.cooked.sha256,
        "Cooked assets mismatch",
      );
      pair.pass = true;
    } catch (error) {
      pair.error = error.message;
    }
  }
  results.push(pair);
  await writeFile(
    resolve(base, "matrix.json"),
    JSON.stringify(
      {
        pass: results.every((r) => r.pass),
        scope:
          "matched default generated source, actual hardware WebGPU; visual admission requires pixel review",
        excluded: ["rain untouched"],
        results,
      },
      null,
      2,
    ),
  );
  if (template === "minimal" && !pair.pass) {
    process.exitCode = 1;
    break;
  }
}
if (results.some((r) => !r.pass)) process.exitCode = 1;
