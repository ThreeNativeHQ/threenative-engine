import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { OrthographicCamera, Scene, Texture, Vector2 } from "three";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { createArmy as createArmyRef } from "../templates/rts/src/render/army.js";
import type { createUnitModels as createUnitModelsRef } from "../templates/rts/src/render/models.js";
import type { createResources as createResourcesRef } from "../templates/rts/src/render/resources.js";
import type { createTerrain as createTerrainRef } from "../templates/rts/src/render/terrain.js";
import { Game } from "../templates/rts/src/sim/game.js";

/**
 * The rts kit's ordinary-frame cost, measured the way `template-runtime-cost.spec.ts` measures
 * every other template: a warm-up, then a counted window in which a fresh three.js vector is a
 * failure. The count is the claim, so it is a sentinel on the constructors and on `clone()` — a
 * path that copies its result instead of writing into a scratch vector is the exact defect this
 * catches, and the render modules already hold one `_dummy` and one `_ndc` for that reason.
 *
 * Vectors are not the whole story. `filter`, `map`, `slice` and friends each hand back a new
 * array, so a steady frame that calls one of them is allocating at sixty units — which is what a
 * `V2` sentinel alone would report as clean. Every array-producing call in the measured window is
 * counted too, across the simulation step, the render sync and the scene frame.
 */
const probeState = vi.hoisted(() => ({
  arrayAllocations: 0,
  vector2Allocations: 0,
  vector3Allocations: 0,
  vector3Clones: 0,
}));

/** The array-returning builtins: each call is one fresh array plus its callback closure. */
const ARRAY_ALLOCATORS = [
  "concat",
  "entries",
  "filter",
  "flat",
  "flatMap",
  "keys",
  "map",
  "slice",
  "splice",
  "toReversed",
  "toSorted",
  "values",
] as const;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class CountingVector2 extends actual.Vector2 {
    constructor(x?: number, y?: number) {
      super(x, y);
      probeState.vector2Allocations += 1;
    }
  }
  class CountingVector3 extends actual.Vector3 {
    constructor(x?: number, y?: number, z?: number) {
      super(x, y, z);
      probeState.vector3Allocations += 1;
    }
  }
  const clone = actual.Vector3.prototype.clone;
  actual.Vector3.prototype.clone = function () {
    probeState.vector3Clones += 1;
    return clone.call(this);
  };
  return { ...actual, Vector2: CountingVector2, Vector3: CountingVector3 };
});

vi.mock("@threenative/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/src/index.js")>();
  // The kit asks the platform once, at `enter()`, and picks its quality tier from the answer.
  return { ...actual, isMobile: () => false };
});

const WARMUP_FRAMES = 30;
const MEASURED_FRAMES = 600;
const DT = 1 / 60;
/** The size the box names: sixty of the player's own units on the field at once. */
const OWN_UNITS = 60;

function measureVectorAllocations(step: () => void): { clones: number; constructors: number } {
  for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) step();
  probeState.vector2Allocations = 0;
  probeState.vector3Allocations = 0;
  probeState.vector3Clones = 0;
  for (let frame = 0; frame < MEASURED_FRAMES; frame += 1) step();
  return { clones: probeState.vector3Clones, constructors: probeState.vector3Allocations };
}

/**
 * Counts every array the measured window allocates, and names the ones it saw. Wrapping the
 * builtins rather than sampling the heap keeps the gate deterministic: no profiler, no threshold,
 * and a regression names the call that came back.
 */
