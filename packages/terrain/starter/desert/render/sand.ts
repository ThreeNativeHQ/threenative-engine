// The desert's loose sand: the prints a walker's feet press into it, the spray a running step
// throws, and the sand the wind drives over the dunes in streamers. `SnowField`
// (`@threenative/core/world`) keeps the numbers of a pressed surface and `GPUParticles3D` pools the
// grains; every colour, size, depth and rate below is this file's.
import { GPUParticles3D, type IAssetLoader } from "@threenative/core";
import { Heightfield, SnowField } from "@threenative/core/world";
import {
  BufferAttribute,
  type BufferGeometry,
  MathUtils,
  Mesh,
  type Object3D,
  PlaneGeometry,
  RepeatWrapping,
  type Texture,
  Vector2,
  Vector3,
} from "three";
import {
  Fn,
  If,
  attribute,
  cos,
  exp,
  float,
  hash,
  instanceIndex,
  mix,
  mx_noise_float,
  normalWorld,
  positionLocal,
  positionViewDirection,
  positionWorld,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uint,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  type ComputeNode,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  type Node,
  NormalBlending,
  SpriteNodeMaterial,
  type StorageBufferNode,
  type UniformNode,
} from "three/webgpu";
import type { TerrainCtx } from "../sceneState.js";
import { GROUND_MAPS, GROUND_TILE } from "../world/terrainAssets.js";
import { loadSkyLight, skyIrradiance } from "./props/pack.js";

/**
 * The pressed sand: a square of the ground round the walker, a sample every 4 cm (a foot is three
 * samples wide), with `depth` metres of loose sand on it. A foot sinks into the loose sand only.
 */
const FIELD = { size: 16, samples: 401, depth: 0.09, hardness: 0.3 } as const;
/** The square moves with the walker once they stand this near its edge; its old prints go. */
const EDGE = 2.5;
/** The ground is read every `COARSE` samples and interpolated: a square is rebuilt in a frame. */
const COARSE = 8;
/** Wind fills a print: metres of sand a second, and how fast it wears the rim down. */
const DRIFT = { deposition: 0.0009, wind: 0.5, every: 0.25 } as const;
/** The walker's weight in newtons, the sole's half width in metres and its area in m². */
const FOOT = { load: 80 * 9.81, halfWidth: 0.05, area: 0.028 } as const;
/**
 * A foot is down when its ball moves slower than `still` m/s within `low` metres of the ground,
 * and up again past `swing` m/s or `high` metres.
 */
const PLANT = { still: 0.7, low: 0.13, swing: 1.6, high: 0.18 } as const;
/** The rig's ankle and ball bones, left then right: a print lies under the two of them. */
const FEET = [
  ["foot_l", "ball_l"],
  ["foot_r", "ball_r"],
] as const;
/** Metres a second over which a step throws sand. */
const RUNNING = 3;
/** The wind: where it blows to (x, z, unit length) and its speed near the ground in m/s. */
export const SAND_WIND = { to: [0.86, 0.5], speed: 6 } as const;
/** Sand a running step throws: grains per step and on a landing, and seconds they live. */
const KICK = { amount: 384, life: 0.7, run: 9, land: 34 } as const;
/**
 * Sand on the wind: a sheet `size` metres across that lies `lift` metres over the ground round the
 * walker and draws the streamers the wind drives across it.
 */
const STREAMERS = { size: 56, cells: 56, lift: 0.07, opacity: 0.5 } as const;
/** Sand in the air, lit: these are linear, and neither the grains nor the streamers take light. */
const DUST: readonly [number, number, number] = [0.46, 0.235, 0.115];
const STATE = "sand";
/** Metres the untouched part of the print square lies under the ground. */
const SUNK = 40;

interface IPrintSample {
  readonly bank: number;
  readonly coverage: number;
  readonly disturbance: number;
  readonly relief: number;
  readonly shape: number;
}
const NOTHING: IPrintSample = { bank: 0, coverage: 0, disturbance: 0, relief: 0, shape: 0 };
const smooth = (edge0: number, edge1: number, value: number) =>
  MathUtils.smoothstep((value - edge0) / (edge1 - edge0), 0, 1);
