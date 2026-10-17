// PRD-466 Phase 4 (box K1) and K4: a starter kit, adopted the way an agent would adopt it. `KIT` picks
// the kit: `forest` (the default) or `alpine`.
//
// A real `minimal` game is scaffolded from this checkout's built dist and installed with the locally
// packed framework tarballs. The kit is then added the way its README says an agent adds it —
// `pnpm add -D` the terrain tarball, copy `starter/<kit>` into `src/terrain/<kit>/`, run its bake
// into the game's own asset source — and the game is written around the copied kit. The game
// typechecks, builds for the web, ships a bundle with no authoring package in it, and its own
// playtest scenario walks a player into a prop in a real WebGPU browser.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Packed with the rest, installed by the agent step below rather than by the scaffolder. */
const TERRAIN = "@threenative/terrain";
const PORT = 5187;
const REPO = join(import.meta.dirname, "../../..");
const ARM = process.env.KIT_ARM ?? "default";
assert(
  ["default", "edited", "tint", "compare"].includes(ARM),
  "KIT_ARM must be default, edited, tint or compare",
);
const ARTIFACTS =
  process.env.KIT_ARTIFACTS ??
  join(
    import.meta.dirname,
    `../artifacts/playtest/starter-kit${ARM === "default" ? "" : `-${ARM}`}`,
  );
const FIXTURES = join(import.meta.dirname, "fixtures/kit-game");

/**
 * What differs between the starter kits the proof runs. `forest` is the kit K1 proves; `alpine` is the
 * boulder world K4 proves. A kit that lacks something (the forest's lake, the alpine's generated stand)
 * says so here rather than defaulting it.
 */
const KITS = {
  forest: {
    playtest: "kit.playtest.json",
    generatedStand: true,
    water: true,
    cooked: "cookedForestBytes",
    numbers: ["closestToTrunk", "firInstancesDrawn", "waterLakes", "waterRivers"],
    captures: ["edge", "ground", "lake", "overview"],
    views: ["edge", "ground", "lake", "overview"],
  },
  alpine: {
    playtest: "alpine.playtest.json",
    generatedStand: false,
    water: false,
    cooked: "cookedAlpineBytes",
    numbers: ["boulderInstances", "closestToBoulder"],
    captures: ["boulders", "edge", "ground", "overview"],
    views: ["boulders", "edge", "ground", "overview"],
  },
  desert: {
    playtest: "desert.playtest.json",
    generatedStand: false,
    water: false,
    cooked: "cookedDesertBytes",
    numbers: ["boulderInstances", "closestToBoulder"],
    captures: ["boulders", "edge", "ground", "overview"],
    views: ["boulders", "edge", "ground", "overview"],
  },
  tundra: {
    playtest: "tundra.playtest.json",
    generatedStand: false,
    water: true,
    cooked: "cookedTundraBytes",
    numbers: ["boulderInstances", "closestToBoulder", "waterLakes", "waterRivers"],
    captures: ["boulders", "edge", "ground", "overview"],
    views: ["boulders", "edge", "ground", "overview"],
  },
  coastal: {
    playtest: "coastal.playtest.json",
    generatedStand: false,
    water: true,
    cooked: "cookedCoastalBytes",
    numbers: ["treeInstances", "closestToTree", "waterLakes"],
    captures: ["boulders", "edge", "ground", "overview"],
    views: ["boulders", "edge", "ground", "overview"],
  },
};
/** The kit this run proves: `forest` by default, or `KIT=alpine`. Any other name fails closed. */
const KIT = process.env.KIT ?? "forest";
assert(
  Object.hasOwn(KITS, KIT),
  `KIT must be one of ${Object.keys(KITS).join(", ")}; got '${KIT}'`,
);
const CONFIG = KITS[KIT];
const COMPOSITION_FAR = process.env.KIT_COMPOSITION_FAR === "1";
if (COMPOSITION_FAR) {
  assert.equal(KIT, "alpine", "KIT_COMPOSITION_FAR requires the alpine kit");
  CONFIG.views.push("composition-far", "composition-clear");
  CONFIG.captures.push("composition-far", "composition-clear");
}

const say = (line) => process.stderr.write(`${line}\n`);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  return result.stdout ?? "";
};

