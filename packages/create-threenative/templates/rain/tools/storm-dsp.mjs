// The reference study's audio maths, transcribed out of `/home/joao/Downloads/tempest.html`
// (`class StormAudio`, lines 551-583) so `make-storm-audio.mjs` can bake it offline.
//
// Every constant below is the source's, character for character, and every line of the two
// generators is the source's arithmetic rearranged to fill a typed array instead of an
// AudioBuffer. Nothing here is a redesign: the source runs this DSP on the audio thread against
// live Web Audio nodes, and the native host has no AudioContext at all, so the same numbers are
// computed once here and committed as PCM. The runtime constants that the source applied to *nodes*
// (the master gain, the biquads, the compressor, the distance delay) are named in
// `src/audio/storm.ts`, where the engine's own equivalents are applied instead.

/** `this.rng = rng(544)` — the same mulberry32 the rest of the study seeds with. */
export const STORM_SEED = 544;

/** `ctx.createBuffer(2, ctx.sampleRate * 3, ctx.sampleRate)` — both loops are three seconds. */
export const LOOP_SECONDS = 3;

/** `const duration = 7` — the thunder buffer. */
export const THUNDER_SECONDS = 7;

/**
 * `makeLoop(low, high, volume)` as the source calls it:
 * `this.rainGain = this.makeLoop(1800, 11000, .09)` and
 * `this.windGain = this.makeLoop(35, 350, .05)`.
 *
 * `volume` is recorded because the source passes it to the gain node and then overwrites that
 * node every frame in `update()`; the levels that are ever heard are the `update()` ones in
 * `src/audio/storm.ts`, so this generator does not apply them.
 */
export const LOOPS = {
  rain: { highpassHz: 1800, lowpassHz: 11000, nodeGain: 0.09 },
  wind: { highpassHz: 35, lowpassHz: 350, nodeGain: 0.05 },
};

/** The pink integrator: `pink = .96 * pink + .04 * w`, and the `low < 100 ? pink * 4 : w * .6` pick. */
const PINK_POLE = 0.96;
const PINK_FEED = 0.04;
const PINK_SCALE = 4;
/** `w = rng() * 2 - 1`, used at full scale for the loop bodies. */
const WHITE_SCALE = 0.6;

/** Thunder's brown integrator: `low = .985 * low + n * .015`, and the `low * 7` it is scaled by. */
const BROWN_POLE = 0.985;
const BROWN_FEED = 0.015;
const BROWN_SCALE = 7;

/** `Math.exp(-t * 22) * n * .8` — the crack, and the only part of the buffer that is not brown. */
const CRACK_DECAY = 22;
const CRACK_LEVEL = 0.8;
/** `low * 7 * (1 - Math.exp(-t * 4)) * Math.exp(-t * .66)` — the rumble's attack and release. */
const RUMBLE_ATTACK = 4;
const RUMBLE_DECAY = 0.66;
/** `(.68 + .32 * Math.sin(t * 9 + c))` — the tremolo, and the one-radian offset between channels. */
const TREMOLO_RATE = 9;
const TREMOLO_DEPTH = 0.32;
const TREMOLO_FLOOR = 0.68;

/** `function rng(seed = 1)` verbatim, so a given seed is the same stream the source drew. */
export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The RBJ biquad `BiquadFilterNode` computes, for the two types the source uses and at Q = 1,
 * which is the spec default: `highpass` and `lowpass` share the same denominator.
 *
 * Returns `[b0, b1, b2, a1, a2]` already divided by a0, so the recursion is
 * `y = b0 x + b1 x1 + b2 x2 - a1 y1 - a2 y2`.
 */
export function biquad(type, hz, sampleRate, q = 1) {
  const w0 = (2 * Math.PI * hz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const b =
    type === "highpass"
      ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
      : [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  const a0 = 1 + alpha;
  return [b[0] / a0, b[1] / a0, b[2] / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

/**
 * Runs a biquad over `input` as a *periodic* signal and returns exactly one period.
 *
 * The source filtered a looping buffer with a live node, so the filter state was continuous
 * across every wrap forever. Filtering a finite buffer instead leaves the filter's state at the
 * end of the file, and the join back to the start is a step — an audible click on a loop that
 * repeats forever, which is the defect `packages/assets/src/passes/audio.ts` is built to reject.
 * Running the recursion over the input repeated twice and keeping the second period is the
 * steady-state response of a periodic input, so the wrap lands exactly where the join is.
 */
export function filterLoop(input, coefficients) {
  const [b0, b1, b2, a1, a2] = coefficients;
  const n = input.length;
  const out = new Float64Array(n);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let k = 0; k < n * 2; k += 1) {
    const x = input[k % n];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    if (k >= n) out[k - n] = y;
  }
  return out;
}

/**
 * `makeLoop`'s buffer body, one channel at a time, before the source's filters.
 *
 * Channel-major, because that is the order the source drew from its one generator: it filled
 * channel 0 from `length` draws and then channel 1 from the next `length`. The pink state is
 * per channel — `let pink = 0` is inside the channel loop — so the two channels share no state.
 */
export function loopBody({ band, sampleRate, rng }) {
  const n = Math.round(LOOP_SECONDS * sampleRate);
  const channels = [];
  const pink = band.highpassHz < 100;
  for (let c = 0; c < 2; c += 1) {
    const data = new Float64Array(n);
    let state = 0;
    for (let i = 0; i < n; i += 1) {
      const w = rng() * 2 - 1;
      if (!pink) {
        data[i] = w * WHITE_SCALE;
        continue;
      }
      state = PINK_POLE * state + PINK_FEED * w;
      data[i] = state * PINK_SCALE;
    }
    channels.push(data);
  }
  return channels;
}

/**
 * `thunder()`'s buffer body: `a[i] = clamp(crack + rumble, -1, 1)`, stereo, seven seconds.
 *
 * `let low = 0` resets per channel and the generator is shared across both, so the left channel
 * ends its stream exactly where the right channel starts it. The tremolo's `+ c` term is what
 * decorrelates the channels here; nothing else in the buffer does.
 */
export function thunderBody({ sampleRate, rng }) {
  const n = Math.floor(THUNDER_SECONDS * sampleRate);
  const channels = [];
  for (let c = 0; c < 2; c += 1) {
    const data = new Float64Array(n);
    let low = 0;
    for (let i = 0; i < n; i += 1) {
      const t = i / sampleRate;
      const white = rng() * 2 - 1;
      low = BROWN_POLE * low + BROWN_FEED * white;
      const crack = Math.exp(-t * CRACK_DECAY) * white * CRACK_LEVEL;
      const rumble =
        low *
        BROWN_SCALE *
        (1 - Math.exp(-t * RUMBLE_ATTACK)) *
        Math.exp(-t * RUMBLE_DECAY) *
        (TREMOLO_FLOOR + TREMOLO_DEPTH * Math.sin(t * TREMOLO_RATE + c));
      const mixed = crack + rumble;
      data[i] = mixed > 1 ? 1 : mixed < -1 ? -1 : mixed;
    }
    channels.push(data);
  }
  return channels;
}