function countArrayAllocations<T>(
  step: () => T,
  ordinary: () => boolean = () => true,
): { calls: number; harness: number; where: string[] } {
  const proto = Array.prototype as unknown as Record<string, unknown>;
  const original = new Map<string, (...args: never[]) => unknown>();
  for (const name of ARRAY_ALLOCATORS) original.set(name as string, proto[name as string] as never);
  const where: string[] = [];
  // Formatting a stack walks `split` and `slice`, which are themselves wrapped, so the capture
  // happens before anything is wrapped and the wrappers stay one frame deep.
  let capturing = false;
  let harness = 0;
  const count = (): void => {
    if (where.length >= 8 || capturing || !ordinary()) return;
    capturing = true;
    try {
      Error.stackTraceLimit = 24;
      // The harness is loaded through vite's module runner, which allocates array-returning
      // builtins of its own (source-map resolution does) while this window runs. A capture that
      // never reaches the kit's own source is the harness talking to itself, and counting it would
      // make the sentinel fail for a reason no game could fix.
      const stack = (new Error().stack ?? "").split("\n").slice(3);
      Error.stackTraceLimit = 10;
      if (!stack.some((line) => line.includes(`${path.sep}templates${path.sep}`))) {
        harness += 1;
        return;
      }
      where.push(stack.slice(0, 4).join(" | "));
    } finally {
      capturing = false;
    }
  };
  try {
    for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) step();
    where.length = 0;
    for (const name of ARRAY_ALLOCATORS) {
      const built = original.get(name as string) as (...args: never[]) => unknown;
      proto[name as string] = function guarded(this: unknown[], ...args: never[]): unknown {
        count();
        return built.apply(this, args);
      };
    }
    for (let frame = 0; frame < MEASURED_FRAMES; frame += 1) step();
  } finally {
    for (const [key, built] of original) proto[key] = built;
  }
  return { calls: where.length, harness, where };
}

function simFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return simFiles(file);
    return /\.ts$/u.test(entry.name) ? [file] : [];
  });
}

/** Where every source under these sentinels lives; a counted line is keyed from here, so
 * `sim/movement.ts:54` and `render/army.ts:316` name a file, not just a line. */
const SRC = path.resolve(import.meta.dirname, "../templates/rts/src");

/**
 * The source text of the line a counted literal sits on, cached. Classifying an allocation by what
 * the line says rather than by its number means an edit that moves the line cannot silently
 * reclassify it into the wrong bucket.
 */
function literalText(key: string): string {
  const at = key.lastIndexOf(":");
  const file = path.resolve(SRC, key.slice(0, at));
  const line = Number(key.slice(at + 1));
  const cached = literalText.cache.get(key);
  if (cached !== undefined) return cached;
  const text = readFileSync(file, "utf8").split("\n")[line - 1]?.trim() ?? "";
  literalText.cache.set(key, text);
  return text;
}
literalText.cache = new Map<string, string>();

/**
 * The seeded start plus enough of an army to put the claimed sixty own units on the field.
 *
 * `ai: false`, because the two claims measured against this fixture are about the *steady* state:
 * a commander training a Surveyor mints an entity record and builds the instanced batch for a type
 * that was not on the field, which is setup work, not per-frame work. The scene frame below runs
 * with the AI on, so the commander's own per-frame cost is measured there.
 */
function sixtyUnitMatch(seed = 471): Game {
  const game = new Game({ ai: false, seed });
  const wanted = OWN_UNITS - game.army().length;
  let added = 0;
  for (let row = 0; added < wanted; row += 1) {
    for (let column = 0; column < 6 && added < wanted; column += 1) {
      game.spawn(added % 3 === 0 ? "tank" : "ranger", 0, -62 + column * 3, 38 - row * 3);
      added += 1;
    }
  }
  return game;
}

/**
 * Counts every object and array *literal* the kit evaluates, by source line, in whichever
 * directories it is asked for — the simulation for the step, `render/` for the sync.
 *
 * The spies above cannot see these: an object literal allocates without calling anything they
 * wrap, which is how `travelEntity`'s `{x, z}` survived a spy that reported zero arrays. So the
 * sources are compiled here through a TypeScript transformer that rewrites each literal into a call
 * to a counter — the same approach an independent reviewer used to reproduce the 74 literals a
 * step at `movement.ts:54` that this file used to call clean.
 *
 * A render module imports three, which is ESM-only for two of its entry points, so those arrive as
 * `externals`: the spec imports them the way vitest resolves everything else and hands the
 * namespaces over. Everything relative is resolved here.
 *
 * Each transformed body carries its own `sourceURL`, so a stack captured inside kit code names the
 * template file it came from. Without it every kit frame reads as anonymous `new Function` and the
 * array sentinel below, which exempts the harness's own frames, would exempt the kit too.
 */