/** Total bytes of every file under a directory, or 0 when it does not exist. */
function bytesUnder(directory) {
  if (!existsSync(directory)) return 0;
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    total += entry.isDirectory() ? bytesUnder(full) : statSync(full).size;
  }
  return total;
}

const round = (value) => Math.round(value * 1_000) / 1_000;

/**
 * Fails closed when something already answers on the playtest port. The runner would then test that
 * server rather than the bundle this run built, so a green result could describe another game.
 */
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = createConnection({ host: "127.0.0.1", port });
    probe.once("connect", () => {
      probe.destroy();
      reject(
        new Error(`port ${String(port)} already answers; stop that server before a kit proof`),
      );
    });
    probe.once("error", () => resolve());
  });
}

/**
 * The fir the game stands next to, and four metres of clear ground from its trunk.
 *
 * Read out of the bake rather than assumed, so the game never carries a coordinate that only held
 * for one recipe: the recipe's building pad is the ground the bake flattened, so the fir nearest it
 * is on the flattest stand in the world, and the clearest of twenty-four directions at four metres
 * is one that starts no walk inside another prop.
 */
/** Every placed prop in the baked world, read from its placement records. */
function readProps(world) {
  const manifest = JSON.parse(readFileSync(join(world, "world.json"), "utf8"));
  const bytes = readFileSync(join(world, manifest.placements));
  const records = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const props = [];
  for (const cell of manifest.cells)
    for (const run of cell.runs)
      for (let index = run.offset; index < run.offset + run.count; index += 1)
        props.push({
          asset: run.asset,
          x: records[index * 8],
          y: records[index * 8 + 1],
          z: records[index * 8 + 2],
        });
  return props;
}

function chooseStand(game, world) {
  const props = readProps(world);
  // A baseline run frames the cameras of the run it is compared with (KIT_STAND, JSON).
  if (process.env.KIT_STAND) return standFrom(JSON.parse(process.env.KIT_STAND), props);
  // The lake floods the low ground inside its radius, so the stand, its spawn and the edge camera stay
  // out of that radius plus a margin.
  const lakes = JSON.parse(readFileSync(join(world, "water.json"), "utf8")).lakes;
  const dry = (x, z, margin) =>
    lakes.every((lake) => Math.hypot(x - lake.at[0], z - lake.at[1]) >= lake.radius + margin);
  const firs = props.filter((prop) => prop.asset === "fir" && dry(prop.x, prop.z, 15));
  assert(firs.length > 0, "the bake placed no dry fir to stand next to");
  const layers = JSON.parse(readFileSync(join(game, "src/terrain/forest/recipe.json"), "utf8"))
    .recipe.layers;
  const pad = layers.find((layer) => layer.id === "building-pad")?.params.at ?? [0, 0];
  const fir = nearestTo(firs, pad);
  const others = props.filter((prop) => prop !== fir);
  const { spawn, clearance } = chooseSpawn(fir, others);
  const { edge, edgeClear } = chooseEdge(fir, props, dry);
  return { fir, spawn, clearance, edge, edgeClear };
}

/**
 * The before-state kit: the recipe as it stood before the lake and river were restored, so a baseline
 * renders the same ground without water. Only the game's own copy changes.
 */
function stripWaterLayers(recipePath) {
  const json = JSON.parse(readFileSync(recipePath, "utf8"));
  json.recipe.layers = json.recipe.layers.filter(
    (layer) => !["lake-bed", "river", "lake"].includes(layer.id),
  );
  writeFileSync(recipePath, `${JSON.stringify(json, null, 2)}\n`);
}

/** A baseline has no water to count, so its playtest drops the water rows. */
function stripWaterRows(playtestPath) {
  const json = JSON.parse(readFileSync(playtestPath, "utf8"));
  json.assert.resources = json.assert.resources.filter(
    (row) => !["waterLakes", "waterRivers"].includes(row.path),
  );
  writeFileSync(playtestPath, `${JSON.stringify(json, null, 2)}\n`);
}

/**
 * A stand given by hand. The fir keeps the given point and takes the height of the placement nearest
 * it, so the cameras keep their eye heights.
 */
