// Packed-consumer proof for PRD-466 AC-7 and the headless half of AC-8.
//
// Everything the consumer runs resolves from tarballs in a directory outside the workspace graph:
// `pnpm pack` of `@threenative/terrain`, `threenative-engine-mcp` and `create-threenative`, plus the
// `three` the game uses. The consumer therefore sees exactly what a published install would, and any
// import that only works because of a workspace link fails here.
//
// create-threenative is extracted rather than installed: its own dependencies (the asset pipeline)
// are not offline-installable, and what AC-7 needs from it is the files it ships.
//
// It iterates over whatever worlds `scripts/bake.mjs` exports, so a sixth world is covered the day it
// is added.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openConsumerPage } from "./consumer-world.mjs";
import { verifyGameHandoff } from "./verify-game-handoff.mjs";

const root = resolve(".");
const repo = resolve(root, "../..");
const temporary = mkdtempSync(join(tmpdir(), "strata-consumer-"));
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options }).trim();

try {
  // --- the worlds this game authors ----------------------------------------------------------------
  // Importing the bake module hands back the seeded recipes; for an unchanged recipe it rewrites the
  // same bytes, and the check at the end proves the tree is as it was.
  const bake = await import("./bake.mjs");
  const recipes = Object.fromEntries(
    Object.entries(bake).filter(([, value]) => typeof value?.toJSON === "function"),
  );
  const worldNames = Object.keys(recipes);
  assert(worldNames.length >= 2, `bake.mjs exported only ${worldNames.join(", ")}`);

  // The arrays the game plays: baked.json holds the drawn worlds, and the rest sit beside it.
  const worldDir = resolve(root, "src/world");
  const baked = JSON.parse(readFileSync(join(worldDir, "baked.json"), "utf8"));
  const bakedHeights = (name) =>
    (baked[name] ?? JSON.parse(readFileSync(join(worldDir, `${name}.json`), "utf8"))).heights;

  // --- pack and install ------------------------------------------------------------------------
  const packed = {};
  const started = performance.now();
  for (const [key, directory] of [
    ["terrain", "packages/terrain"],
    ["mcp", "packages/engine-mcp"],
    ["create", "packages/create-threenative"],
  ]) {
    const before = new Set(readdirSync(temporary));
    run("pnpm", ["pack", "--pack-destination", temporary], { cwd: join(repo, directory) });
    packed[key] = [...readdirSync(temporary)].find((file) => !before.has(file));
    assert(packed[key], `pnpm pack of ${directory} produced no tarball`);
  }
  const require = createRequire(import.meta.url);
  const threeRoot = resolve(dirname(require.resolve("three")), "..");
  packed.three = run(
    "npm",
    ["pack", threeRoot, "--pack-destination", temporary, "--ignore-scripts", "--silent"],
    { cwd: temporary },
  );
  const consumer = join(temporary, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: {} }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      ...["three", "terrain", "mcp"].map((key) => join(temporary, packed[key])),
    ],
    { cwd: consumer },
  );
  const create = join(temporary, "create-threenative");
  mkdirSync(create);
  run("tar", ["-xzf", join(temporary, packed.create), "-C", create, "--strip-components=1"]);
  const installMs = performance.now() - started;

  // Zero engine dependencies: the consumer's whole node_modules is three, the terrain package, and
  // the capability reader. Nothing of `@threenative/core`, `@threenative/physics` or a renderer.
  const installed = readdirSync(join(consumer, "node_modules")).filter(
    (name) => !name.startsWith("."),
  );
  const scoped = readdirSync(join(consumer, "node_modules/@threenative"));
  assert.deepEqual(scoped, ["terrain"], `Unexpected scoped installs: ${scoped}`);
  assert.deepEqual(installed.sort(), ["@threenative", "three", "threenative-engine-mcp"]);
  const terrainPackage = JSON.parse(
    readFileSync(join(consumer, "node_modules/@threenative/terrain/package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(terrainPackage.dependencies ?? {}), []);

  // --- AC-7: capability lookup, from the packed install ---------------------------------------------
  const lookup = `
    import { capabilityDetail, searchCapabilities } from "threenative-engine-mcp";
    const manifest = ${JSON.stringify(join(create, "capabilities.json"))};
    const queries = [
      ["request", "a walkable island with seeded noise hills, rivers and scattered trees", "Terrain", "@threenative/terrain"],
      ["mechanic", "procedural heightmap landscape for the game", "Terrain", "@threenative/terrain"],
      ["mechanic", "export the terrain as a glb for another three.js project", "exportWorldGLB", "@threenative/terrain/export"],
      ["mechanic", "open the terrain brush and layer GUI around game-owned rendering", "mountTerrainEditor", "@threenative/terrain/editor"],
    ];
    const found = queries.map(([scope, situation, symbol, importPath]) => {
      const response = searchCapabilities(situation, manifest, scope);
      const hit = response.results.find((result) => result.symbol === symbol);
      if (response.verdict !== "matched" || hit?.importPath !== importPath)
        throw new Error("query did not resolve " + symbol + ": " + JSON.stringify(response.results.map((r) => r.symbol + "@" + r.importPath)));
      return { symbol, importPath, rank: response.results.indexOf(hit) };
    });
    console.log(JSON.stringify({ found, terrain: capabilityDetail("Terrain", manifest) }));
  `;
  writeFileSync(join(consumer, "lookup.mjs"), lookup);
  const lookedUp = JSON.parse(run("node", ["lookup.mjs"], { cwd: consumer }));
  const constraints = JSON.stringify(lookedUp.terrain.constraints ?? lookedUp.terrain);
  for (const truth of [
    "metres",
    "4294967295",
    "17, 33, 65, 129, 257, 513 or 1025",
    "synchronous",
    "materials, models and texture paths belong to the game",
  ])
    assert(constraints.includes(truth), `Terrain's packed constraints lack: ${truth}`);

  // The scaffold's shipped instructions, from the packed create-threenative.
  const templates = readdirSync(join(create, "templates"), { withFileTypes: true }).filter(
    (entry) => entry.isDirectory(),
  );
  assert(templates.length >= 11, `Expected the eleven templates, found ${templates.length}`);
  for (const { name } of templates) {
    for (const file of ["AGENTS.md", "CLAUDE.md"])
      assert(
        readFileSync(join(create, "templates", name, file), "utf8").includes(
          "agent-docs/references/terrain-authoring.md",
        ),
        `${name}/${file} does not point at the terrain workflow`,
      );
    const manifestJson = JSON.parse(readFileSync(join(create, "templates", name, "package.json")));
    assert(
      !(
        "@threenative/terrain" in { ...manifestJson.dependencies, ...manifestJson.devDependencies }
      ),
      `${name} makes the authoring addon an ordinary runtime dependency`,
    );
  }
  // A fresh project, not just the template tree: the scaffold that `create-threenative` writes
  // carries the same pointer, in both instruction files, and no authoring dependency.
  const { createProject } = await import(
    pathToFileURL(join(repo, "packages/create-threenative/dist/index.js")).href
  );
  // It is created INSIDE the install, so its imports resolve to the packed terrain package and
  // `three` the way a project's own node_modules would, and the workflow below runs in it.
  const fresh = await createProject(
    { install: false, target: "fresh-game", template: "minimal" },
    consumer,
  );
  for (const file of ["AGENTS.md", "CLAUDE.md"])
    assert(
      readFileSync(join(fresh.target, file), "utf8").includes(
        "agent-docs/references/terrain-authoring.md",
      ),
      `A fresh scaffold's ${file} does not point at the terrain workflow`,
    );
  const freshPackage = JSON.parse(readFileSync(join(fresh.target, "package.json"), "utf8"));
  assert(
    !("@threenative/terrain" in { ...freshPackage.dependencies, ...freshPackage.devDependencies }),
    "A fresh scaffold depends on the authoring addon",
  );
  const workflow = readFileSync(join(create, "agent-docs/references/terrain-authoring.md"), "utf8");
  for (const required of [
    "npm install --save-dev @threenative/terrain",
    "@threenative/terrain/editor/server",
    "exportWorldGLB",
    "node_modules/@threenative/terrain/AGENT_GUIDE.md",
  ])
    assert(workflow.includes(required), `The shipped terrain workflow lacks: ${required}`);
  readFileSync(join(consumer, "node_modules/@threenative/terrain/AGENT_GUIDE.md"), "utf8");

  // --- PRD-467 AC-7: the editor stays optional, and every command the workflow names runs ----------
  // (1) The headless entries carry no DOM, server or editor module: walk their import graph.
  const installedTerrain = join(consumer, "node_modules/@threenative/terrain/dist");
  const specifiers = (text) =>
    [
      ...text.matchAll(/^(?:import|export)\b[^'"\n]*?['"]([^'"\n]+)['"]\s*;?$/gmu),
      ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ].map((match) => match[1]);
  const graph = {};
  for (const entry of ["index.js", "three.js"]) {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(installedTerrain, file), "utf8");
      assert(
        !/\bdocument\.|\blocalStorage\b|\bnew (?:FileReader|Worker)\b|\bnode:|\bwindow\.(?:location|document|addEventListener)/u.test(
          text,
        ),
        `${entry} reaches ${file}, which touches a DOM or Node global`,
      );
      for (const specifier of specifiers(text)) {
        if (specifier.startsWith(".")) {
          assert(!/editor|server/u.test(specifier), `${entry} imports ${specifier}`);
          visit(join(dirname(file), specifier));
        } else assert.equal(specifier, "three", `${entry} imports ${specifier}`);
      }
    };
    visit(entry);
    graph[entry] = [...seen];
  }
  assert(
    typeof globalThis.document === "undefined" && typeof globalThis.window === "undefined",
    "The consumer process must have no DOM",
  );
  await import(pathToFileURL(join(installedTerrain, "index.js")).href);
  await import(pathToFileURL(join(installedTerrain, "three.js")).href);

  // (2) The workflow's own code runs in the scaffold. Its first block is executed verbatim; the
  // editor block runs against a real Vite server with the project-owned route; the controller
  // snippet is the one the workflow prints. `vite` is the optional peer, linked from the workspace
  // because it cannot be installed offline; the terrain package itself is the packed tarball.
  const firstBlock = /```js\n([\s\S]*?)```/u.exec(workflow)?.[1];
  assert(firstBlock?.includes("bakeTerrain"), "The workflow's authoring block is missing");
  mkdirSync(join(fresh.target, "terrain-editor"), { recursive: true });
  mkdirSync(join(fresh.target, "terrain"), { recursive: true });
  writeFileSync(
    join(fresh.target, "terrain-editor/index.html"),
    "<!doctype html><title>terrain-editor</title>",
  );
  writeFileSync(
    join(fresh.target, "terrain/authoring.mjs"),
    `${firstBlock}
import { writeFileSync } from "node:fs";
if (!state.height.length || !mesh.positions.length || !collision.heights?.length)
  throw new Error("The workflow's bake produced nothing");
writeFileSync("terrain/world.json", JSON.stringify({ version: 1, recipe: terrain.toJSON() }));
console.log(JSON.stringify({ heights: state.height.length }));
`,
  );
  const authoredByWorkflow = JSON.parse(
    run("node", ["terrain/authoring.mjs"], { cwd: fresh.target }),
  );
  assert.equal(authoredByWorkflow.heights, 257 * 257);
  symlinkSync(join(root, "node_modules/vite"), join(consumer, "node_modules/vite"), "dir");
  writeFileSync(
    join(fresh.target, "terrain/editor-session.mjs"),
    `import { resolve } from "node:path";
import { TerrainEditorController } from "@threenative/terrain/editor";
import { terrainEditor } from "@threenative/terrain/editor/server";
import { Terrain, validatePlacementOverrides } from "@threenative/terrain";
import { createServer } from "vite";
const editor = terrainEditor({ documentPath: resolve("terrain/world.json") });
const server = await createServer({
  root: process.cwd(), configFile: false, logLevel: "silent",
  server: { host: "127.0.0.1", port: 5184, strictPort: true },
  plugins: [editor], optimizeDeps: { exclude: ["@threenative/terrain/editor"] },
});
try {
  await server.listen();
  const activation = await editor.activate();
  const controller = new TerrainEditorController(activation.editorUrl);
  const first = await controller.snapshot();
  const edited = await controller.commit({
    baseRevision: first.revision,
    commands: [{ op: "update", id: "hills", patch: { params: { amplitude: 35 } } }],
  });
  const planted = await controller.commit({
    baseRevision: edited.revision,
    commands: [{ op: "upsert", layer: { id: "trees", type: "scatter", params: { asset: "pine", count: 6, avoidWater: false } } }],
  });
  const id = Terrain.fromJSON(planted.document.recipe).evaluate().instances[0]?.id;
  const pose = { position: [12, 60, -4], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 0.5, 1.5], grounding: false };
  validatePlacementOverrides({ [id]: pose });
  const posed = await controller.commit({
    baseRevision: planted.revision,
    document: { ...planted.document, placementOverrides: { [id]: pose } },
  });
  let stale = null;
  try { await controller.commit({ baseRevision: first.revision, commands: [] }); } catch (error) { stale = String(error.message ?? error); }
  console.log(JSON.stringify({ activation, first: first.revision, posed, id, pose, stale, amplitude: posed.document.recipe.layers.find((l) => l.id === "hills").params.amplitude }));
} finally { await server.close(); }
`,
  );
  const session = JSON.parse(
    run("node", ["terrain/editor-session.mjs"], { cwd: fresh.target }).split("\n").at(-1),
  );
  assert.match(session.activation.editorUrl, /^http:\/\/127\.0\.0\.1:5184\/terrain-editor\//u);
  assert.equal(session.amplitude, 35, "The workflow's controller patch did not reach the document");
  assert.notEqual(session.posed.revision, session.first);
  assert.match(session.stale ?? "", /409|[Ss]tale/u, "A stale base must conflict");
  assert(session.id, "The scatter layer placed nothing to pose");
  const onDisk = JSON.parse(readFileSync(join(fresh.target, "terrain/world.json"), "utf8"));
  assert.deepEqual(
    onDisk,
    session.posed.document,
    "The shared document on disk is the committed one",
  );

  // (3) The edited document reaches the full-world GLB inside the consumer: a plain browser page
  // with only the packed installs, the file read back by a vanilla GLTFLoader.
  copyFileSync(
    join(root, "scripts/fixtures/consumer-world.mjs"),
    join(consumer, "world-fixture.mjs"),
  );
  const page = await openConsumerPage({ consumer, repo });
  let handoff;
  try {
    const indices = [0, 1000, 33024, 66048];
    handoff = await page.exportAndLoad(session.posed.document, session.posed.revision, indices);
    assert.deepEqual(page.problems, [], "The consumer page raised errors or external requests");
  } finally {
    await page.close();
  }
  assert.equal(handoff.report.revision, session.posed.revision);
  assert.equal(handoff.resolution, 257);
  assert.deepEqual(
    handoff.loadedHeights,
    handoff.stateHeights,
    "GLB terrain differs from the state",
  );
  assert.equal(handoff.placements.length, 6);
  const posedNode = handoff.placements.find((entry) => entry.id === session.id);
  assert(posedNode, "The posed placement is not in the GLB");
  posedNode.matrix.forEach((value, index) =>
    assert(Math.abs(value - posedNode.expected[index]) < 1e-4, `matrix ${index}`),
  );
  assert.deepEqual(
    [12, 60, -4],
    posedNode.matrix.slice(12, 15).map((value) => Math.round(value * 1e4) / 1e4),
  );
  assert.equal(handoff.externalUris, 0);
  assert.equal(handoff.cameras, 0);
  assert.deepEqual(handoff.editorGlobals, []);
  assert.deepEqual(handoff.storedKeys, []);

  // --- PRD-467 AC-8: the GUI-polished world, reproduced from the packed install alone -------------
  // `scripts/fixtures/editor-authored.json` is what the live editor held after a sculpt stroke, a
  // scatter stroke and a numeric transform, reloaded and exported (see verify-polished-world.mjs).
  // The consumer re-evaluates the saved document with only the packed package and must land on the
  // same terrain samples, the same stable placement ids and the same hand-posed matrix.
  const polished = JSON.parse(
    readFileSync(join(root, "scripts/fixtures/editor-authored.json"), "utf8"),
  );
  assert.equal(
    JSON.parse(JSON.stringify(polished.document)).recipe.layers.length,
    polished.document.recipe.layers.length,
  );
  const reproduced = await openConsumerPage({ consumer, repo });
  let replayed;
  try {
    replayed = await reproduced.exportAndLoad(
      polished.document,
      polished.revision,
      polished.sampleIndices,
    );
    assert.deepEqual(reproduced.problems, []);
  } finally {
    await reproduced.close();
  }
  const near = (actual, expected, tolerance, what) =>
    actual.forEach((value, index) =>
      assert(
        Math.abs(value - expected[index]) <= tolerance,
        `${what}[${index}]: ${value} vs ${expected[index]}`,
      ),
    );
  assert.equal(replayed.report.revision, polished.revision);
  assert.equal(replayed.resolution, polished.resolution);
  assert.equal(replayed.size, polished.size);
  near(replayed.stateHeights, polished.heights, 1e-6, "terrain sample");
  near(replayed.loadedHeights, polished.glbHeights, 1e-6, "exported terrain vertex");
  assert.deepEqual(
    replayed.placements.map((p) => p.id).sort(),
    polished.placements.map((p) => p.id).sort(),
  );
  const posedAgain = replayed.placements.find((p) => p.id === polished.posedId);
  near(posedAgain.matrix, polished.posedMatrix, 1e-4, "hand-posed matrix");
  let widest = 0;
  for (const recorded of polished.placements) {
    const node = replayed.placements.find((p) => p.id === recorded.id);
    const [x, y, z] = node.matrix.slice(12, 15);
    near([x, z], [recorded.position[0], recorded.position[2]], 1e-3, `${recorded.id} x/z`);
    widest = Math.max(widest, Math.abs(y - recorded.position[1]));
  }
  // The game grounds an unedited prop on the triangle under it; the headless pose is the bilinear
  // height. They differ by centimetres (0.084 m measured), never by a prop's height.
  assert(widest < 0.25, `an unedited placement's height differs by ${widest} m`);
  assert.deepEqual(replayed.waterIds, polished.waterIds);
  assert.equal(replayed.externalUris, 0);
  assert.deepEqual(replayed.editorGlobals, []);
  assert.deepEqual(replayed.storedKeys, []);

  // --- PRD-466 AC-8: every world bake.mjs exports, as a FULL-world GLB -------------------------------
  // Terrain, placements and any water, exported and read back in the plain page. Every world must
  // place something: a terrain-only GLB is not a full world.
  const everyWorld = await openConsumerPage({ consumer, repo });
  const fullWorlds = [];
  try {
    for (const name of worldNames) {
      const recipe = recipes[name].toJSON();
      const revision = createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
      const started = performance.now();
      const full = await everyWorld.exportAndLoad(
        { version: 1, recipe },
        revision,
        [0, 1000, 33024, 66048],
      );
      assert.deepEqual(full.loadedHeights, full.stateHeights, `${name}: full-world GLB terrain`);
      assert(full.placements.length > 0, `${name}: the full-world GLB places nothing`);
      assert.equal(full.placements.length, full.report.placementIds.length, `${name}: placements`);
      assert.equal(full.externalUris, 0, `${name}: external URI`);
      assert.equal(full.cameras, 0);
      fullWorlds.push({
        world: name,
        placements: full.placements.length,
        water: full.waterIds,
        glbBytes: full.glbBytes,
        exportAndLoadMs: Math.round(performance.now() - started),
      });
    }
    assert.deepEqual(everyWorld.problems, []);
  } finally {
    await everyWorld.close();
  }

  // --- PRD-468 AC-8: an ordinary ThreeNative game adopts the exported world ------------------------
  // CONSUMER_GAME=skip leaves this stage out (it scaffolds, installs, builds and plays a game).
  const gameHandoff =
    process.env.CONSUMER_GAME === "skip"
      ? "skipped (CONSUMER_GAME=skip)"
      : await verifyGameHandoff({
          repo,
          temporary,
          polished,
          withPage: async (use) => {
            const open = await openConsumerPage({ consumer, repo });
            try {
              const result = await use(open);
              assert.deepEqual(open.problems, []);
              return result;
            } finally {
              await open.close();
            }
          },
        });

  const optional = {
    graph,
    workflowRan: [
      "Terrain/Mask/bakeMesh/bakeTerrain block",
      "terrainEditor + activate",
      "TerrainEditorController commit",
      "stale conflict",
      "validatePlacementOverrides/applyPlacementOverrides",
      "toGeometry",
      "exportWorldGLB",
    ],
    glbBytes: handoff.glbBytes,
    polished: {
      guiEdits: polished.guiEdits,
      placements: polished.placements.length,
      widestUneditedHeightGap: Math.round(widest * 1e3) / 1e3,
      samples: polished.heights.length,
    },
  };

  // --- AC-8, headless half: author, bake and load through public imports --------------------------
  writeFileSync(
    join(consumer, "recipes.json"),
    JSON.stringify(Object.fromEntries(worldNames.map((name) => [name, recipes[name].toJSON()]))),
  );
  const author = `
    import { createHash } from "node:crypto";
    import { readFileSync, writeFileSync } from "node:fs";
    import { Terrain, bakeMesh, encodeGLB } from "@threenative/terrain";
    import * as editor from "@threenative/terrain/editor";
    import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
    import { Box3 } from "three";
    if (typeof editor.mountTerrainEditor !== "function" || typeof editor.TerrainEditorController !== "function")
      throw new Error("The packed editor entry does not export the editor");
    const recipes = JSON.parse(readFileSync("recipes.json", "utf8"));
    const report = [];
    for (const [world, recipe] of Object.entries(recipes)) {
      const t0 = performance.now();
      const state = Terrain.fromJSON(recipe).evaluate();
      const evaluateMs = performance.now() - t0;
      const t1 = performance.now();
      const glb = encodeGLB(bakeMesh(state));
      const exportMs = performance.now() - t1;
      writeFileSync(world + ".glb", glb);
      const bytes = Buffer.from(glb);
      const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
      const gltf = await new Promise((resolve, reject) =>
        new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "", resolve, reject));
      let meshes = 0, triangles = 0;
      gltf.scene.traverse((object) => {
        if (!object.isMesh) return;
        meshes++;
        triangles += (object.geometry.index?.count ?? object.geometry.getAttribute("position").count) / 3;
      });
      const box = new Box3().setFromObject(gltf.scene);
      report.push({
        world,
        resolution: state.resolution,
        size: state.size,
        heightsSha: createHash("sha256").update(JSON.stringify(Array.from(state.height))).digest("hex"),
        heights: Array.from(state.height).length,
        minY: box.min.y, maxY: box.max.y, spanX: box.max.x - box.min.x, spanZ: box.max.z - box.min.z,
        stateMin: Math.min(...state.height), stateMax: Math.max(...state.height),
        meshes, triangles,
        externalUris: [...(json.buffers ?? []), ...(json.images ?? [])].filter((entry) => entry.uri).length,
        requiredExtensions: json.extensionsRequired ?? [],
        glbBytes: bytes.length, evaluateMs, exportMs,
      });
    }
    console.log(JSON.stringify(report));
  `;
  writeFileSync(join(consumer, "author.mjs"), author);
  const authored = JSON.parse(run("node", ["author.mjs"], { cwd: consumer }));
  assert.equal(authored.length, worldNames.length);
  for (const entry of authored) {
    const sha = (heights) => createHash("sha256").update(JSON.stringify(heights)).digest("hex");
    assert.equal(
      entry.heightsSha,
      sha(bakedHeights(entry.world)),
      `${entry.world}: the packed package's heights are not the arrays the game plays`,
    );
    assert.equal(entry.heights, entry.resolution ** 2);
    assert.equal(entry.triangles, 2 * (entry.resolution - 1) ** 2, `${entry.world} triangles`);
    assert(entry.meshes >= 1, `${entry.world}: the GLB loaded no mesh`);
    assert(Math.abs(entry.spanX - entry.size) < 1e-3 && Math.abs(entry.spanZ - entry.size) < 1e-3);
    assert(
      Math.abs(entry.minY - entry.stateMin) < 1e-3 && Math.abs(entry.maxY - entry.stateMax) < 1e-3,
    );
    assert.equal(entry.externalUris, 0, `${entry.world}: the GLB names an external file`);
    assert.deepEqual(entry.requiredExtensions, []);
    assert.equal(entry.world.length > 0, true);
  }

  console.log(
    JSON.stringify({
      consumer: {
        installMs: Math.round(installMs),
        installed: ["three", ...scoped, "threenative-engine-mcp"],
      },
      capabilities: lookedUp.found,
      templatesChecked: templates.length,
      freshScaffold: fresh.target.split("/").at(-1),
      optionalTooling: optional,
      gameHandoff,
      fullWorlds,
      worlds: authored.map((entry) => ({
        world: entry.world,
        heights: entry.heights,
        triangles: entry.triangles,
        glbBytes: entry.glbBytes,
        evaluateMs: Math.round(entry.evaluateMs),
        exportMs: Math.round(entry.exportMs),
      })),
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