/**
 * A foot in sand, local z from heel to toe, `half` metres from its middle to its toe: a rounded
 * sole a little wider at the ball, a deeper heel, and the sand it pushed out as a thin rim.
 */
function footPrint(half: number) {
  const corner = FOOT.halfWidth * 0.9;
  return {
    extent: (half + 0.07) * 2,
    sample: (x: number, z: number): IPrintSample => {
      const width = FOOT.halfWidth * (0.82 + smooth(-half, half * 0.5, z) * 0.26);
      const qx = Math.abs(x) - (width - corner);
      const qz = Math.abs(z) - (half - corner);
      const sdf =
        Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - corner;
      if (sdf > 0.06) return NOTHING;
      const rim = sdf > 0 ? Math.exp(-(((sdf - 0.02) / 0.018) ** 2)) : 0;
      return {
        bank: rim * 0.7,
        coverage: 1 - smooth(-0.02, 0.008, sdf),
        disturbance: rim * 0.5,
        relief: 0.005 * smooth(half * 0.2, -half, z),
        shape: 0.85 + 0.15 * smooth(half * 0.4, -half, z),
      };
    },
  };
}

interface IBuffers {
  readonly positions: StorageBufferNode<"vec3">;
  readonly velocities: StorageBufferNode<"vec3">;
  readonly births: StorageBufferNode<"float">;
}
interface IRequest {
  readonly first: UniformNode<"uint", number>;
  readonly count: UniformNode<"uint", number>;
  readonly origin: UniformNode<"vec3", Vector3>;
  readonly direction: UniformNode<"vec3", Vector3>;
  readonly seed: UniformNode<"float", number>;
}
type Runtime = { readonly time: Node<"float">; readonly delta: Node<"float"> };

/**
 * The sand a running foot throws: small grains that leave low and fall back within the step, not
 * a cloud. A burst's `direction` is its shape: x the speed outward, y the speed upward, z the
 * radius it starts in.
 */
function kickedSand() {
  const material = new SpriteNodeMaterial({
    blending: NormalBlending,
    depthWrite: false,
    transparent: true,
  });
  // The quad's empty corners write nothing to the depth and normal buffers, so AO skips them.
  material.alphaTest = 0.01;
  const bind = (born: Node<"float">): void => {
    const age = time.sub(born);
    const alive = varying(step(0, age).mul(step(age, KICK.life)));
    const phase = varying(age.div(KICK.life).clamp(0, 1));
    const jitter = hash(instanceIndex.add(7)).mul(0.7).add(0.6);
    material.scaleNode = mix(float(0.05), float(0.3), phase.sqrt()).mul(jitter).mul(alive);
    const round = float(1).sub(smoothstep(0.05, 0.5, uv().sub(0.5).length()));
    material.colorNode = vec4(
      vec3(...DUST),
      round
        .mul(round)
        .mul(float(1).sub(smoothstep(0.3, 1, phase)))
        .mul(0.5)
        .mul(alive),
    );
  };
  const spawn = ({ positions, velocities, births }: IBuffers, request: IRequest): ComputeNode => {
    bind(births.toAttribute());
    return Fn(() => {
      If(instanceIndex.lessThan(request.count), () => {
        const slot = request.first.add(instanceIndex).mod(uint(KICK.amount));
        const key = instanceIndex.add(request.seed.mul(977).toUint());
        const r = (salt: number) => hash(key.add(salt));
        const angle = r(1).mul(Math.PI * 2);
        const radius = r(2).sqrt().mul(request.direction.z);
        const out = request.direction.x.mul(r(3).mul(0.7).add(0.3));
        positions
          .element(slot)
          .assign(
            request.origin.add(
              vec3(cos(angle).mul(radius), r(4).mul(0.03), sin(angle).mul(radius)),
            ),
          );
        velocities
          .element(slot)
          .assign(
            vec3(
              cos(angle).mul(out),
              request.direction.y.mul(r(5).mul(0.8).add(0.3)),
              sin(angle).mul(out),
            ),
          );
      });
    })().compute(KICK.amount);
  };
  const wind = vec3(SAND_WIND.to[0], 0, SAND_WIND.to[1]).mul(SAND_WIND.speed * 0.25);
  const process = ({ positions, velocities, births }: IBuffers, runtime: Runtime): ComputeNode =>
    Fn(() => {
      const age = runtime.time.sub(births.element(instanceIndex));
      If(age.greaterThanEqual(0).and(age.lessThan(KICK.life)), () => {
        const velocity = velocities
          .element(instanceIndex)
          .mul(exp(float(-3).mul(runtime.delta)))
          .add(vec3(0, -5, 0).mul(runtime.delta));
        velocities.element(instanceIndex).assign(velocity);
        positions
          .element(instanceIndex)
          .addAssign(velocity.add(wind.mul(age.div(KICK.life))).mul(runtime.delta));
      });
    })().compute(KICK.amount);
  return { amount: KICK.amount, lifetime: KICK.life, material, process, spawn };
}