function standFrom(given, props) {
  const nearest = nearestTo(props, [given.fir.x, given.fir.z]);
  return {
    fir: { x: given.fir.x, y: nearest.y, z: given.fir.z },
    spawn: given.spawn,
    clearance: 0,
    edge: given.edge,
    edgeClear: 0,
  };
}

/** The prop nearest `point` in the ground plane; the first one wins a tie. */
function nearestTo(props, point) {
  return props.reduce((nearest, prop) =>
    Math.hypot(prop.x - point[0], prop.z - point[1]) <
    Math.hypot(nearest.x - point[0], nearest.z - point[1])
      ? prop
      : nearest,
  );
}

/** The clearest of 24 points four metres from the fir's trunk, measured against `others`. */
function chooseSpawn(fir, others) {
  let spawn = { x: fir.x + 4, z: fir.z };
  let clearance = -1;
  for (let step = 0; step < 24; step += 1) {
    const angle = (2 * Math.PI * step) / 24;
    const candidate = { x: fir.x + 4 * Math.cos(angle), z: fir.z + 4 * Math.sin(angle) };
    const clear = Math.min(
      ...others.map((prop) => Math.hypot(prop.x - candidate.x, prop.z - candidate.z)),
    );
    if (clear > clearance) {
      clearance = clear;
      spawn = candidate;
    }
  }
  return { spawn, clearance };
}

/**
 * The edge camera stands back from the stand in the clearest spot 25-40 m out, so it frames the
 * trees instead of sitting inside a crown (crowns reach ~4 m; stands are 4 m apart).
 */
function chooseEdge(fir, props, dry) {
  let edge = { x: fir.x + 30, z: fir.z };
  let edgeClear = -1;
  for (const candidate of edgeCandidates(fir, dry)) {
    const clear = Math.min(
      ...props.map((prop) => Math.hypot(prop.x - candidate.x, prop.z - candidate.z)),
    );
    if (clear > edgeClear) {
      edgeClear = clear;
      edge = candidate;
    }
  }
  return { edge, edgeClear };
}

/**
 * The points the edge camera may use, in the order the search reads them: 24 bearings, 25-40 m out,
 * kept to the sun's side of the stand (the kit's sun azimuth is atan2(0.56, 0.55)) so the view is
 * front-lit like a beauty shot rather than always looking into the light, and inside 250 m.
 */
function edgeCandidates(fir, dry) {
  const sunAzimuth = Math.atan2(0.56, 0.55);
  const candidates = [];
  for (let step = 0; step < 24; step += 1)
    for (const reach of [25, 30, 35, 40]) {
      const angle = (2 * Math.PI * step) / 24;
      const off = Math.abs(Math.atan2(Math.sin(angle - sunAzimuth), Math.cos(angle - sunAzimuth)));
      if (off > Math.PI / 3) continue;
      const candidate = { x: fir.x + reach * Math.cos(angle), z: fir.z + reach * Math.sin(angle) };
      if (Math.abs(candidate.x) > 250 || Math.abs(candidate.z) > 250) continue;
      if (!dry(candidate.x, candidate.z, 5)) continue;
      candidates.push(candidate);
    }
  return candidates;
}

/** Hash every package file, including models, textures and sidecars. */
export function packageHashes(directory) {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? Object.entries(packageHashes(path)).map(([name, hash]) => [
              `${entry.name}/${name}`,
              hash,
            ])
          : [[entry.name, createHash("sha256").update(readFileSync(path)).digest("hex")]];
      }),
  );
}

