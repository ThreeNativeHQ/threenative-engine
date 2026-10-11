import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TerrainEditorController } from "@threenative/terrain/editor";
import { terrainEditor } from "@threenative/terrain/editor/server";
import { Matrix4, Quaternion, Vector3 } from "three";
import { createServer } from "vite";
import {
  advanceFixedStep,
  parseStandalonePlaytestArgs,
  withBrowserCapture,
} from "../../../packages/playtest/dist/runner/index.js";
import { verifyImportedExport } from "./verify-import-export.mjs";

const root = resolve(".");
const temporary = mkdtempSync(join(tmpdir(), "strata-world-export-"));
try {
  const project = join(temporary, "producer.json");
  writeFileSync(project, readFileSync("terrain/world.json"));
  const plugin = terrainEditor({ documentPath: project });
  const producer = await createServer({
    root,
    configFile: false,
    // The project's own Vite config serves the CC0 starter sets from the terrain package; this
    // standalone server has to be told, or the export would be proven with no art loaded at all.
    publicDir: resolve("../../packages/terrain/starter-assets"),
    server: { host: "127.0.0.1", port: Number(process.env.EDITOR_PORT ?? 5185) },
    plugins: [plugin],
    optimizeDeps: { exclude: ["@threenative/terrain/editor"] },
    resolve: { dedupe: ["three"] },
  });
  const isolated = join(temporary, "consumer");
  mkdirSync(join(isolated, "public"), { recursive: true });
  writeFileSync(
    join(isolated, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: {} }),
  );
  writeFileSync(
    join(isolated, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><title>Portable terrain GLB · vanilla Three.js</title><style>body{margin:0;background:#a6c5d3}canvas{display:block}</style></head><body><script type="module" src="/world.mjs"></script></body></html>',
  );
  copyFileSync("scripts/fixtures/vanilla-world.mjs", join(isolated, "world.mjs"));
  const require = createRequire(import.meta.url);
  const threeRoot = resolve(dirname(require.resolve("three")), "..");
  const packedThree = execFileSync(
    "npm",
    ["pack", threeRoot, "--pack-destination", temporary, "--ignore-scripts", "--silent"],
    { stdio: "pipe", encoding: "utf8" },
  ).trim();
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      join(temporary, packedThree),
    ],
    { cwd: isolated, stdio: "pipe" },
  );
  const consumer = await createServer({
    root: isolated,
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    optimizeDeps: { include: ["three", "three/addons/loaders/GLTFLoader.js"] },
  });
  try {
    await producer.listen();
    await consumer.listen();
    const consumerUrl = consumer.resolvedUrls.local[0];
    const activation = await plugin.activate();
    const controller = new TerrainEditorController(activation.editorUrl);
    const config = parseStandalonePlaytestArgs([
      "--scenario",
      "playtests/editor.playtest.json",
      "--url",
      activation.editorUrl,
      "--browser-recipe",
      "webgpu",
      "--headed",
      "--timeout",
      "120000",
      "--artifacts",
      "artifacts/playtest/world-export",
    ]);
    await withBrowserCapture(config, async (session) => {
      const errors = [];
      session.page.on("pageerror", (error) => errors.push(error.message));
      session.page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await session.page.waitForFunction(() => window.strata?.state && !window.strata.busy);
      await advanceFixedStep(session.page, session.bridge, 2);
      const first = (await session.page.evaluate(() => window.strata.view.inspectProps()))[0];
      assert(first);
      const before = await controller.snapshot();
      const pose = {
        position: [12, 100, -4],
        quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        scale: [2, 0.5, 1.5],
        grounding: false,
      };
      const accepted = await controller.commit({
        baseRevision: before.revision,
        document: { ...before.document, placementOverrides: { [first.id]: pose } },
      });
      await session.page.waitForFunction(
        (revision) => window.strata.view.inspect().renderedRevision === revision,
        accepted.revision,
      );
      // The authored world keeps its river: a full-world export that quietly drops water is not a
      // full-world export, so the export must bake the river rather than the recipe losing it.
      const expected = await session.page.evaluate(() => window.strata.view.inspectProps());
      const dry = accepted;
      const liveWater = await session.page.evaluate(() => window.strata.view.inspectWater());
      assert.deepEqual(
        liveWater.map((entry) => entry.id),
        ["river"],
        "The live editor must draw the authored river",
      );
      assert(
        liveWater.every((entry) => entry.triangles > 0),
        "Every authored water body must be real geometry in the live scene",
      );
      const result = await session.page.evaluate(async () =>
        (await import("/scripts/fixtures/export-world.mjs")).exportFixtureWorld(),
      );
      assert.equal(result.report.revision, dry.revision);
      assert.equal(result.report.resolution, 129);
      assert.equal(result.report.placementIds.length, 100);
      const base64 = await session.page.evaluate(
        async () =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error);
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.readAsDataURL(new Blob([window.exportedWorld.bytes]));
          }),
      );
      const bytes = Buffer.from(base64, "base64");
      const length = bytes.readUInt32LE(12);
      const json = JSON.parse(bytes.subarray(20, 20 + length).toString("utf8"));
      // The exported world's PBR images must be this game's own starter maps, not a fixture's 16x16
      // checkers: the container is already proven, so the art is what this handoff carries. A 1K map
      // is tens of kilobytes of pixels; the fixture's checkers were a few hundred bytes each.
      const bufferView = (index) => json.bufferViews[index].byteLength;
      const imageBytes = (json.images ?? []).map((image) => bufferView(image.bufferView));
      assert(
        imageBytes.length >= 4,
        `Expected the ground's four PBR maps, got ${imageBytes.length}`,
      );
      assert(
        imageBytes.every((bytes) => bytes > 20_000),
        `Every exported image must be a real starter map, got ${JSON.stringify(imageBytes)}`,
      );
      assert.deepEqual(result.report.waterIds, ["river"], "The authored river must travel");
      assert(json.images.every((image) => image.bufferView !== undefined && !image.uri));
      assert(json.buffers.every((buffer) => !buffer.uri));
      assert(!json.extensionsRequired?.includes("EXT_mesh_gpu_instancing"));
      assert(!json.cameras && !json.animations);
      assert.equal(json.nodes.filter((node) => node.extras?.placementId).length, 100);
      const modelMeshes = new Set();
      for (const placement of json.nodes.filter((node) => node.extras?.placementId)) {
        const descendants = [...(placement.children ?? [])];
        for (const index of descendants) {
          const node = json.nodes[index];
          if (node.mesh !== undefined) modelMeshes.add(node.mesh);
          descendants.push(...(node.children ?? []));
        }
      }
      // Placements share their variants' mesh data: a hundred placement nodes reference a handful of
      // geometries (one per part of each variant in use), never one per placement.
      assert(
        modelMeshes.size > 0 && modelMeshes.size <= 16,
        `100 placement nodes must share their variants' mesh data, got ${modelMeshes.size} meshes`,
      );
      // What the export promises to carry, counted from the file itself: every mesh node, and every
      // PBR map its material references.
      const expectedMeshes = json.nodes.filter((node) => node.mesh !== undefined).length;
      const expectedMaps = json.nodes
        .filter((node) => node.mesh !== undefined)
        .flatMap((node) => json.meshes[node.mesh].primitives)
        .map((primitive) => {
          const material = json.materials?.[primitive.material] ?? {};
          const metallic = material.pbrMetallicRoughness ?? {};
          return [
            metallic.baseColorTexture,
            material.normalTexture,
            metallic.metallicRoughnessTexture,
            material.occlusionTexture,
          ].filter(Boolean).length;
        })
        .reduce((sum, count) => sum + count, 0);
      writeFileSync(join(isolated, "public/world.glb"), bytes);
      const artifact = resolve(config.artifactDirectory, "world.glb");
      writeFileSync(artifact, bytes);
      const requests = [];
      const rejectedRequests = [];
      await session.page.route("**/*", async (route) => {
        const url = route.request().url();
        if (url.startsWith("blob:") || url.startsWith("data:") || url.startsWith(consumerUrl)) {
          requests.push(url);
          await route.continue();
        } else {
          rejectedRequests.push(url);
          await route.abort();
        }
      });
      await session.page.goto(consumerUrl);
      await session.page.waitForFunction(
        () => window.exportConsumerReady && window.portableWorld.frames >= 5,
      );
      const loaded = await session.page.evaluate(() => window.portableWorld);
      assert.equal(loaded.placements.length, 100);
      // The baked river must survive into an ordinary game, with real triangles and no second
      // material authority: the receiving scene supplies its own light and draws what arrived.
      assert.deepEqual(
        loaded.water.map((entry) => entry.id),
        ["river"],
        "The authored river must reach an ordinary receiving game",
      );
      assert(loaded.water[0].triangles > 0, "The exported river must carry real triangles");
      // Every mesh node and every PBR map the file declares reaches an ordinary receiving game.
      assert.equal(loaded.meshes, expectedMeshes);
      assert.equal(loaded.pbrMaps, expectedMaps);
      assert.equal(loaded.cameras, 0);
      assert.equal(loaded.animations, 0);
      assert.equal(loaded.rootExtras.terrainRevision, dry.revision);
      for (const placement of expected) {
        const node = loaded.placements.find((entry) => entry.id === placement.id);
        assert(node);
        const pose = placement.transform;
        const matrix = new Matrix4().compose(
          new Vector3().fromArray(pose.position),
          new Quaternion().fromArray(pose.quaternion),
          new Vector3().fromArray(pose.scale),
        );
        matrix.elements.forEach((value, index) =>
          assert(Math.abs(node.matrix[index] - value) < 1e-4),
        );
      }
      const manual = loaded.placements.find((entry) => entry.id === first.id);
      pose.position.forEach((value, axis) => assert.equal(manual.matrix[12 + axis], value));
      assert.deepEqual(rejectedRequests, []);
      assert.deepEqual(errors, []);
      await session.screenshot("portable-world-vanilla");
      // The imported-and-edited world, from a fresh editor page and a fresh viewer, so the default
      // world proof above stays exactly as it was.
      console.log(
        JSON.stringify({
          imported: await verifyImportedExport({
            context: session.page.context(),
            editorUrl: activation.editorUrl,
            controller,
            consumerUrl,
            isolated,
            temporary,
          }),
        }),
      );
      console.log(
        JSON.stringify({
          export: {
            bytes: result.bytes,
            exportMs: result.exportMs,
            report: {
              ...result.report,
              placementIds: { count: result.report.placementIds.length },
            },
          },
          vanilla: { ...loaded, placements: { count: loaded.placements.length, manual } },
          requests,
          artifact,
        }),
      );
    });
  } finally {
    await producer.close();
    await consumer.close();
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