/**
 * Sand on the wind, as it looks on a dune: thin streamers that snake over the surface, come in
 * gusts, and show most where the eye looks along the ground. One sheet a hand over the sand
 * draws them; nothing floats in the air.
 */
function streamerMaterial(
  gust: UniformNode<"float", number>,
  centre: UniformNode<"vec2", Vector2>,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ depthWrite: false, transparent: true });
  const [wx, wz] = SAND_WIND.to;
  const along = positionWorld.x.mul(wx).add(positionWorld.z.mul(wz));
  const across = positionWorld.z.mul(wx).sub(positionWorld.x.mul(wz));
  const run = along.sub(time.mul(SAND_WIND.speed));
  // A streamer is metres long and a hand wide; its line wanders as it runs.
  const wander = mx_noise_float(vec2(run.mul(0.09), across.mul(0.12))).mul(1.6);
  const thread = mx_noise_float(vec2(run.mul(0.055), across.add(wander).mul(1.7)));
  const fine = mx_noise_float(vec2(run.mul(0.4), across.add(wander).mul(5.5)));
  const strand = smoothstep(0.18, 0.62, thread.add(fine.mul(0.35)));
  // The gusts: bands tens of metres across that cross the dunes with the wind.
  const band = smoothstep(
    -0.1,
    0.55,
    mx_noise_float(vec2(along.sub(time.mul(SAND_WIND.speed * 0.7)).mul(0.022), across.mul(0.03))),
  );
  // Seen from above a streamer is a few grains thick and vanishes; along the ground it is a veil.
  const grazing = float(1).sub(positionViewDirection.dot(normalWorld).abs()).pow(1.6);
  const reach = STREAMERS.size / 2;
  const edge = float(1).sub(
    smoothstep(reach * 0.55, reach * 0.95, positionWorld.xz.sub(centre).length()),
  );
  material.colorNode = vec3(...DUST).mul(strand.mul(0.25).add(0.9));
  material.opacityNode = strand.mul(band).mul(grazing).mul(edge).mul(gust).mul(STREAMERS.opacity);
  return material;
}

/** The print overlay: sand-coloured, drawn only where the field moved, dark in the hollow. */
function printMaterial(
  map: Texture | undefined,
  sky: Texture | undefined,
  sandTint: readonly [number, number, number],
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    depthWrite: false,
    roughness: 0.96,
    transparent: true,
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -6;
  // x: metres pressed in, y: metres of rim raised, z: 1 where the field wrote.
  const state = attribute(STATE, "vec3" as const);
  // The overlay keeps the pressed surface's normals and lies flat a centimetre over the ground it
  // copies: a hollow under the ground the kit draws would lose the depth test. The untouched part
  // of the square goes far under the ground, so it shades no pixel.
  material.positionNode = positionLocal.add(
    vec3(
      0,
      state.x
        .sub(state.y)
        .sub(FIELD.depth - 0.012)
        .sub(float(1).sub(state.z).mul(SUNK)),
      0,
    ),
  );
  const tint = vec3(...sandTint);
  const sand = map
    ? texture(map, positionWorld.xz.div(GROUND_TILE.grass)).rgb.mul(tint)
    : tint.mul(0.27);
  // Pressed sand is darker than the loose, sun-bleached grains round it; the rim is those grains.
  const hollow = smoothstep(0.004, 0.035, state.x);
  const rim = smoothstep(0.004, 0.02, state.y);
  material.colorNode = sand
    .mul(mix(float(1), float(0.52), hollow))
    .mul(mix(float(1), float(1.15), rim));
  material.opacityNode = smoothstep(0.001, 0.008, state.x.add(state.y));
  if (sky) {
    const { up, down } = skyIrradiance(sky);
    material.emissiveNode = (material.colorNode as Node<"vec3">)
      .mul(mix(vec3(...down), vec3(...up), normalWorld.y.mul(0.5).add(0.5)))
      .mul(0.6);
  }
  return material;
}