/** Pick real sidecar IDs from the alpine fixture, never invented generator identities. */
export function alpineComposition(world) {
  const manifest = JSON.parse(readFileSync(join(world, "world.json"), "utf8"));
  assert(
    manifest.placementIds,
    "edited alpine needs a placement ID sidecar; use a fresh AFTER scaffold",
  );
  const ids = JSON.parse(readFileSync(join(world, manifest.placementIds), "utf8"));
  const bytes = readFileSync(join(world, manifest.placements));
  const records = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  assert.equal(ids.length, records.length / 8);
  // This is the unedited alpine's first walkable anchor, measured against its actual heightfield.
  const index = ids.findIndex(
    (_, i) => Math.hypot(records[i * 8] + 200.389511, records[i * 8 + 2] + 17.621393) < 0.01,
  );
  assert(
    index >= 0,
    "alpine anchor changed; reselect a walkable stand before recording comparisons",
  );
  const [x, , z] = records.subarray(index * 8, index * 8 + 3);
  const promotedIndex = ids.findIndex(
    (_, i) => i !== index && Math.hypot(records[i * 8] - x, records[i * 8 + 2] - z) < 60,
  );
  assert(promotedIndex >= 0, "alpine has no second boulder to promote near its stand");
  const move = {
    position: [x + 2, 0, z + 2],
    quaternion: [0, Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)],
    scale: [0.9, 0.9, 0.9],
  };
  const promotedId = ids[promotedIndex];
  const clearIndex = ids.findIndex(
    (id, i) =>
      id !== ids[index] &&
      id !== promotedId &&
      Math.hypot(records[i * 8] - x, records[i * 8 + 2] - z) >= 20 &&
      Math.hypot(records[i * 8] - x, records[i * 8 + 2] - z) < 60,
  );
  assert(clearIndex >= 0, "alpine needs an occupied clearing separate from the composed boulders");
  const clear = { center: [records[clearIndex * 8], records[clearIndex * 8 + 2]], radius: 12 };
  const clearedIds = ids.filter(
    (id, i) =>
      id !== ids[index] &&
      id !== promotedId &&
      Math.hypot(records[i * 8] - clear.center[0], records[i * 8 + 2] - clear.center[1]) <=
        clear.radius,
  );
  assert(clearedIds.length > 0, "alpine clear circle must remove an original boulder");
  return {
    referencePlacements: Array.from(records),
    anchorId: ids[index],
    promotedId,
    proofFarTarget: Array.from(records.subarray(promotedIndex * 8, promotedIndex * 8 + 3)),
    clearedIds,
    clear,
    promotedAt: [x + 5, z - 1],
    edits: {
      overrides: { [ids[index]]: move },
      remove: [promotedId],
      clear: [clear],
      add: [
        {
          id: "game:alpine-added-boulder",
          asset: "boulder",
          position: [x - 5, 0, z - 1],
          quaternion: [0, 0, 0, 1],
          scale: [1.4, 1.4, 1.4],
        },
      ],
    },
  };
}

export function compositionSource(composition, proofFarTarget = null, proofClearTarget = null) {
  return `import type { IWorldPlacementEdits } from "@threenative/terrain/starter";\nexport const composition: { referencePlacements: readonly number[]; anchorId: string; promotedId: string; proofFarTarget: readonly [number, number, number]; clearedIds: readonly string[]; clear: { center: readonly [number, number]; radius: number }; promotedAt: readonly [number, number]; edits: IWorldPlacementEdits } | null = ${JSON.stringify(composition ?? null)};\nexport const proofFarTarget: readonly [number, number, number] | null = ${JSON.stringify(proofFarTarget)};\nexport const proofClearTarget: readonly [number, number] | null = ${JSON.stringify(proofClearTarget)};\nexport const edits: IWorldPlacementEdits | undefined = ${composition ? "composition.edits" : "undefined"};\n`;
}

/** Append proof framing without replacing any original view, gate or frame budget. */
export function appendCompositionFarScenario(scenario) {
  for (const [index, view] of ["composition-far", "composition-clear"].entries()) {
    scenario.steps.push(
      {
        kind: "input",
        label: `${view}-view`,
        press: `Digit${index + 5}`,
        holdTicks: 2,
        release: true,
      },
      {
        kind: "wait",
        label: view,
        waitTicks: 150,
        release: true,
        screenshot: view,
      },
    );
    for (const metric of ["viewGpuP50", "viewGpuP95", "viewFrameP95"])
      scenario.assert.resources.push({
        id: "GameState",
        path: `${metric}.${view}`,
        gte: 0,
        allowTrivial: "Presence row: an unmeasured view reads -1 and fails.",
      });
  }
}

