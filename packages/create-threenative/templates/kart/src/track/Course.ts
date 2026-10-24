/**
 * Clover Loop in track space: a closed centre line sampled every metre, and the road, kerb, grass
 * and wall lines measured sideways from it. This is how the reference keeps a kart on its course
 * (MK64 path points plus a surface under each wheel), so a kart needs no physics collider: where
 * it is along the line and how far off it says what it stands on and whether it hit a wall.
 *
 * The line is a figure-8. At its crossing one branch is a bridge 7 m up and the other an underpass,
 * so a kart may only search a few metres around where it was (`track`), never the whole line — a
 * whole-line search would put a kart on the bridge into the underpass below it.
 */

/** Metres between samples of the centre line. */
export const STEP = 1;

/** The lateral profile, in metres from the centre line. */
export const PROFILE = {
  /** Half the asphalt's width: 13 m of road, about 7 karts abreast. */
  road: 6.5,
  /** The red-and-white kerb strip outside the asphalt; it drives like road. */
  kerb: 0.8,
  /** Where the wall stands, measured from the centre, on ordinary ground. */
  wall: 11,
  /** Where the bridge's rails stand: the deck has no grass. */
  rail: 7.6,
} as const;

/** What a kart's wheels are on, and the drag it adds (MK64's surface table, medium weight). */
export type Surface = "road" | "grass" | "water";
export const SURFACE_DRAG: Record<Surface, number> = { grass: 0.3, road: 0, water: 0.15 };

export interface ITrackPoint {
  /** Sample index along the line; the start line is index 0. */
  readonly index: number;
  /** Signed sideways offset in metres: positive is the right of the direction of travel. */
  readonly lateral: number;
}

/** Design of the course in fractions of a lap, so the layout survives a change of length. */
export const LAYOUT = {
  /** Metres from the bridge's centre to the start line: past the bridge's down ramp, so the grid
   * stands on the flat and the bridge closes the lap. */
  start: 90,
  /** The crossing's upper branch: level for `flat` metres each side of the crossing (where the two
   * roads overlap in plan), then a `ramp` down. The lower branch sinks `cut` metres under it. */
  bridge: { flat: 26, ramp: 42, height: 6.5, cut: 1.5 },
  /** The jump: a kicker, a lip, then a creek dip the kart flies over. */
  jump: { at: 0.42, kick: 10, rise: 1.4, drop: 3, depth: 2.2, floor: 9, climb: 7 },
  /** Boost pads: lap fraction and lateral offset of each, a 4 m x 3 m chevron. */
  pads: [
    { at: 0.04, lateral: -2.5 },
    // On the back straight, so a kart reaches the jump on a boost.
    { at: 0.385, lateral: -5 },
    { at: 0.7, lateral: 0 },
    { at: 0.86, lateral: -2 },
  ],
  /** Item box rows: lap fraction of each row of four. */
  boxes: [0.19, 0.51, 0.74],
  /** Ordered checkpoints a lap must pass before the line counts (the line itself is the fourth). */
  checkpoints: [0.25, 0.5, 0.75],
} as const;

