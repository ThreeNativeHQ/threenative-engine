// PRD-468 AC-8: an ordinary ThreeNative game adopts an exported world through an explicit handoff
// and runs with no authoring package anywhere in its install.
//
// The game is a real scaffold: `create-threenative` from this checkout's built dist, installed with
// the locally packed framework tarballs (core, physics, assets, playtest, the CLI). The handoff is
// a GLB exported by the packed `@threenative/terrain`, the baked heights and the environment
// settings, written to an explicit destination that is never overwritten. The game is built for
// the web and its own playtest scenario runs against the built bundle in a real WebGPU browser.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Write a handoff to an explicit destination; an existing file is a conflict, never overwritten. */
export function writeHandoff(destination, files) {
  const conflicts = Object.keys(files).filter((name) => existsSync(join(destination, name)));
  if (conflicts.length)
    throw new Error(`Handoff conflict, nothing written: ${conflicts.join(", ")}`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(destination, name)), { recursive: true });
    writeFileSync(join(destination, name), content);
  }
}

// The game's authored files (not node_modules or build output), as one hash.
const digest = (directory, parts = ["assets", "src", "playtests"]) => {
  const hash = createHash("sha256");
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) hash.update(full.slice(directory.length)).update(readFileSync(full));
    }
  };
  for (const part of parts) if (existsSync(join(directory, part))) walk(join(directory, part));
  return hash.digest("hex");
};

// `withPage(fn)` opens the packed-install browser page for one call and closes it again, because the
// game's own preview server needs the one allowed port while its playtest runs.
export async function verifyGameHandoff({ repo, temporary, polished, withPage }) {
  const run = (command, args, options = {}) =>
    execFileSync(command, args, {
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 1 << 28,
      ...options,
    });

  // --- the game: scaffold + local framework tarballs -------------------------------------------------
  const packs = join(temporary, "game-packs");
  mkdirSync(packs);
  const archives = {};
  const templateManifest = JSON.parse(
    readFileSync(join(repo, "packages/create-threenative/templates/minimal/package.json"), "utf8"),
  );
  const dependencies = new Set(
    Object.keys({
      ...templateManifest.dependencies,
      ...templateManifest.devDependencies,
      ...templateManifest.optionalDependencies,
    }),
  );
  const packages = JSON.parse(
    execFileSync("pnpm", ["exec", "tsx", "scripts/workspace-packages.ts", "--json"], {
      cwd: repo,
      encoding: "utf8",
    }),
  ).filter(({ name }) => dependencies.has(name));
  assert(packages.length > 0, "minimal template has no workspace packages to pack");
  for (const { name, directory } of packages) {
    const before = new Set(readdirSync(packs));
    run("pnpm", ["pack", "--pack-destination", packs], { cwd: join(repo, directory) });
    archives[name] = join(
      packs,
      [...readdirSync(packs)].find((file) => !before.has(file)),
    );
  }
  const { createProject } = await import(
    pathToFileURL(join(repo, "packages/create-threenative/dist/index.js")).href
  );
  const scaffolded = await createProject(
    { install: true, packageSources: archives, target: "handoff-game", template: "minimal" },
    temporary,
  );
  const game = scaffolded.target;

  // --- no authoring package in the game, by its manifest, its install and its source ------------------
  const manifest = JSON.parse(readFileSync(join(game, "package.json"), "utf8"));
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };
  assert(!("@threenative/terrain" in declared), "the game declares the authoring package");
  assert(
    !existsSync(join(game, "node_modules/@threenative/terrain")),
    "the authoring package is installed in the game",
  );

  // --- the handoff: exported by the packed terrain package, written to an explicit destination ---------
  const exported = await withPage((page) =>
    page.exportAndLoad(polished.document, polished.revision, polished.sampleIndices, true),
  );
  const glb = Buffer.from(exported.glbBase64, "base64");
  assert.equal(exported.report.revision, polished.revision);
  const environment = polished.document.environment;
  assert(
    environment?.sun && environment.exposure,
    "the saved document carries the look to hand off",
  );
  const gameSource = (name) =>
    readFileSync(join(import.meta.dirname, "fixtures/handoff-game", name), "utf8");
  const files = {
    "assets/world.glb": glb,
    "src/handoff/environment.ts": `export const environment = ${JSON.stringify(environment, null, 2)} as const;\n`,
    "src/handoff/world.ts": `// Baked from revision ${polished.revision}.\nexport const size = ${exported.size};\nexport const resolution = ${exported.resolution};\nexport const heights: readonly number[] = ${JSON.stringify(exported.heights)};\n`,
    "src/render/handoffEnvironment.ts": gameSource("handoffEnvironment.ts"),
    "src/scenes/Handoff.ts": gameSource("Handoff.ts"),
    "src/state.ts": gameSource("state.ts"),
    "src/game.ts": gameSource("game.ts"),
  };
  // The scaffold's own game.ts/state.ts are the game's source; the handoff replaces them
  // deliberately, which is this proof's one explicit overwrite, so it removes them first.
  for (const replaced of ["src/game.ts", "src/state.ts"]) rmSync(join(game, replaced));
  // The minimal template ships only Play.ts; Boot.ts was removed from it (f2d5ad732).
  rmSync(join(game, "src/scenes/Play.ts"));
  for (const old of readdirSync(join(game, "playtests"))) rmSync(join(game, "playtests", old));
  writeHandoff(game, files);
  // A second handoff to the same destination is a conflict and leaves every byte as it was.
  const before = digest(game);
  assert.throws(
    () => writeHandoff(game, { ...files, "assets/world.glb": Buffer.from("other") }),
    /conflict/u,
  );
  assert.equal(digest(game), before, "a conflicting handoff changed the game");
  writeFileSync(
    join(game, "playtests/handoff.playtest.json"),
    `${JSON.stringify(scenario(exported, environment), null, 2)}\n`,
  );

  // --- build the shipped web bundle and read what it holds ----------------------------------------------
  run("pnpm", ["typecheck"], { cwd: game });
  run("pnpm", ["build:web"], { cwd: game });
  const bundle = join(game, "dist/assets");
  const code = readdirSync(bundle)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(bundle, file), "utf8"))
    .join("\n");
  for (const forbidden of [
    "@threenative/terrain",
    "terrain-editor",
    "/api/document",
    "TerrainEditorController",
  ])
    assert(!code.includes(forbidden), `the shipped bundle contains '${forbidden}'`);
  for (const name of ["src/handoff", "src/render", "src/scenes"])
    for (const file of readdirSync(join(game, name))) {
      if (!file.endsWith(".ts")) continue;
      assert(
        !/@threenative\/terrain/u.test(readFileSync(join(game, name, file), "utf8")),
        `${name}/${file} imports the authoring package`,
      );
    }

  // --- the game's own playtest, against the built bundle, in a real WebGPU browser ---------------------
  const artifacts = join(import.meta.dirname, "../artifacts/playtest/game-handoff");
  const output = run(
    "pnpm",
    [
      "exec",
      "threenative-playtest",
      "--scenario",
      "playtests/handoff.playtest.json",
      "--url",
      "http://127.0.0.1:5184",
      "--server-command",
      "pnpm exec vite preview --host 127.0.0.1 --port 5184 --strictPort",
      "--browser-recipe",
      "webgpu",
      "--headed",
      "--artifacts",
      artifacts,
    ],
    { cwd: game },
  );
  const report = JSON.parse(output.slice(output.indexOf("{")));
  assert.equal(report.pass, true, "the game's playtest did not pass");
  const capture = JSON.parse(readFileSync(join(artifacts, "capture.json"), "utf8"));
  assert.equal(capture.rendererKind, "webgpu");

  // --- a later preview edit does not reach the shipped game --------------------------------------------
  const frozen = digest(game);
  const edited = structuredClone(polished.document);
  edited.recipe.layers.find((layer) => layer.id === "hills").params.amplitude += 25;
  const later = await withPage((page) =>
    page.exportAndLoad(edited, polished.revision, polished.sampleIndices, false),
  );
  assert.notDeepEqual(
    later.stateHeights,
    exported.stateHeights,
    "the preview edit changed nothing",
  );
  assert.equal(digest(game), frozen, "a preview edit changed the handed-off game");
  const handed = digest(game, ["src/handoff"]);
  return {
    packages: Object.keys(archives),
    installedAuthoringPackage: false,
    glbBytes: glb.length,
    placements: polished.placements.length,
    handoffDigest: handed.slice(0, 12),
    playtest: {
      pass: report.pass,
      renderer: capture.rendererKind,
      adapter: `${capture.adapter.vendor}/${capture.adapter.architecture}`,
      trivialityOptOutCount: report.trivialityOptOutCount,
    },
  };
}