function watchLiterals(
  directories: readonly string[],
  externals: Record<string, unknown> = {},
): {
  Game: typeof Game;
  begin: () => void;
  module: (name: string) => Record<string, unknown>;
  take: () => { calls: number; lines: Map<string, number> };
} {
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const counts = new Map<string, number>();
  const bare = createRequire(import.meta.url);
  let watching = false;
  const record = (file: string, line: number): void => {
    if (!watching) return;
    const key = `${path.relative(SRC, file).split(path.sep).join("/")}:${line}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const load = (file: string): Record<string, unknown> => {
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const module_ = { exports: {} as Record<string, unknown> };
    cache.set(file, module_);
    const source = readFileSync(file, "utf8");
    const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => (root) => {
      const visit = (node: ts.Node): ts.Node => {
        const next = ts.visitEachChild(node, visit, context);
        if (!ts.isObjectLiteralExpression(next) && !ts.isArrayLiteralExpression(next)) return next;
        const line = root.getLineAndCharacterOfPosition(next.getStart(root)).line + 1;
        return ts.factory.createParenthesizedExpression(
          ts.factory.createBinaryExpression(
            ts.factory.createCallExpression(ts.factory.createIdentifier("__literal"), undefined, [
              ts.factory.createStringLiteral(file),
              ts.factory.createNumericLiteral(line),
            ]),
            ts.SyntaxKind.CommaToken,
            next,
          ),
        );
      };
      return ts.visitNode(root, visit) as ts.SourceFile;
    };
    const { outputText } = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      transformers: { before: [transformer] },
    });
    const require_ = (specifier: string): unknown => {
      if (!specifier.startsWith(".")) return externals[specifier] ?? bare(specifier);
      return load(path.join(path.dirname(file), specifier.replace(/\.js$/u, ".ts")));
    };
    new Function(
      "require",
      "exports",
      "module",
      "__literal",
      `${outputText}\n//# sourceURL=${file}`,
    )(require_, module_.exports, module_, record);
    return module_.exports;
  };
  for (const directory of directories)
    for (const file of simFiles(path.join(SRC, directory))) load(file);
  const exported = load(path.join(SRC, "sim/game.ts")) as { Game: typeof Game };
  return {
    Game: exported.Game,
    module: (name) => load(path.join(SRC, name)),
    begin: () => {
      counts.clear();
      watching = true;
    },
    take: () => {
      watching = false;
      // Every line, uncapped: the classification below reads all of them, and a truncated list
      // would let a steady literal hide behind the eight loudest.
      return { calls: [...counts.values()].reduce((a, b) => a + b, 0), lines: new Map(counts) };
    },
  };
}

/** `file:line xcount`, loudest first, for a failure message. */
function counted(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([line, count]) => `${line} x${count}`)
    .join("\n");
}

/**
 * The general case the box names: default settings, sixty own units in motion, no entity born in
 * the window, and the window long enough for the 1.2 s commander clock to tick several times.
 *
 * `ai: false` and idle units are exactly the two shortcuts that made the earlier version of this
 * file report zero on a path the kit never plays, so this fixture uses neither.
 */
function playingMatch(GameClass: typeof Game = Game): Game {
  const game = new GameClass({ seed: 471 });
  for (let n = game.army().length; n < OWN_UNITS; n += 1) {
    game.spawn("tank", 0, -62 + (n % 6) * 3, 38 - Math.floor(n / 6) * 3);
  }
  const ids: number[] = [];
  for (const entity of game.own(0)) ids.push(entity.id);
  game.command(ids, "attackMove", { x: -70, z: -60 }, 0);
  return game;
}