async function main() {
  const keptGame = process.env.KIT_GAME ? realpathSync(process.env.KIT_GAME) : undefined;
  if (keptGame) {
    try {
      const marker = JSON.parse(
        readFileSync(join(keptGame, ".threenative-kit-verifier.json"), "utf8"),
      );
      assert(marker?.game === keptGame && marker?.kit === KIT);
    } catch {
      throw new Error(
        `KIT_GAME ownership refused: ${keptGame} needs a valid .threenative-kit-verifier.json matching its canonical path and kit '${KIT}'; only fresh verifier scaffolds are marked automatically`,
      );
    }
  }
  assert(
    ARM === "default" || keptGame,
    "edited/tint arms require KIT_GAME pointing to a kept AFTER scaffold",
  );
  assert(KIT === "alpine" || ARM === "default", "edited and tint arms require KIT=alpine");
  const temporary = keptGame
    ? join(keptGame, "..")
    : mkdtempSync(join(tmpdir(), "threenative-kit-"));
  let game = keptGame;
  if (!game) {
    const minimal = JSON.parse(
      readFileSync(
        join(REPO, "packages/create-threenative/templates/minimal/package.json"),
        "utf8",
      ),
    );
    const dependencies = new Set(
      Object.keys({
        ...minimal.dependencies,
        ...minimal.devDependencies,
        ...minimal.optionalDependencies,
      }),
    );
    const workspacePackages = JSON.parse(
      run("pnpm", ["exec", "tsx", "scripts/workspace-packages.ts", "--json"]),
    );
    const gamePackages = workspacePackages.filter(({ name }) => dependencies.has(name));
    const terrainPackage = workspacePackages.find(({ name }) => name === TERRAIN);
    assert(gamePackages.length > 0, "minimal template has no workspace packages to pack");
    assert(terrainPackage, `workspace package is missing: ${TERRAIN}`);

    say(`kit proof (${KIT}) in ${temporary}`);

    // --- pack every package the game needs from this checkout's built output ------------------------
    const packs = join(temporary, "packs");
    mkdirSync(packs);
    const archives = {};
    for (const { name, directory } of [...gamePackages, terrainPackage]) {
      const before = new Set(readdirSync(packs));
      run("pnpm", ["pack", "--pack-destination", packs], { cwd: join(REPO, directory) });
      archives[name] = join(
        packs,
        [...readdirSync(packs)].find((file) => !before.has(file)),
      );
    }
    const { createProject } = await import(
      pathToFileURL(join(REPO, "packages/create-threenative/dist/index.js")).href
    );
    game = (
      await createProject(
        {
          install: true,
          // The terrain tarball is a source here too, not only the later `pnpm add -D`: the minimal
          // template's `@threenative/assets` dev dependency now depends on `@threenative/terrain`,
          // and the override this writes is what resolves that transitive edge to the local tarball
          // instead of the registry (which 404s). The kit's own `pnpm add -D` then moves it to the
          // devDependency the README names.
          packageSources: Object.fromEntries(
            [...gamePackages, terrainPackage].map(({ name }) => [name, archives[name]]),
          ),
          target: "kit-game",
          template: "minimal",
        },
        temporary,
      )
    ).target;
    writeFileSync(
      join(game, ".threenative-kit-verifier.json"),
      `${JSON.stringify({ game: realpathSync(game), kit: KIT })}\n`,
      { flag: "wx" },
    );
    say(`scaffolded ${game}`);

    // --- the agent's own three steps, from the kit's README --------------------------------------------
    run("pnpm", ["add", "-D", archives[TERRAIN]], { cwd: game });
    cpSync(
      join(game, "node_modules", ...TERRAIN.split("/"), "starter", KIT),
      join(game, "src/terrain", KIT),
      {
        recursive: true,
      },
    );
    // A baseline run (KIT_BEFORE=1) bakes the kit as it stood before the lake and river were restored.
    if (process.env.KIT_BEFORE === "1") {
      assert(CONFIG.water, "KIT_BEFORE strips the water layers, and only the forest kit has water");
      stripWaterLayers(join(game, "src/terrain", KIT, "recipe.json"));
    }
    const world = join(game, "assets/terrain", KIT);
    say(
      `bake: ${run("node", [`src/terrain/${KIT}/bake.mjs`, "--out", `assets/terrain/${KIT}`], { cwd: game }).trim()}`,
    );
  }
  const world = join(game, "assets/terrain", KIT);
  const sourceHashes = packageHashes(world);
  const publicWorld = join(game, "public/terrain", KIT);
  const publicHashes = existsSync(publicWorld) ? packageHashes(publicWorld) : undefined;
  // The forest scene is written around a stand the proof reads from its bake. The alpine scene picks
  // its own spawn and views from the loaded heightfield, so the alpine kit has no generated stand.
  if (CONFIG.generatedStand) {
    const { fir, spawn, clearance, edge, edgeClear } = chooseStand(game, world);
    writeFileSync(
      join(game, "src/terrain/forest/stand.ts"),
      `// Written by the kit's proof from the placements this bake wrote: the fir the scene stands
// next to, four metres of clear ground from its trunk, and the ground it sits on. The scene imports
// this, so no coordinate in the game is one the recipe no longer produces.
export const stand = {
  fir: { x: ${round(fir.x)}, z: ${round(fir.z)} },
  groundY: ${round(fir.y)},
  spawn: { x: ${round(spawn.x)}, z: ${round(spawn.z)} },
  edge: { x: ${round(edge.x)}, z: ${round(edge.z)} },
} as const;
`,
    );
    say(
      `stand: fir ${round(fir.x)},${round(fir.z)} spawn ${round(spawn.x)},${round(spawn.z)} (${round(clearance)} m clear) edge ${round(edge.x)},${round(edge.z)} (${round(edgeClear)} m clear)`,
    );
  }

  // --- the game, written around the copied kit -------------------------------------------------------
  // The scaffold's own arena and its player are the template's files, not this game's; they are the
  // one overwrite, so they are removed rather than left to disagree with the scene's state shape.
  rmSync(join(game, "src/scenes/Play.ts"), { force: true });
  rmSync(join(game, "src/entities"), { force: true, recursive: true });
  for (const name of readdirSync(join(game, "playtests"))) rmSync(join(game, "playtests", name));
  for (const name of ["game.ts", "state.ts"]) cpSync(join(FIXTURES, name), join(game, "src", name));
  cpSync(join(FIXTURES, "playtests", CONFIG.playtest), join(game, "playtests/kit.playtest.json"));
  if (process.env.KIT_BEFORE === "1") stripWaterRows(join(game, "playtests/kit.playtest.json"));
  mkdirSync(join(game, "src/scenes"), { recursive: true });
  cpSync(join(FIXTURES, "KitScene.ts"), join(game, "src/scenes/KitScene.ts"));
  const alpine =
    KIT === "alpine" && (ARM === "edited" || COMPOSITION_FAR)
      ? alpineComposition(world)
      : undefined;
  const composition = ARM === "edited" ? alpine : undefined;
  writeFileSync(
    join(game, "src/terrain/composition.ts"),
    compositionSource(
      composition,
      COMPOSITION_FAR ? alpine.proofFarTarget : null,
      COMPOSITION_FAR ? alpine.clear.center : null,
    ),
  );
  if (COMPOSITION_FAR) {
    const gameSource = join(game, "src/game.ts");
    writeFileSync(
      gameSource,
      readFileSync(gameSource, "utf8").replace(
        "input: {",
        'input: {\n    "composition-far": { keys: ["Digit5"] },\n    "composition-clear": { keys: ["Digit6"] },',
      ),
    );
    const scenarioPath = join(game, "playtests/kit.playtest.json");
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
    appendCompositionFarScenario(scenario);
    writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  }
  if (KIT === "alpine") {
    const worldSource = join(game, "src/terrain/alpine/world.ts");
    let source = readFileSync(worldSource, "utf8");
    if (!source.includes("import { edits }"))
      source = `import { edits } from "../composition.js";\n${source.replace('  name: "Alpine",', '  name: "Alpine",\n  edits,')}`;
    writeFileSync(worldSource, source);
    const surfacePath = join(game, "src/terrain/alpine/surface.json");
    const originalPath = join(game, "src/terrain/alpine/surface.original.json");
    if (!existsSync(originalPath)) cpSync(surfacePath, originalPath);
    const surface = JSON.parse(readFileSync(originalPath, "utf8"));
    if (ARM === "tint") surface.layers.find((layer) => layer.id === "snow").tint = [0.55, 0.75, 1];
    writeFileSync(surfacePath, `${JSON.stringify(surface, null, 2)}\n`);
  }
  if (composition) {
    const scenarioPath = join(game, "playtests/kit.playtest.json");
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
    for (const path of [
      "movedBoulder",
      "clearedCircle",
      "addedBoulder",
      "promotedObject",
      "promotedLight",
      "promotedCollider",
      "removedFar",
    ])
      scenario.assert.resources.push({
        id: "GameState",
        path,
        equals: 1,
        allowTrivial:
          "Startup edited data and live ordinary-object/physics observations; the unchanged drive and view assertions also run.",
      });
    writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  }
  const title = KIT[0].toUpperCase() + KIT.slice(1);
  writeFileSync(
    join(game, "src/terrain/kit.ts"),
    `
import { add${title}, COLLIDERS } from "./${KIT}/world.js";
import { ${KIT}Daylight as kitDaylight } from "./${KIT}/sky.js";
import type { IStarterWorld } from "@threenative/terrain/starter";
${CONFIG.generatedStand ? 'import { stand } from "./forest/stand.js";' : ""}
export { COLLIDERS, kitDaylight };
export const KIT: string = "${title}";
export const forestStand: { fir: { x: number; z: number }; spawn: { x: number; z: number }; edge: { x: number; z: number }; groundY: number } | undefined = ${CONFIG.generatedStand ? "stand" : "undefined"};
export interface IKitWorld extends IStarterWorld {
  readonly lakes?: readonly { at: readonly [number, number]; radius: number }[];
  readonly seaLevel?: number;
  readonly water?: { lakes: number; rivers: number; dispose(): void };
  readonly sea?: { dispose(): void };
}
export const addKit: (...args: Parameters<typeof add${title}>) => Promise<IKitWorld> = add${title};
`,
  );
  cpSync(
    join(import.meta.dirname, "../src/render/loading.ts"),
    join(game, "src/render/loading.ts"),
  );
  // loading.ts takes its progress type from this leaf module. Copying propStreaming.ts instead would
  // drag in props.ts and the rest of the preview's render closure, which the game does not ship.
  cpSync(
    join(import.meta.dirname, "../src/render/propProgress.ts"),
    join(game, "src/render/propProgress.ts"),
  );

  // --- it has to typecheck and build, and ship no authoring package ----------------------------------
  run("pnpm", ["typecheck"], { cwd: game });
  say("typecheck ok");
  run("pnpm", process.env.KIT_GAME ? ["exec", "vite", "build"] : ["build:web"], { cwd: game });
  assert.deepEqual(packageHashes(world), sourceHashes, "source package changed during arm");
  if (publicHashes)
    assert.deepEqual(
      packageHashes(publicWorld),
      publicHashes,
      "published package changed during arm",
    );
  const bundle = join(game, "dist/assets");
  const shipped = readdirSync(bundle)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(bundle, file), "utf8"))
    .join("\n");
  for (const forbidden of ["@threenative/terrain", "bakeWorldPackage", "terrain-editor"])
    assert(!shipped.includes(forbidden), `the shipped bundle contains '${forbidden}'`);
  const cooked = bytesUnder(join(game, "public/terrain", KIT));
  assert(cooked > 0, `the asset pipeline published nothing under public/terrain/${KIT}`);
  say(`built; cooked ${String(cooked)} B under public/terrain/${KIT}`);

  // --- the game's own playtest, against the built bundle, in a real WebGPU browser -------------------
  await assertPortFree(PORT);
  const output = existsSync(ARTIFACTS) ? realpathSync(ARTIFACTS) : resolve(ARTIFACTS);
  for (const protectedPath of [REPO, game])
    assert(
      output !== protectedPath && !protectedPath.startsWith(`${output}/`),
      "artifact output would remove a source checkout",
    );
  assert(!output.startsWith(`${game}/`), "artifact output must stay outside the kept game");
  assert(
    !output.startsWith(`${REPO}/`) ||
      output.startsWith(`${join(REPO, "examples/strata-terrain-preview/artifacts")}/`),
    "repository artifacts must stay in the preview's artifacts directory",
  );
  mkdirSync(ARTIFACTS, { recursive: true });
  const playtest = run(
    "pnpm",
    [
      "exec",
      "threenative-playtest",
      "--scenario",
      "playtests/kit.playtest.json",
      "--url",
      `http://127.0.0.1:${String(PORT)}`,
      "--server-command",
      `pnpm exec vite preview --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
      "--browser-recipe",
      "webgpu",
      "--headed",
      "--artifacts",
      ARTIFACTS,
    ],
    { cwd: game },
  );
  const report = JSON.parse(playtest.slice(playtest.indexOf("{")));
  const failures = (report.assertionResults ?? []).filter((row) => row.pass !== true);
  if (report.pass !== true)
    throw new Error(
      `the kit playtest did not pass:\n${JSON.stringify(failures.slice(0, 12), null, 2)}\n${JSON.stringify(report.diagnostics ?? [], null, 2)}`,
    );
  const capture = JSON.parse(readFileSync(join(ARTIFACTS, "capture.json"), "utf8"));
  assert.equal(capture.rendererKind, "webgpu");
  assert.match(
    capture.adapter.vendor ?? "",
    /nvidia/iu,
    `the run did not reach an NVIDIA adapter: ${JSON.stringify(capture.adapter)}`,
  );

  // --- no failed request (the runner records failures only; locality is the kit spec's static check) ---
  assert(
    Array.isArray(report.observations?.network),
    "the playtest report carries no network record",
  );
  assert.deepEqual(report.observations.network, [], "the game had failed requests");

  const rows = new Map(report.assertionResults.map((row) => [row.id, row.details?.after]));
  const value = (path) => {
    const after = rows.get(`resource.GameState.${path}`);
    assert(after !== undefined, `the playtest asserted nothing at GameState.${path}`);
    return after;
  };
  // Each kit reports the numbers its own scene defines (`numbers` in KITS). A name with no playtest row
  // fails in value().
  const kitNumbers = Object.fromEntries(CONFIG.numbers.map((name) => [name, value(name)]));
  const views = Object.fromEntries(
    CONFIG.views.map((view) => [
      view,
      {
        frameP95: value(`viewFrameP95.${view}`),
        gpuP50: value(`viewGpuP50.${view}`),
        gpuP95: value(`viewGpuP95.${view}`),
      },
    ]),
  );
  const summary = {
    arm: ARM,
    game,
    packageSha256: sourceHashes,
    ...(composition
      ? {
          composition: Object.fromEntries(
            [
              "movedBoulder",
              "clearedCircle",
              "addedBoulder",
              "promotedObject",
              "promotedLight",
              "promotedCollider",
              "removedFar",
            ].map((path) => [path, value(path)]),
          ),
        }
      : {}),
    captures: CONFIG.captures.map((file) => join(ARTIFACTS, `${file}.png`)),
    [CONFIG.cooked]: cooked,
    driveMetres: value("driveMetres"),
    frames: value("frames"),
    groundError: value("groundError"),
    ...kitNumbers,
    adapter: `${capture.adapter.vendor}/${capture.adapter.architecture}`,
    pass: true,
    propColliders: value("propColliders"),
    views,
  };
  assert.deepEqual(packageHashes(world), sourceHashes, "source package changed during playtest");
  if (publicHashes)
    assert.deepEqual(
      packageHashes(publicWorld),
      publicHashes,
      "published package changed during playtest",
    );
  console.log(JSON.stringify(summary));
  // /tmp is RAM here and the scaffold is ~700 MB; a failed run keeps it for inspection.
  if (!process.env.KIT_GAME && process.env.KEEP_KIT_GAME === undefined)
    rmSync(temporary, { force: true, recursive: true });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (ARM === "compare") {
    assert.equal(KIT, "alpine", "compare requires KIT=alpine");
    const captureArm = (arm, game) => {
      const env = { ...process.env };
      env.KIT_ARM = arm;
      env.KEEP_KIT_GAME = "1";
      if (game) env.KIT_GAME = game;
      if (process.env.KIT_ARTIFACTS) env.KIT_ARTIFACTS = join(process.env.KIT_ARTIFACTS, arm);
      return JSON.parse(run(process.execPath, [fileURLToPath(import.meta.url)], { env }));
    };
    const baseline = captureArm("default", process.env.KIT_GAME);
    const edited = captureArm("edited", baseline.game);
    assert.deepEqual(
      edited.packageSha256,
      baseline.packageSha256,
      "comparison changed the package",
    );
    console.log(JSON.stringify({ default: baseline, edited }));
  } else await main();
}