/** 1 within `flat` metres of `at`, easing to 0 over the next `ramp` metres, round a loop of `length`. */
function plateau(s: number, at: number, length: number, flat: number, ramp: number): number {
  let d = Math.abs(s - at) % length;
  d = Math.min(d, length - d);
  return 1 - smooth(flat, flat + ramp, d);
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export interface ICourse {
  /** Centre-line length in metres. */
  readonly length: number;
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** Unit tangent along the direction of travel, on the ground plane. */
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  /** Road slope dy/ds, for the kart's pitch. */
  readonly slope: Float32Array;
  /** Wall distance from the centre at each sample (the rail on the bridge). */
  readonly wall: Float32Array;
  /** 1 on the bridge deck, 0 on the ground. */
  readonly deck: Float32Array;
  /** Index of each checkpoint, in lap order; the start line (index 0) closes the lap. */
  readonly checkpoints: readonly number[];
  readonly pads: readonly { readonly index: number; readonly lateral: number }[];
  readonly boxes: readonly number[];
  /** First and last sample of the creek dip, whose floor is water. */
  readonly creek: readonly [number, number];
  /** Wraps any integer onto the line. */
  wrap(index: number): number;
  /** Finds a kart again near where it was, MK64's −3..+6 window (`path_utils.inc.c:300`). */
  track(from: number, x: number, z: number, out?: { index: number; lateral: number }): ITrackPoint;
  surface(point: ITrackPoint): Surface;
  /** Road height under x/z near sample `index`, interpolated between samples so a fast kart
   * does not feel the 1 m steps as bumps. */
  heightAt(index: number, x: number, z: number): number;
  /** World position of `lateral` metres off sample `index`, on the road surface. */
  pointAt(index: number, lateral: number, out: { x: number; y: number; z: number }): void;
}

/**
 * The figure-8's plan. `x = A·sin t`, `z = B·sin t·cos t + C·sin 3t`: two lobes that cross at the
 * origin (t = 0 and t = π) at about 57°, a hairpin of about 15 m at each lobe's tip and a chicane
 * from the `sin 3t` term, which is zero at both crossings, so the crossing stays a single point.
 */
const PLAN = { A: 120, B: 75, C: 11 } as const;

/** Rolling relief along the line (lap fraction `u`), faded to zero at the crossing by `away`. */
function relief(u: number, away: number): number {
  return away * (1.6 * Math.sin(u * Math.PI * 6 + 0.7) + 0.9 * Math.sin(u * Math.PI * 10 + 2.1));
}

/** The jump's height profile in metres along the line, relative to the relief. */
function jumpProfile(s: number, start: number): number {
  const { kick, rise, drop, depth, floor, climb } = LAYOUT.jump;
  const d = s - start;
  if (d < 0) return 0;
  if (d < kick) return rise * (d / kick) ** 1.6;
  if (d < kick + drop) return rise - (rise + depth) * smooth(0, 1, (d - kick) / drop);
  if (d < kick + drop + floor) return -depth;
  if (d < kick + drop + floor + climb) return -depth * (1 - smooth(0, 1, (d - kick - drop - floor) / climb));
  return 0;
}

export function buildCourse(): ICourse {
  // Dense parametric samples, then resampled every STEP metres of arc length.
  const dense = 8000;
  const px: number[] = [];
  const pz: number[] = [];
  const arc: number[] = [0];
  for (let i = 0; i <= dense; i += 1) {
    const t = (i / dense) * Math.PI * 2;
    px.push(PLAN.A * Math.sin(t));
    pz.push(PLAN.B * Math.sin(t) * Math.cos(t) + PLAN.C * Math.sin(3 * t));
    if (i > 0) arc.push((arc[i - 1] ?? 0) + Math.hypot(px[i]! - px[i - 1]!, pz[i]! - pz[i - 1]!));
  }
  const total = arc[dense] ?? 0;
  const count = Math.floor(total / STEP);
  const length = count * STEP;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const z = new Float32Array(count);
  const tx = new Float32Array(count);
  const tz = new Float32Array(count);
  const slope = new Float32Array(count);
  const wall = new Float32Array(count);
  const deck = new Float32Array(count);
  // t = 0 is the crossing's upper branch. Sample index i is `start` metres further on, so the
  // start line is index 0 and the bridge's centre is `count - start`.
  const start = Math.round(LAYOUT.start / STEP);
  let j = 0;
  for (let k = 0; k < count; k += 1) {
    const s = (k / count) * total;
    while (j < dense - 1 && (arc[j + 1] ?? 0) < s) j += 1;
    const f = (s - (arc[j] ?? 0)) / ((arc[j + 1] ?? 1) - (arc[j] ?? 0));
    const i = (k - start + count) % count;
    x[i] = px[j]! + (px[j + 1]! - px[j]!) * f;
    z[i] = pz[j]! + (pz[j + 1]! - pz[j]!) * f;
  }
  const bridgeAt = (count - start) * STEP;
  // The lower branch passes the crossing near the middle of the lap: its closest sample to it.
  let underAt = 0;
  let closest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    let apart = Math.abs(i * STEP - bridgeAt);
    apart = Math.min(apart, length - apart);
    const d = Math.hypot(x[i]!, z[i]!);
    if (apart > length / 4 && d < closest) {
      closest = d;
      underAt = i * STEP;
    }
  }
  const jumpStart = LAYOUT.jump.at * length;
  for (let i = 0; i < count; i += 1) {
    const next = (i + 1) % count;
    const prev = (i - 1 + count) % count;
    const dx = x[next]! - x[prev]!;
    const dz = z[next]! - z[prev]!;
    const n = Math.hypot(dx, dz) || 1;
    tx[i] = dx / n;
    tz[i] = dz / n;
    const s = i * STEP;
    const { flat, ramp, height, cut } = LAYOUT.bridge;
    const onBridge = plateau(s, bridgeAt, length, flat, ramp);
    const inCut = plateau(s, underAt, length, flat, ramp);
    const away = 1 - plateau(s, bridgeAt, length, flat + ramp, 20) - plateau(s, underAt, length, flat, 30);
    y[i] = height * onBridge - cut * inCut + relief(i / count, away) + jumpProfile(s, jumpStart);
    // The deck is the stretch where the bridge stands clear of the ground under it.
    deck[i] = onBridge > 0.3 ? 1 : 0;
    wall[i] = deck[i] === 1 ? PROFILE.rail : PROFILE.wall;
  }
  for (let i = 0; i < count; i += 1) {
    slope[i] = (y[(i + 1) % count]! - y[(i - 1 + count) % count]!) / (2 * STEP);
  }
  const index = (fraction: number) => Math.round(fraction * count) % count;
  const creekFirst = Math.round((jumpStart + LAYOUT.jump.kick + LAYOUT.jump.drop) / STEP);
  const wrap = (i: number) => ((i % count) + count) % count;
  const lateralOf = (i: number, px0: number, pz0: number) =>
    // Right of travel: the tangent turned 90° clockwise seen from above, (−tz, tx).
    (px0 - x[i]!) * -tz[i]! + (pz0 - z[i]!) * tx[i]!;
  return {
    boxes: LAYOUT.boxes.map(index),
    checkpoints: LAYOUT.checkpoints.map(index),
    count,
    creek: [creekFirst, creekFirst + LAYOUT.jump.floor],
    deck,
    length,
    heightAt(i, px0, pz0) {
      const k = wrap(i);
      const along = (px0 - x[k]!) * tx[k]! + (pz0 - z[k]!) * tz[k]!;
      const other = wrap(k + (along >= 0 ? 1 : -1));
      const f = Math.min(1, Math.abs(along) / STEP);
      return y[k]! + (y[other]! - y[k]!) * f;
    },
    pads: LAYOUT.pads.map(({ at, lateral }) => ({ index: index(at), lateral })),
    pointAt(i, lateral, out) {
      const k = wrap(Math.round(i));
      out.x = x[k]! - tz[k]! * lateral;
      out.y = y[k]!;
      out.z = z[k]! + tx[k]! * lateral;
    },
    slope,
    surface({ index: i, lateral }) {
      const off = Math.abs(lateral);
      if (i >= creekFirst && i <= creekFirst + LAYOUT.jump.floor && off < PROFILE.wall) return "water";
      return off <= PROFILE.road + PROFILE.kerb ? "road" : "grass";
    },
    track(from, px0, pz0, out = { index: 0, lateral: 0 }) {
      let best = wrap(from);
      let bestD = Number.POSITIVE_INFINITY;
      for (let k = -3; k <= 6; k += 1) {
        const i = wrap(from + k);
        const d = (px0 - x[i]!) ** 2 + (pz0 - z[i]!) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      out.index = best;
      out.lateral = lateralOf(best, px0, pz0);
      return out;
    },
    tx,
    tz,
    wall,
    wrap,
    x,
    y,
    z,
  };
}