describe("rts kit ordinary-frame runtime cost", () => {
  it("keeps the simulation free of the renderer, so a step cannot build a vector", () => {
    const sources = simFiles(path.resolve(import.meta.dirname, "../templates/rts/src/sim")).map(
      (file) => readFileSync(file, "utf8"),
    );

    expect(sources.length).toBeGreaterThan(8);
    expect(sources.join("\n")).not.toMatch(/from ["']three["']/u);
  });

  it("steps 600 frames of a sixty-unit match without a fresh vector", () => {
    const game = sixtyUnitMatch();
    const mintedBefore = game.nextId;

    const allocations = measureVectorAllocations(() => game.step());

    expect(game.army().length).toBe(OWN_UNITS);
    expect(game.own(0).length).toBeGreaterThan(OWN_UNITS);
    // The step updates the records it owns; a steady state mints no new one.
    expect(game.nextId, "rts sim entity-record sentinel").toBe(mintedBefore);
    expect(allocations, "rts sim vector allocation sentinel").toEqual({
      clones: 0,
      constructors: 0,
    });
  });

  it("steps 600 frames of a sixty-unit match without allocating an array", () => {
    const game = sixtyUnitMatch();

    const arrays = countArrayAllocations(() => game.step());

    expect(arrays.calls, `rts sim array allocation sentinel: ${arrays.where.join("\n")}`).toBe(0);
  });

  /**
   * The general case, measured where a builtin spy is blind: default settings, sixty own units
   * walking, and a window long enough for the 1.2 s commander clock to tick eight times.
   *
   * Three numbers, all asserted, none of them a rounding of "excluded":
   *
   * * **steady literals** — everything except entity birth and a unit's waypoint store growing.
   *   Must be zero on every step. This is the claim the box names.
   * * **birth literals** — one entity record per entity that appears. Counted and asserted to be a
   *   real, small number, because a fixture that spawns nothing proves nothing about spawning.
   * * **growth literals** — a unit's `pathPool` doubling past its longest route so far. This is
   *   amortised per-entity state growth, not per-frame work, but it lands on ordinary frames, so it
   *   is reported with its own bound and a convergence check rather than excused.
   *
   * The obvious way to pass this is to call everything an event. The event steps are therefore
   * counted and bounded too: the window must contain real events (it is a match, not a still life),
   * most steps must still be ordinary, and a step is ordinary *only* if it minted nothing.
   */
  it("steps a playing sixty-unit match with the default AI on without evaluating a literal", () => {
    const watcher = watchLiterals(["sim"]);
    const game = playingMatch(watcher.Game);
    // The three seams an event step is detected through, wrapped rather than counted by hand: an
    // event is exactly a birth, an order, a training or an emitted record.
    let events = 0;
    const command = game.command.bind(game);
    const train = game.train.bind(game);
    const emit = game.emit.bind(game);
    game.command = (...args: Parameters<typeof command>) => {
      events += 1;
      return command(...args);
    };
    game.train = (...args: Parameters<typeof train>) => {
      events += 1;
      return train(...args);
    };
    game.emit = (...args: Parameters<typeof emit>) => {
      events += 1;
      return emit(...args);
    };
    // The frame is step AND drain, because that is what the scene does: `Play.#drain` runs on the
    // same frame as the step, and a step measured without its drain misses whatever the drain
    // allocates, which is how a per-drain array hides behind a green gate.
    for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) {
      game.step();
      game.drainEvents();
    }
    const movingAtWarmup = game.army().filter((entity) => entity.moving).length;
    const enemyStart = game
      .army(1)
      .map((entity) => `${entity.x},${entity.z}`)
      .join("|");
    const position = (entity: { x: number; z: number }): string => `${entity.x},${entity.z}`;
    const before = new Map(game.own(0).map((entity) => [entity.id, position(entity)]));
    let ordinary = 0;
    let eventSteps = 0;
    let steady = 0;
    let growth = 0;
    const growthSteps: number[] = [];
    const steadyWhere = new Map<string, number>();

    for (let frame = 0; frame < MEASURED_FRAMES; frame += 1) {
      const minted = game.nextId;
      events = 0;
      watcher.begin();
      game.step();
      game.drainEvents();
      const step = watcher.take();
      if (game.nextId !== minted) {
        // A birth is cold initialisation: it mints the entity record and its state once. Counted,
        // never counted as steady work.
        continue;
      }
      // A waypoint store doubling is amortised per-entity growth, so it is counted on its own. It
      // is recognised by the source line, not by a filename or a line number that an edit moves.
      let growthHere = 0;
      let otherHere = 0;
      const whereHere = new Map<string, number>();
      for (const [line, count] of step.lines) {
        if (literalText(line).includes("pool.push")) growthHere += count;
        else {
          otherHere += count;
          whereHere.set(line, (whereHere.get(line) ?? 0) + count);
        }
      }
      growth += growthHere;
      if (growthHere > 0) growthSteps.push(frame);
      // A step that ordered, trained or emitted is ordinary play: a shot, an order, a weld and a
      // training command are the match, not an interruption of it. Counting them separately let
      // 213 of 600 active frames out of the measurement, which is most of the fight, so they are
      // counted here like every other frame and reported as their own total beside it.
      if (events > 0) eventSteps += 1;
      ordinary += 1;
      steady += otherHere;
      for (const [line, count] of whereHere)
        steadyWhere.set(line, (steadyWhere.get(line) ?? 0) + count);
    }
    const where = [...steadyWhere.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([line, count]) => `${line} x${count}`);
    const moved = game.own(0).filter((entity) => before.get(entity.id) !== position(entity)).length;

    // Reported, not just asserted: a reader has to be able to see how much of the window was
    // combat and orders rather than take the zero on faith.
    console.log(
      `rts ordinary-frame window: ${ordinary} frames measured, ${eventSteps} of them ordered, trained or emitted, ${MEASURED_FRAMES - ordinary} skipped as entity birth, steady literals ${steady}, growth ${growth}`,
    );
    expect(game.ai, "the default AI must stay on for this case to mean anything").toBe(true);
    expect(movingAtWarmup, "the fixture must be moving units, not idle ones").toBeGreaterThan(40);
    expect(game.result, "a finished match would stop stepping and pass by doing nothing").toBe(
      null,
    );
    // Most of the window must be ordinary, or "zero on ordinary steps" would be a narrow claim. The
    // rest must still be real events, or the fixture would be a board that stopped playing.
    expect(ordinary, "most steps must be ordinary, not excused as events").toBeGreaterThan(
      MEASURED_FRAMES * 0.5,
    );
    expect(
      eventSteps,
      "the window must still contain events: it is a match, not a still life",
    ).toBeGreaterThan(0);
    expect(
      game
        .army(1)
        .map((entity) => `${entity.x},${entity.z}`)
        .join("|"),
      "an enemy commander must have run: its army is on the move",
    ).not.toBe(enemyStart);
    expect(moved, "the units must have actually travelled").toBeGreaterThan(40);
    expect(steady, `rts sim steady-state literal sentinel: ${where.join("\n")}`).toBe(0);
    // Growth is bounded and converges. A unit pays it once per doubling of its longest route, so a
    // 600-frame window must see it only a handful of times — and the second half of the window must
    // see strictly fewer than the first, which is what "amortised, not per-frame" actually means.
    // (An absolute zero here would be a claim about one seed's longest route, not about the code.)
    expect(growthSteps.length, "waypoint-store growth must be rare").toBeLessThan(
      MEASURED_FRAMES * 0.1,
    );
    expect(
      growthSteps.filter((frame) => frame >= MEASURED_FRAMES / 2).length,
      "waypoint-store growth must decay: the second half of a window sees fewer than the first",
    ).toBeLessThanOrEqual(growthSteps.filter((frame) => frame < MEASURED_FRAMES / 2).length);
    expect(
      growth,
      "waypoint-store growth must be a few allocations per unit, not per frame",
    ).toBeLessThan(game.entities.length * 16);
  });

  it("counts a literal when one is evaluated, so the zeros above are measurements", () => {
    const watcher = watchLiterals(["sim"]);
    watcher.begin();
    // Setting up the fixture allocates: the spawn records, the command's formation and the order
    // objects. Without this control a broken observer would make the cases above pass for free.
    playingMatch(watcher.Game);

    expect(watcher.take().calls).toBeGreaterThan(0);
  });

  it("counts an array-returning builtin called by the kit itself, so the array zeros are measurements", () => {
    const watcher = watchLiterals(["sim"]);
    const game = playingMatch(watcher.Game);
    // `Game.own` filters the entity list and hands the array back on every call, and it runs from
    // the instrumented module — so its stack names a template file, not the harness. The array
    // sentinel exempts the harness's own frames, and this is what says it does not also exempt the
    // kit: an `ev`-compiled kit frame used to read as an anonymous `new Function` and vanish.
    const arrays = countArrayAllocations(() => game.own(0));

    expect(arrays.harness, "a kit call must not be classified as the harness").toBe(0);
    expect(
      arrays.calls,
      `rts kit array allocation control: ${arrays.where.join("\n")}`,
    ).toBeGreaterThan(0);
  });

  /**
   * The render half of the box, on the playing fixture the simulation case uses rather than the
   * idle, AI-less one, and measured where the earlier version of this file was blind twice over:
   *
   * * **literals** — `src/render/` goes through the same transformer as `src/sim/`, because a
   *   `[crystals, vents, rubble]` per sync is invisible to a Vector spy and to an array-returning
   *   builtin spy alike.
   * * **three's own allocation** — `addUpdateRange` pushes a fresh `{ start, count }`, so the record
   *   it mints lives inside the dependency. Counting the calls is the only honest way to see it
   *   here, and a fixed frame must make zero of them after the cold first upload.
   *
   * The range is still there afterwards: one per attribute, the right count, the same record object
   * next frame, `version` still climbing, and the matrices still changing as the army walks. A fix
   * that dropped the range, or stopped writing, fails those.
   */
  it("syncs a playing sixty-unit match for 600 frames with no render literal and no new range", async () => {
    const three = await import("three");
    const watcher = watchLiterals(["render"], {
      three,
      "three/tsl": await import("three/tsl"),
      "three/webgpu": await import("three/webgpu"),
    });
    const { createArmy } = watcher.module("render/army.ts") as { createArmy: typeof createArmyRef };
    const { createUnitModels } = watcher.module("render/models.ts") as {
      createUnitModels: typeof createUnitModelsRef;
    };
    const { createResources } = watcher.module("render/resources.ts") as {
      createResources: typeof createResourcesRef;
    };
    const { createTerrain } = watcher.module("render/terrain.ts") as {
      createTerrain: typeof createTerrainRef;
    };
    const game = playingMatch();
    const camera = new OrthographicCamera(-53, 53, 30, -30, 1, 600);
    camera.position.set(-70, 62, 58);
    camera.lookAt(-70, 0, 58);
    const terrain = createTerrain();
    const resources = createResources();
    const models = createUnitModels();
    const army = createArmy(models);
    const selected = new Set<number>();
    for (const entity of game.own(0)) selected.add(entity.id);
    let time = 0;

    // Cold means a new instanced batch, and nothing else: the first sync that needs a (type, team)
    // bakes its models and builds its meshes, which runs three's own constructors. That is the
    // render half of the entity-birth frames the simulation case skips. `models.parts` is the seam —
    // `army.sync` asks for models exactly when it is building a batch it does not have, and the
    // models cache every answer after that. Nothing else may set `cold`, or a per-frame allocation
    // could excuse itself by looking like a birth.
    let cold = false;
    let batches = 0;
    const modelsSeam = models as { parts: typeof models.parts };
    const partsOf = modelsSeam.parts;
    modelsSeam.parts = (type, team) => {
      cold = true;
      batches += 1;
      return partsOf(type, team);
    };
    // `rendering` marks the boundary of the render sync, so the array sentinel below reports the
    // kit's rendering and nothing else: `game.step()` runs in its window too, but the simulation
    // has its own counter one case up, and a sentinel that reported both would name a line the
    // render fix cannot reach.
    let rendering = false;
    const sync = (): void => {
      terrain.updateFog(game);
      resources.sync(game);
      army.sync(game, selected, time, DT, camera);
    };
    const frame = (): void => {
      time += DT;
      cold = false;
      rendering = false;
      game.step();
      rendering = true;
      sync();
      rendering = false;
    };

    const arrays = countArrayAllocations(frame, () => rendering && !cold);

    // `addUpdateRange` is three's, so the spy goes on the prototype the meshes actually use. Which
    // calls are a failure depends on two independent facts, never on the call itself: whether the
    // frame is a genuine cold birth, and whether the attribute being ranged already existed before
    // the frame started. Only the first range on a never-seen attribute during a cold birth is
    // exempt. An ordinary frame's range on an attribute the window already had is three minting a
    // fresh `{ start, count }` every frame, and letting "some calls happened here" excuse it is
    // what made this sentinel report a zero it never saw.
    const attribute = three.BufferAttribute.prototype;
    const addUpdateRange = attribute.addUpdateRange;
    let minted = 0;
    let mintedCold = 0;
    const everRanged = new WeakSet<object>();
    attribute.addUpdateRange = function (
      this: InstanceType<typeof three.BufferAttribute>,
      start: number,
      count: number,
    ): void {
      const seenBefore = everRanged.has(this);
      everRanged.add(this);
      if (cold && !seenBefore) mintedCold += 1;
      else minted += 1;
      addUpdateRange.call(this, start, count);
    };
    const literals = new Map<string, number>();
    let steady = 0;
    let coldFrames = 0;
    let clones = 0;
    let constructors = 0;
    let stepped = 0;
    let matrix: InstanceType<typeof three.InstancedBufferAttribute> | undefined;
    let batchMesh: InstanceType<typeof three.InstancedMesh> | undefined;
    let live = 0;
    let before = "";
    const walked = (): string => (matrix?.array as Float32Array).join(",");
    try {
      for (let warm = 0; warm < WARMUP_FRAMES; warm += 1) frame();
      // The batch of the fixture's own moving tanks, found by the geometry the model hands the
      // mesh: a command core never moves, so a "the matrices changed" assertion on whatever mesh
      // happened to be first would pass on static data. This one has to actually be walking.
      const tank = models.parts("tank", 0)[0];
      batchMesh = army.root.children.find(
        (child) => child instanceof three.InstancedMesh && child.geometry === tank?.geometry,
      ) as InstanceType<typeof three.InstancedMesh> | undefined;
      if (batchMesh === undefined || batchMesh.count === 0)
        throw new Error("Allocation fixture found no populated tank batch to read.");
      matrix = batchMesh.instanceMatrix;
      live = batchMesh.count;
      before = walked();
      minted = 0;
      mintedCold = 0;
      probeState.vector2Allocations = 0;
      probeState.vector3Allocations = 0;
      probeState.vector3Clones = 0;
      for (let measured = 0; measured < MEASURED_FRAMES; measured += 1) {
        const clonesBefore = probeState.vector3Clones;
        const constructorsBefore = probeState.vector2Allocations + probeState.vector3Allocations;
        watcher.begin();
        frame();
        const observed = watcher.take();
        if (cold) {
          coldFrames += 1;
          continue;
        }
        stepped += 1;
        steady += observed.calls;
        clones += probeState.vector3Clones - clonesBefore;
        constructors +=
          probeState.vector2Allocations + probeState.vector3Allocations - constructorsBefore;
        for (const [line, count] of observed.lines)
          literals.set(line, (literals.get(line) ?? 0) + count);
      }
    } finally {
      attribute.addUpdateRange = addUpdateRange;
    }
    const allocations = { clones, constructors };
    // Read the window's verdict before the frame below, which checks that the upload survives.
    // That frame is not part of the measurement and must not move the number it reports.
    const ranged = minted;
    const batch = matrix;
    if (batch === undefined) throw new Error("Allocation fixture read no tank batch.");
    const record = batch.updateRanges[0];
    const version = batch.version;
    const after = walked();
    frame();

    // Reported, not just skipped: the window must mostly be steady frames, and the cold ones must
    // be few and real. Otherwise "zero on ordinary frames" would be a claim about no frames.
    console.log(
      `rts render window: ${stepped} of ${MEASURED_FRAMES} frames measured, ${coldFrames} skipped for a new batch, ${batches} batches built, ${mintedCold} first-attribute ranges on them, steady literals ${steady}`,
    );
    // Asserted before the sentinels, because a sentinel over a handful of frames is a claim about
    // no frames at all. A window this short is a broken fixture, not a clean one.
    expect(stepped, "most frames must be ordinary, not excused as a cold birth").toBeGreaterThan(
      300,
    );
    expect(
      batches,
      "the fixture must build a batch, or the cold exemption proves nothing",
    ).toBeGreaterThan(0);
    expect(selected.size).toBeGreaterThanOrEqual(OWN_UNITS);
    expect(allocations, "rts render vector allocation sentinel").toEqual({
      clones: 0,
      constructors: 0,
    });
    expect(
      arrays.calls,
      `rts render array allocation sentinel (${arrays.harness} harness allocations ignored): ${arrays.where.join("\n")}`,
    ).toBe(0);
    expect(
      [...literals.values()].reduce((a, b) => a + b, 0),
      `rts render literal sentinel: ${counted(literals)}`,
    ).toBe(0);
    expect(
      ranged,
      "rts render update-range sentinel: three mints one { start, count } per addUpdateRange call, and a per-frame call on an attribute the window already had is one of them",
    ).toBe(0);
    expect(batch.updateRanges.length, "the ranged upload must survive the frame").toBe(1);
    expect(
      batch.updateRanges[0],
      "the range record must be the same object next frame, not a fresh literal",
    ).toBe(record);
    expect(
      record?.count,
      "the range must cover the slots the batch is using, not its capacity",
    ).toBe(live * matrix.itemSize);
    expect(record?.start).toBe(0);
    expect(batch.version, "the upload must still be requested every frame").toBeGreaterThan(
      version,
    );
    expect(
      after,
      "the tank batch must have walked through the window, so the range covered live matrices",
    ).not.toBe(before);
    // A mesh that swaps its attribute gets its own record and the right count on the new one,
    // rather than a stale range carried over from the buffer it replaced.
    const fresh = new three.InstancedBufferAttribute(new Float32Array(16 * live), 16);
    batchMesh.instanceMatrix = fresh;
    frame();

    expect(fresh.updateRanges.length).toBe(1);
    expect(fresh.updateRanges[0]?.count).toBe(live * fresh.itemSize);
    expect(fresh.version, "the replaced attribute must still be uploaded").toBeGreaterThan(0);
    terrain.root.removeFromParent();
    resources.root.removeFromParent();
    army.root.removeFromParent();
    army.dispose();
    models.dispose();
  });

  it("runs 600 scene frames over the seeded battlefield without a fresh vector", async () => {
    const { Play } = await import("../templates/rts/src/scenes/Play.js");
    const { INITIAL_STATE } = await import("../templates/rts/src/state.js");
    const state = { ...INITIAL_STATE };
    const patchIdentities = new Set<object>();
    const scene = new Scene();
    const camera = new OrthographicCamera(-53, 53, 30, -30, 1, 600);
    const context = {
      add: (object: { isObject3D?: boolean }) => {
        scene.add(object as never);
        return object;
      },
      assets: { texture: async () => new Texture() },
      camera,
      canvasLayer: { camera, opaque: true, scene: new Scene() },
      entities: {
        add: <T>(_id: string, entity: T): T => entity,
        remove: () => undefined,
      },
      input: {
        axis: () => 0,
        justPressed: () => false,
        raw: {
          keys: new Set<string>(),
          pointer: { buttons: 0, position: new Vector2(0.5, 0.5) },
          pointerEdges: new Map<number, { type: string; id: number; buttons: number }[]>(),
          pointers: new Map<number, { position: Vector2 }>(),
        },
        vector: () => new Vector2(),
      },
      random: { range: (from: number, to: number) => from + 1 },
      renderer: {
        createRenderChain: () => ({
          applied: { dropped: [], stages: ["bloom"] },
          dispose: () => undefined,
        }),
        kind: "webgl",
        raw: { shadowMap: { enabled: false, type: 0 } },
        setOutputNode: () => undefined,
      },
      scene,
      state: {
        getState: () => state,
        set: (patch: unknown) => {
          patchIdentities.add(patch as object);
          Object.assign(state, patch as Record<string, unknown>);
        },
      },
      viewport: { size: { aspect: 16 / 9, height: 720, width: 1280 } },
    };

    const play = new Play();
    await play.load(context as never);
    const frame = play.enter(context as never);
    if (typeof frame !== "function")
      throw new Error("Allocation fixture returned no rts scene frame.");
    for (let warm = 0; warm < WARMUP_FRAMES; warm += 1) frame(context as never, DT);
    const warmPatches = patchIdentities.size;
    probeState.vector2Allocations = 0;
    probeState.vector3Allocations = 0;
    probeState.vector3Clones = 0;
    for (let measured = 0; measured < MEASURED_FRAMES; measured += 1) frame(context as never, DT);

    expect(state.selection).toBeGreaterThan(0);
    expect(state.simTime).toBeGreaterThan(0);
    // One reused patch object for the whole run: the scene mutates it rather than minting a new
    // one per frame, and the store would otherwise clone a fresh object sixty times a second.
    expect(patchIdentities.size, "rts Play state-patch high-water sentinel").toBe(warmPatches);
    expect(
      { clones: probeState.vector3Clones, constructors: probeState.vector3Allocations },
      "rts Play frame vector allocation sentinel",
    ).toEqual({ clones: 0, constructors: 0 });
    play.exit(context as never);
  });
});