export interface ISandWalker {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  readonly grounded: boolean;
  /** The rig the walker draws: its `foot_*` and `ball_*` bones say where each print lies. */
  readonly figure: Object3D;
}
export interface ISand {
  /** Once a frame, after the walker moved and its rig posed. */
  update(dt: number, walker: ISandWalker): void;
  /** Prints pressed and grains thrown since the scene began, for a playtest to read. */
  readonly stats: { readonly prints: number; readonly grains: number };
  dispose(): void;
}

interface IFoot {
  readonly ankle: Object3D;
  readonly ball: Object3D;
  readonly last: Vector3;
  down: boolean;
}

/**
 * The loose sand under and round one walker: prints where their feet land, sand off a running
 * step, and streamers on the wind. `heightAt` is the ground the kit draws.
 */
export async function createSand(
  ctx: TerrainCtx,
  assets: IAssetLoader,
  heightAt: (x: number, z: number) => number,
  /** The tint the ground lays on its sand scan (`IBiome.grassTint`), so a print matches it. */
  sandTint: readonly [number, number, number],
): Promise<ISand> {
  const maps = GROUND_MAPS.grass;
  const [map, sky] = await Promise.all([
    maps?.diffuse
      ? assets
          .texture(maps.diffuse, { anisotropy: 8, data: false, wrap: RepeatWrapping })
          .catch(() => undefined)
      : undefined,
    loadSkyLight(assets),
  ]);
  const material = printMaterial(map, sky, sandTint);
  const kick = ctx.add(new GPUParticles3D(kickedSand()));
  const stats = { grains: 0, prints: 0 };

  // --- the streamers' sheet ---------------------------------------------------------------------
  const gust = uniform(1);
  const centre = uniform(new Vector2());
  const sheet = new Mesh(
    new PlaneGeometry(STREAMERS.size, STREAMERS.size, STREAMERS.cells, STREAMERS.cells).rotateX(
      -Math.PI / 2,
    ),
    streamerMaterial(gust, centre),
  );
  sheet.name = "sand-streamers";
  sheet.frustumCulled = false;
  ctx.add(sheet as Object3D);
  let laid = false;
  /** Lays the sheet on the ground round (`x`, `z`), on whole cells so the sand never swims. */
  const drape = (x: number, z: number): void => {
    const cell = STREAMERS.size / STREAMERS.cells;
    const [ox, oz] = [Math.round(x / cell) * cell, Math.round(z / cell) * cell];
    if (laid && sheet.position.x === ox && sheet.position.z === oz) return;
    laid = true;
    sheet.position.set(ox, 0, oz);
    const at = sheet.geometry.getAttribute("position") as BufferAttribute;
    for (let i = 0; i < at.count; i++)
      at.setY(i, heightAt(ox + at.getX(i), oz + at.getZ(i)) + STREAMERS.lift);
    at.needsUpdate = true;
    sheet.geometry.computeVertexNormals();
  };

  // --- the pressed square ------------------------------------------------------------------------
  let field: SnowField | undefined;
  let mesh: Mesh | undefined;
  let state: BufferAttribute | undefined;
  let indents: Float32Array = new Float32Array(0);
  let banks: Float32Array = new Float32Array(0);
  /** Lays the square round (`x`, `z`), on the sample grid so its vertices never swim. */
  const lay = (x: number, z: number): void => {
    const n = FIELD.samples;
    const cell = FIELD.size / (n - 1);
    const origin = { x: Math.round(x / cell) * cell, z: Math.round(z / cell) * cell };
    const [minX, minZ] = [origin.x - FIELD.size / 2, origin.z - FIELD.size / 2];
    // The ground every `COARSE` samples, then straight lines between: 2 600 reads, not 160 000.
    const knots = (n - 1) / COARSE + 1;
    const coarse = new Float32Array(knots * knots);
    for (let r = 0; r < knots; r++)
      for (let c = 0; c < knots; c++)
        coarse[r * knots + c] = heightAt(minX + c * COARSE * cell, minZ + r * COARSE * cell);
    const heights = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      const r0 = Math.min(knots - 2, Math.floor(r / COARSE));
      const tr = r / COARSE - r0;
      for (let c = 0; c < n; c++) {
        const c0 = Math.min(knots - 2, Math.floor(c / COARSE));
        const tc = c / COARSE - c0;
        const a = coarse[r0 * knots + c0] as number;
        const b = coarse[r0 * knots + c0 + 1] as number;
        const d = coarse[(r0 + 1) * knots + c0] as number;
        const e = coarse[(r0 + 1) * knots + c0 + 1] as number;
        heights[r * n + c] = (a + (b - a) * tc) * (1 - tr) + (d + (e - d) * tc) * tr;
      }
    }
    const ground = new Heightfield({
      columns: n,
      depth: FIELD.size,
      heights,
      origin,
      rows: n,
      width: FIELD.size,
    });
    // ponytail: a new square starts smooth, so the prints behind the walker go when it moves.
    // Carry the channels across with a `SnowField` window copy when a trail must outlast 5 m.
    field = new SnowField({ depth: FIELD.depth, field: ground, hardness: FIELD.hardness });
    field.takeDirtyRegions();
    const geometry: BufferGeometry = ground.toGeometry();
    state = new BufferAttribute(new Float32Array(n * n * 3), 3);
    geometry.setAttribute(STATE, state);
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geometry;
    } else {
      mesh = new Mesh(geometry, material);
      mesh.name = "sand-prints";
      // The untouched vertices are sunk out of its bounds.
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      ctx.add(mesh as Object3D);
    }
    mesh.position.set(origin.x, 0, origin.z);
  };
  /** Draws what the field wrote since the last frame: a print is a few hundred samples. */
  const redraw = (): void => {
    if (!field || !mesh || !state) return;
    const { columns, rows } = field;
    for (const written of field.takeDirtyRegions()) {
      const column = Math.max(0, written.column - 1);
      const row = Math.max(0, written.row - 1);
      const bounds = {
        column,
        columns: Math.min(columns, written.column + written.columns + 1) - column,
        row,
        rows: Math.min(rows, written.row + written.rows + 1) - row,
      };
      field.field.refreshGeometry(mesh.geometry, bounds);
      indents = field.copyChannel("indent", bounds, indents);
      banks = field.copyChannel("bank", bounds, banks);
      const values = state.array as Float32Array;
      for (let r = 0; r < bounds.rows; r++)
        for (let c = 0; c < bounds.columns; c++) {
          const vertex = (bounds.row + r) * columns + bounds.column + c;
          values[vertex * 3] = indents[r * bounds.columns + c] as number;
          values[vertex * 3 + 1] = banks[r * bounds.columns + c] as number;
          values[vertex * 3 + 2] = 1;
        }
      for (const name of ["position", "normal", STATE]) {
        const buffer = mesh.geometry.getAttribute(name) as BufferAttribute;
        for (let r = bounds.row; r < bounds.row + bounds.rows; r++)
          buffer.addUpdateRange(
            (r * columns + bounds.column) * buffer.itemSize,
            bounds.columns * buffer.itemSize,
          );
        buffer.needsUpdate = true;
      }
    }
  };

  // --- the feet ----------------------------------------------------------------------------------
  let feet: IFoot[] | undefined;
  let print: ReturnType<typeof footPrint> | undefined;
  const [ankle, ball] = [new Vector3(), new Vector3()];
  const throwSand = (x: number, z: number, count: number, speed: number): void => {
    kick.emitParticle({
      count,
      direction: { x: 0.4 + speed * 0.14, y: 0.6 + speed * 0.12, z: 0.06 },
      origin: { x, y: heightAt(x, z) + 0.02, z },
    });
    stats.grains += count;
  };
  /** Presses one foot where its bones stand (`ankle`, `ball`), heel to toe along the foot. */
  const press = (foot: IFoot, load: number): void => {
    if (!field || !mesh) return;
    const [dx, dz] = [ball.x - ankle.x, ball.z - ankle.z];
    const length = Math.hypot(dx, dz);
    if (length < 0.04) return;
    // The sole runs from a little behind the ankle to the toes past the ball.
    print ??= footPrint(MathUtils.clamp(length * 0.92, 0.1, 0.16));
    const [x, z] = [ankle.x + dx * 0.62, ankle.z + dz * 0.62];
    const half = FIELD.size / 2 - print.extent;
    if (Math.abs(x - mesh.position.x) > half || Math.abs(z - mesh.position.z) > half) return;
    const sunk = field.stamp({
      area: FOOT.area,
      footprint: print,
      load,
      rotation: Math.atan2(dx, dz),
      x,
      z,
    });
    if (sunk > 0) stats.prints += 1;
    foot.down = true;
  };
  const bones = (figure: Object3D): IFoot[] =>
    FEET.flatMap(([a, b]) => {
      const [ankleBone, ballBone] = [figure.getObjectByName(a), figure.getObjectByName(b)];
      return ankleBone && ballBone
        ? [{ ankle: ankleBone, ball: ballBone, down: false, last: new Vector3(Number.NaN) }]
        : [];
    });

  let airborne = false;
  let fall = 0;
  let settle = 0;
  let clock = 0;
  return {
    stats,
    update(dt, walker) {
      const { x, z } = walker.position;
      const inner = FIELD.size / 2 - EDGE;
      if (!mesh || Math.abs(x - mesh.position.x) > inner || Math.abs(z - mesh.position.z) > inner)
        lay(x, z);
      feet ??= bones(walker.figure);
      const speed = Math.hypot(walker.velocity.x, walker.velocity.z);
      const landed = walker.grounded && airborne && fall > 3;
      for (const foot of feet) {
        foot.ankle.getWorldPosition(ankle);
        foot.ball.getWorldPosition(ball);
        const pace =
          Number.isNaN(foot.last.x) || dt <= 0
            ? 0
            : Math.hypot(ball.x - foot.last.x, ball.z - foot.last.z) / dt;
        const lift = ball.y - heightAt(ball.x, ball.z);
        foot.last.copy(ball);
        if (foot.down && (pace > PLANT.swing || lift > PLANT.high)) foot.down = false;
        if (!walker.grounded) continue;
        if (landed) {
          foot.down = false;
          press(foot, FOOT.load * 3);
        } else if (!foot.down && pace < PLANT.still && lift < PLANT.low) {
          press(foot, FOOT.load * (speed > RUNNING ? 1.7 : 1));
          if (foot.down && speed > RUNNING) throwSand(ball.x, ball.z, KICK.run, speed);
        }
      }
      if (landed) throwSand(x, z, KICK.land, fall);
      airborne = !walker.grounded;
      fall = walker.grounded ? 0 : Math.max(fall, -walker.velocity.y);
      settle += dt;
      if (field && settle >= DRIFT.every) {
        field.recover(settle, DRIFT.deposition, DRIFT.wind);
        settle = 0;
      }
      redraw();
      clock += dt;
      drape(x, z);
      centre.value.set(x, z);
      gust.value = 0.6 + 0.4 * Math.sin(clock * 0.23) * Math.sin(clock * 0.071 + 1.3);
    },
    dispose() {
      kick.removeFromParent();
      sheet.removeFromParent();
      sheet.geometry.dispose();
      sheet.material.dispose();
      mesh?.removeFromParent();
      mesh?.geometry.dispose();
      material.dispose();
    },
  };
}
