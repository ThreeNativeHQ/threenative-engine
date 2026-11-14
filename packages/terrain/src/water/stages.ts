import type { IBiomeWaterBody } from "../biome/biome.js";
import { createFlow, fillDepressions, routeFlow } from "../core/fluvial.js";
import { round } from "../core/math.js";
import { Terrain } from "../core/terrain.js";
import type { ITerrainDocument, ITerrainState, Layer, SplinePoint } from "../core/types.js";
import type { TerrainFeature } from "../request/request-words.js";

// The water stage: the rows a request names become the recipe's rivers, lakes and sea, then the
// finished ground's own drainage routes what the recipe could not. `cookInto` calls these in this
// order; none of them evaluates the ground twice.

/** One recipe layer a water row reshapes, as a cook reads it before the evaluator sees it. */
interface IWaterLayer {
  type: string;
  id: string;
  params: Record<string, unknown>;
}

/**
 * Makes the recipe flood what the water rows say, so the ground and `water.json` follow the request.
 *
 * A row has no position and no path, so a river or lake row re-shapes the recipe's own layer of that
 * kind, in order: a river sets the ribbon width (and depth), a lake its radius. A layer with no row
 * is removed, and an ocean row adds a layer, since the ocean needs no seed. A river row with no layer
 * comes back to be routed down the finished ground (`routeRivers`), and a lake row with none to be
 * placed in its deepest closed basin (`placeLakes`).
 */
export function applyWaterRows(
  layers: IWaterLayer[],
  rows: readonly IBiomeWaterBody[],
): IBiomeWaterBody[] {
  const unrouted: IBiomeWaterBody[] = [];
  const queue = (kind: string): IWaterLayer[] =>
    layers.filter((layer) =>
      kind === "river"
        ? layer.type === "river"
        : layer.type === "water" && layer.params.kind !== "ocean",
    );
  const rivers = queue("river");
  const lakes = queue("lake");
  const keep = new Set<IWaterLayer>();
  for (const row of rows) {
    if (row.kind === "ocean") {
      layers.push({
        id: `ocean-${keep.size}`,
        type: "water",
        params: { kind: "ocean", level: row.level },
      });
      keep.add(layers[layers.length - 1] as IWaterLayer);
      continue;
    }
    const layer = (row.kind === "river" ? rivers : lakes).shift();
    if (layer === undefined) {
      unrouted.push(row);
      continue;
    }
    if (row.kind === "river") {
      // The row's width is the ribbon the world floods; the layer's own width stays the carved bed.
      layer.params.waterWidth =
        (row.width as number) / ((layer.params.width as number | undefined) ?? 12);
      if (row.depth !== undefined) layer.params.depth = row.depth;
    } else layer.params.radius = row.radius;
    keep.add(layer);
  }
  const dropped = layers.filter(
    (layer) => (layer.type === "river" || layer.type === "water") && !keep.has(layer),
  );
  for (const layer of dropped) layers.splice(layers.indexOf(layer), 1);
  return unrouted;
}

/**
 * Gives each river row a layer down the ground's own drainage: the main stem of the largest basin
 * that leaves the world, then the next largest at least an eighth of the world away. The stem runs
 * from where its catchment is a tenth of the outlet's to the edge, every 16 m. Bed, depth and
 * shoulder are the forest starter's river (7 m bed for a 5.32 m ribbon).
 */
/** The highest ocean row's level the recipe floods, or -Infinity with no sea. */
function seaLevel(recipe: ITerrainDocument & { layers: Layer[] }): number {
  return Math.max(
    Number.NEGATIVE_INFINITY,
    ...recipe.layers.flatMap((layer) =>
      layer.type === "water" && layer.params.kind === "ocean" ? [layer.params.level ?? 0] : [],
    ),
  );
}

/**
 * Carves each feature a request names into the ground, before the recipe's first erosion so the
 * erosion and terraces shape its walls. Both are an inverted mesa stamp: a flat floor and steep
 * walls. A canyon runs across the whole square, cut 35 % of the ground's relief (30 to 90 m: a gorge in
 * the alps is a gorge, not a rift). A
 * fjord runs from one border to just past the centre with its floor 12 m under the sea, so the sea
 * floods it as an inlet. The seed turns both, so one request and seed carve the same ground.
 */