function scenario(exported, environment) {
  const same = (path, value, note) => ({
    id: "GameState",
    path,
    equals: value,
    allowTrivial: note,
  });
  const set =
    "Set once from the explicit handoff while the scene enters; it must stay as handed off while the game renders.";
  return {
    name: "handoff",
    target: "web",
    schemaVersion: 1,
    viewport: { width: 1280, height: 720 },
    warmupFrames: 30,
    artifacts: { screenshots: true, console: true },
    steps: [{ kind: "wait", label: "settle", waitTicks: 90, release: true, screenshot: "handoff" }],
    assert: {
      diagnostics: { noConsoleErrors: true, noNetworkErrors: true, runtimeReady: true },
      resources: [
        same("placements", exported.report.placementIds.length, set),
        same(
          "glbLights",
          0,
          "The world file carries no light; the game's own binding supplies them.",
        ),
        same("glbCameras", 0, "The world file carries no camera; the game owns its camera."),
        same("colliderRows", exported.resolution, set),
        same("colliderColumns", exported.resolution, set),
        same("sunIntensity", environment.sun.intensity, set),
        same("sunElevation", environment.sun.elevation, set),
        same("fillIntensity", environment.fill.intensity, set),
        same("exposure", environment.exposure, set),
        same("fogDensity", environment.fog.density, set),
        same(
          "groundMeasured",
          1,
          "Set once, after the solver has run, when the contact is measured.",
        ),
        { id: "GameState", path: "groundError", gte: 0, lte: 0.05 },
        { id: "GameState", path: "frames", gte: 120 },
      ],
      visual: [{ region: { x: 0, y: 0, width: 1280, height: 720, minNonblankPixelRatio: 0.9 } }],
    },
  };
}