export function carveFeatures(
  recipe: ITerrainDocument & { layers: Layer[] },
  features: readonly TerrainFeature[],
): void {
  if (features.length === 0) return;
  const { height, size } = Terrain.fromJSON(recipe).evaluate();
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of height) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const sea = seaLevel(recipe);
  const seed = recipe.config.seed ?? 0;
  const canyonDepth = Math.min(90, Math.max(30, 0.35 * (high - low)));
  const cuts = features.map((feature, index): Layer => {
    const turn = (seed * 47 + index * 70) % 180;
    const radians = (turn * Math.PI) / 180;
    // The stamp's length runs along its own z: rotated by `turn`, that is (-sin, cos).
    const reach = feature === "canyon" ? 0 : size * 0.45;
    return {
      enabled: true,
      opacity: 1,
      id: `${feature}-${String(index)}`,
      type: "stamp",
      params: {
        shape: "mesa",
        at: [-Math.sin(radians) * reach, Math.cos(radians) * reach],
        // A wall spans half the half-width: at 0.9 m per metre of depth it stands about 66 degrees,
        // the steepest a 2 m heightfield draws without a ladder of stretched cells.
        radius:
          feature === "canyon"
            ? [Math.max(size * 0.1, canyonDepth * 0.9), size * 1.2]
            : [size * 0.05, size * 0.5],
        rotation: turn,
        amplitude:
          feature === "canyon"
            ? -canyonDepth
            : -(high - (sea === Number.NEGATIVE_INFINITY ? low : sea) + 12),
        roughness: 0.15,
        blend: "add",
      },
    } as Layer;
  });
  const erosion = recipe.layers.findIndex((layer) => layer.type === "erode");
  recipe.layers.splice(erosion < 0 ? recipe.layers.length : erosion, 0, ...cuts);
}

/**
 * Drops the square's border into a sea the request names, when the ground stands above it there:
 * "a volcanic island" is a volcano the sea surrounds, not a slab in a flooded plane. It is the noise
 * operation's own island falloff with no noise of its own, deep enough that the border's highest
 * point lands three metres under the sea where the falloff reaches its mid-edges.
 */
export function shapeCoast(recipe: ITerrainDocument & { layers: Layer[] }): void {
  const sea = seaLevel(recipe);
  if (sea === Number.NEGATIVE_INFINITY) return;
  const state = Terrain.fromJSON(recipe).evaluate();
  const n = state.resolution;
  let border = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < n; k += 1)
    for (const i of [k, (n - 1) * n + k, k * n, k * n + n - 1])
      border = Math.max(border, state.height[i] as number);
  if (border < sea) return;
  // The island falloff at a mid-edge (r = 0.5 / 0.59) is smoothstep(0.6, 1, r) = 0.676 of its depth.
  recipe.layers.push({
    enabled: true,
    opacity: 1,
    id: "coast",
    type: "noise",
    params: { amplitude: 0, scale: 1, island: true, coastDepth: (border - sea + 3) / 0.676 },
  } as Layer);
}

/**
 * Places each lake row the recipe had no layer for in the finished ground's deepest closed basin,
 * filled to the level it spills at: where water would stand. A basin is one the whole lake fits
 * around inside the square and on land (a lake radius from the nearest sea), clear of the lakes
 * before it. Ground with no basin a
 * metre deep gets one: a crater stamp at its lowest such ground, then flooded to its rim. The ground
 * decides, so one request and seed place the same lakes.
 */
export function placeLakes(
  recipe: ITerrainDocument & { layers: Layer[] },
  rows: readonly IBiomeWaterBody[],
): void {
  const sea = seaLevel(recipe);
  const placed: [number, number, number][] = [];
  rows.forEach((row, index) => {
    let radius = row.radius as number;
    const site = (): {
      depth: number;
      ground: number;
      level: number;
      room: number;
      world: [number, number];
    } => {
      const state = Terrain.fromJSON(recipe).evaluate();
      const { resolution: n, size } = state;
      const filled = Float64Array.from(state.height);
      fillDepressions(filled, n);
      const world = (i: number): [number, number] => [
        ((i % n) / (n - 1) - 0.5) * size,
        (Math.floor(i / n) / (n - 1) - 0.5) * size,
      ];
      // Cells from the nearest sea cell (8-neighbour steps), so a whole lake stands on land.
      const shore = new Float64Array(n * n).fill(Number.POSITIVE_INFINITY);
      const queue: number[] = [];
      for (let i = 0; i < n * n; i += 1)
        if ((state.height[i] as number) <= sea + 1) {
          shore[i] = 0;
          queue.push(i);
        }
      for (let head = 0; head < queue.length; head += 1) {
        const i = queue[head] as number;
        const x = i % n;
        const z = Math.floor(i / n);
        for (let dz = -1; dz <= 1; dz += 1)
          for (let dx = -1; dx <= 1; dx += 1) {
            if (x + dx < 0 || x + dx >= n || z + dz < 0 || z + dz >= n) continue;
            const j = i + dz * n + dx;
            if ((shore[j] as number) > (shore[i] as number) + 1) {
              shore[j] = (shore[i] as number) + 1;
              queue.push(j);
            }
          }
      }
      const cell = size / (n - 1);
      let best = -1;
      let low = -1;
      // Ground too small for the whole lake still takes it at its most inland cell.
      let inland = -1;
      for (let i = 0; i < n * n; i += 1) {
        const [x, z] = world(i);
        if (
          (shore[i] as number) > 0 &&
          (inland < 0 || (shore[i] as number) > (shore[inland] as number))
        )
          inland = i;
        if (Math.max(Math.abs(x), Math.abs(z)) > size / 2 - radius) continue;
        if ((shore[i] as number) * cell <= radius) continue;
        if (!placed.every(([px, pz, r]) => Math.hypot(x - px, z - pz) > r + radius)) continue;
        const depth = (filled[i] as number) - (state.height[i] as number);
        if (best < 0 || depth > (filled[best] as number) - (state.height[best] as number)) best = i;
        if (low < 0 || (state.height[i] as number) < (state.height[low] as number)) low = i;
      }
      if (low < 0) low = best = inland;
      if (low < 0)
        throw new Error("cook: water row 'lake' found no ground above the sea to sit on.");
      // A basin holds the lake when it is a metre deep and floods a quarter of the lake's own disc:
      // a pocket in a canyon floor is a puddle, not a lake.
      let flooded = 0;
      if ((filled[best] as number) - (state.height[best] as number) >= 1) {
        const level = filled[best] as number;
        const [bx, bz] = world(best);
        const seen = new Uint8Array(n * n);
        const stack = [best];
        seen[best] = 1;
        while (stack.length > 0) {
          const i = stack.pop() as number;
          flooded += 1;
          for (const j of [i - 1, i + 1, i - n, i + n]) {
            if (j < 0 || j >= n * n || seen[j] || Math.abs((j % n) - (i % n)) > 1) continue;
            const [x, z] = world(j);
            if ((state.height[j] as number) >= level || Math.hypot(x - bx, z - bz) > radius)
              continue;
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      const holds = flooded * cell * cell >= 0.25 * Math.PI * radius * radius;
      const depth = holds ? (filled[best] as number) - (state.height[best] as number) : 0;
      const at = holds ? best : low;
      const ground = state.height[at] as number;
      return {
        depth,
        ground,
        level: holds ? (filled[at] as number) : ground + 2,
        // Metres from this cell to the nearest sea: the room a dug basin has on this ground.
        room: (shore[at] as number) * cell,
        world: world(at),
      };
    };
    let found = site();
    if (found.depth < 1) {
      // A dug basin and its rim stay on land: an island too small for the lake takes a smaller one.
      radius = Math.min(radius, found.room * 0.55);
      // A slope leaves a crater's downhill rim open, so a level pad goes under it first. The
      // crater's bowl spans about half its radius, so the stamp is sized for the lake to fit.
      recipe.layers.push({
        enabled: true,
        opacity: 1,
        id: `lake-${String(index)}-shelf`,
        type: "flatten",
        params: {
          at: found.world,
          radius: radius / 0.55,
          height: found.ground,
          strength: 1,
          falloff: 0.35,
        },
      } as Layer);
      recipe.layers.push({
        enabled: true,
        opacity: 1,
        id: `lake-${String(index)}-basin`,
        type: "stamp",
        params: {
          shape: "crater",
          at: found.world,
          radius: radius / 0.55,
          amplitude: 10,
          roughness: 0,
          blend: "add",
        },
      } as Layer);
      found = site();
    }
    placed.push([found.world[0], found.world[1], radius]);
    recipe.layers.push({
      enabled: true,
      opacity: 1,
      id: `lake-${String(index)}`,
      type: "water",
      params: { kind: "lake", at: found.world, radius, level: found.level },
    } as Layer);
  });
}

export function routeRivers(
  recipe: ITerrainDocument & { layers: Layer[] },
  rows: readonly IBiomeWaterBody[],
): void {
  const state = Terrain.fromJSON(recipe).evaluate();
  const { resolution: n, size } = state;
  const filled = Float64Array.from(state.height);
  fillDepressions(filled, n);
  const flow = createFlow(n);
  routeFlow(filled, n, flow);
  const roots: number[] = [];
  for (let i = 0; i < n * n; i += 1) if ((flow.receiver[i] as number) < 0) roots.push(i);
  roots.sort((a, b) => (flow.cells[b] as number) - (flow.cells[a] as number));
  const world = (i: number): [number, number] => [
    ((i % n) / (n - 1) - 0.5) * size,
    (Math.floor(i / n) / (n - 1) - 0.5) * size,
  ];
  const outlets: number[] = [];
  for (const root of roots) {
    if (outlets.length === rows.length) break;
    const [x, z] = world(root);
    const apart = outlets.every((o) => {
      const [ox, oz] = world(o);
      return Math.hypot(x - ox, z - oz) >= size / 8;
    });
    if (apart) outlets.push(root);
  }
  const step = Math.max(1, Math.round((16 / size) * (n - 1)));
  rows.forEach((row, index) => {
    const outlet = outlets[index];
    if (outlet === undefined)
      throw new Error(`cook: water row 'river' found no drainage basin to run down.`);
    // Up the stem: always the donor carrying the most water, until the catchment is a tenth.
    const stem = [outlet];
    const source = (flow.cells[outlet] as number) * 0.1;
    for (let cell = outlet; ; ) {
      let next = -1;
      const x = cell % n;
      const z = Math.floor(cell / n);
      for (let dz = -1; dz <= 1; dz += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dz === 0) continue;
          if (x + dx < 0 || x + dx >= n || z + dz < 0 || z + dz >= n) continue;
          const j = cell + dz * n + dx;
          if (flow.receiver[j] !== cell) continue;
          if (next < 0 || (flow.cells[j] as number) > (flow.cells[next] as number)) next = j;
        }
      if (next < 0 || (flow.cells[next] as number) < source) break;
      stem.push(next);
      cell = next;
    }
    if (stem.length < 2 * step)
      throw new Error(`cook: water row 'river' found no stem longer than 32 m to run down.`);
    // Source first, the edge last: downstream order, as the starters author theirs.
    const cells = stem.reverse().filter((_, k) => k % step === 0 || k === stem.length - 1);
    const points: SplinePoint[] = cells.map((cell) => {
      const [x, z] = world(cell);
      return [x, null, z];
    });
    const bed = (row.width as number) / 0.76;
    recipe.layers.push({
      enabled: true,
      opacity: 1,
      id: `river-${index}`,
      type: "river",
      params: {
        followTerrain: true,
        points,
        width: bed,
        waterWidth: 0.76,
        depth: row.depth ?? 1.8,
        shoulder: 10,
      },
    } as Layer);
  });
}

/**
 * The water bodies the cooked world floods, read from the evaluated state `water.json` also comes
 * from: a lake at its own level and radius, the ocean at its level, a river at its ribbon width.
 */
export function floodedBodies(state: ITerrainState): IBiomeWaterBody[] {
  return [
    ...state.waters.map(
      (water): IBiomeWaterBody =>
        water.kind === "ocean"
          ? { kind: "ocean", level: water.level }
          : { kind: "lake", radius: water.radius ?? state.size, level: water.level },
    ),
    ...state.rivers.map((river): IBiomeWaterBody => ({ kind: "river", width: round(river.width) })),
  ];
}
