// Bakes the racing kit's three clips into `assets/`, and proves them before it writes.
//
//   node tools/make-racing-audio.mjs            # write assets/*.wav and self-check them
//   node tools/make-racing-audio.mjs --check    # measure the committed clips, write nothing
//
// Why synthesised rather than recorded: an engine loop is pitched from 0.62× to 2.05× on the fly
// (`src/audio/engine.ts`), so it has to be a *tonal* loop with an exactly periodic seam — the one
// thing a recording of a real engine is not. The asset sources this kit can reach carry no engine,
// tyre or boost recording (the catalogue's curated packs are UI and jingles; the professional
// bundles are multi-gigabyte archives), so the sound is authored here, from maths, the way the snow
// and rain kits author theirs. Nothing is sampled from anyone, so `CREDITS.md` credits the tool.
//
// The bake is deterministic: one seeded generator, no clock, no environment, no arguments. It
// re-runs itself and compares hashes before it writes, so "two runs are byte-identical" is a
// measured fact rather than a hope.
//
// **The loops are exactly periodic, by construction rather than by cross-fade.** Every frequency in
// the engine bed is a whole number of cycles per second over a one-second loop, so sample 0 and
// sample N are the same point of the same waveform; the tyre squeal is band-limited noise run
// through its own filter over the *periodic* extension of the noise, so the filter's steady state
// is what lands in the file. The seam gate in `@threenative/assets`' audio pass then has something
// true to measure, instead of a hole papered over with a cross-fade.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 44100;
const CHANNELS = 1;
const BITS = 32;
const BYTES_PER_SAMPLE = BITS / 8;
const BLOCK_ALIGN = CHANNELS * BYTES_PER_SAMPLE;
const WAVE_FORMAT_IEEE_FLOAT = 3;

/** The seed every draw comes from. Changing it changes the files; it is not a tuning knob. */
const SEED = 0x5eed_c0de;

const CLIPS = {
  // Frames are whole samples, not seconds: 0.7 s is 30 869.999… samples in a double, and a clip
  // that is one frame short is a clip whose loop point is a frame off.
  engine: { file: "engine-loop.wav", frames: SAMPLE_RATE },
  squeal: { file: "tyre-squeal.wav", frames: SAMPLE_RATE * 1.5 },
  nitro: { file: "nitro-burst.wav", frames: (SAMPLE_RATE * 7) / 10 },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(here, "..", "assets");

// --- dsp ------------------------------------------------------------------------------------

/** The one generator. `mulberry32` so a run is a repeatable draw, not a nicer random. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RBJ cookbook biquad coefficients, as `@threenative/assets`' own audio pass computes them. */
function biquad(kind, hz, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * hz) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const norm = (value) => value / a0;
  const shared = { b1: norm(kind === "highpass" ? -2 * cos : 2 * cos), a1: norm(-2 * cos) };
  if (kind === "lowpass")
    return {
      b0: norm((1 - cos) / 2),
      b1: shared.b1,
      b2: norm((1 - cos) / 2),
      a1: shared.a1,
      a2: norm(1 - alpha),
    };
  return {
    b0: norm((1 + cos) / 2),
    b1: shared.b1,
    b2: norm((1 + cos) / 2),
    a1: shared.a1,
    a2: norm(1 - alpha),
  };
}

/**
 * A biquad over a **periodic** signal: `samples` is one period, and the filter is started
 * `preroll` samples before its first sample on the signal's own wrap-around tail.
 *
 * That is the whole trick behind a noise loop with no click. Cross-fading the end into the start
 * leaves a seam that is quieter but still a seam; running the filter's transient to completion on
 * the periodic extension means the waveform at sample 0 is the one at sample N, whatever the
 * filter is.
 */
function filterPeriodic(samples, coefficients, preroll = SAMPLE_RATE * 2) {
  const { b0, b1, b2, a1, a2 } = coefficients;
  const length = samples.length;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const step = (index) => {
    const x0 = samples[((index % length) + length) % length];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    return y0;
  };
  for (let index = -preroll; index < 0; index += 1) step(index);
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) out[index] = step(index);
  return out;
}

function encodeWav(samples) {
  const frames = samples.length;
  const dataBytes = frames * BLOCK_ALIGN;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(WAVE_FORMAT_IEEE_FLOAT, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * BLOCK_ALIGN, 28);
  buffer.writeUInt16LE(BLOCK_ALIGN, 32);
  buffer.writeUInt16LE(BITS, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < frames; index += 1)
    buffer.writeFloatLE(samples[index], 44 + index * BLOCK_ALIGN);
  return buffer;
}

// --- the three voices -----------------------------------------------------------------------

/**
 * The engine bed: a firing frequency and its harmonics, with the lope of a four-cylinder at idle.
 *
 * 42 Hz is the firing rate at playback rate 1.0 — about 1 300 rpm, where a small four-cylinder
 * sits — and the game's rate law takes it to 90 Hz at the rev limit. Forty harmonics rather than a
 * handful, because pitch-shifting a pure tone up 2× keeps it a pure tone while an exhaust keeps its
 * buzz; `1 / k ** 0.8` is bright enough to still be an engine two octaves up.
 */
function engineBody() {
  const length = CLIPS.engine.frames;
  const firingHz = 42;
  const harmonics = 40;
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const time = index / SAMPLE_RATE;
    let body = 0;
    for (let k = 1; k <= harmonics; k += 1) {
      // A fixed golden-angle phase spread: it keeps the partials from summing into one spike at
      // t = 0 in every period, which is what a naive all-zero-phase series does (it sounds like a
      // click 44 times a second).
      body += Math.sin(2 * Math.PI * k * firingHz * time + k * 2.399963229728653) / k ** 0.8;
    }
    // 11 Hz and 22 Hz are whole numbers of cycles in a one-second loop, so the lope wraps too.
    const lope = 0.74 + 0.26 * Math.sin(2 * Math.PI * 11 * time);
    const rumble = 0.3 * Math.sin(2 * Math.PI * 22 * time);
    out[index] = Math.tanh(1.5 * (0.42 * body * lope + rumble));
  }
  return normalise(out, 0.7);
}

/**
 * The tyre squeal: band-limited noise under a narrow tone with vibrato, at a slow swell.
 *
 * A sliding tyre is stick-slip, which is a squeal with a pitch in it rather than hiss. The noise
 * carries the grit (800..3400 Hz) and the tone carries the pitch (1 250 Hz, ±40 Hz at 2 Hz); the
 * vibrato is phase-integrated so it too wraps exactly at the loop point.
 */
function squealBody() {
  const length = CLIPS.squeal.frames;
  const seconds = length / SAMPLE_RATE;
  // Whole cycles per loop, or the modulation leaves a step at the wrap.
  const vibratoCycles = 3;
  const swellCycles = 2;
  const toneHz = 1250;
  const vibratoHz = 40;
  const rng = mulberry32(SEED);
  const noise = new Float32Array(length);
  for (let index = 0; index < length; index += 1) noise[index] = rng() * 2 - 1;
  const grit = filterPeriodic(filterPeriodic(noise, biquad("highpass", 800)), biquad("lowpass", 3400));
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const time = index / SAMPLE_RATE;
    const phase =
      2 * Math.PI * toneHz * time +
      (vibratoHz / (vibratoCycles / seconds)) *
        Math.cos(2 * Math.PI * (vibratoCycles / seconds) * time);
    const swell =
      0.78 + 0.22 * Math.sin(2 * Math.PI * (swellCycles / seconds) * time - Math.PI / 2);
    out[index] = swell * (0.8 * grit[index] * 1.6 + 0.22 * Math.sin(phase));
  }
  return normalise(out, 0.62);
}

/**
 * The nitro burst: a pressure wave falling away, with a hiss on top. One shot, so it is allowed
 * not to loop and is declared `loop: false` in `threenative.config.ts`.
 */
function nitroBody() {
  const length = CLIPS.nitro.frames;
  const rng = mulberry32(SEED ^ 0x9e37_79b9);
  const noise = new Float32Array(length);
  for (let index = 0; index < length; index += 1) noise[index] = rng() * 2 - 1;
  const hiss = filterPeriodic(noise, biquad("highpass", 900));
  const out = new Float32Array(length);
  let phase = 0;
  for (let index = 0; index < length; index += 1) {
    const time = index / SAMPLE_RATE;
    // 10 ms attack, exponential release: a valve opening and a tank emptying.
    const attack = Math.min(1, time / 0.01);
    const release = Math.exp(-time * 5.2);
    const sweepHz = 900 * Math.exp(-time * 3.4) + 120;
    phase += (2 * Math.PI * sweepHz) / SAMPLE_RATE;
    out[index] = attack * release * (0.55 * Math.sin(phase) + 0.5 * hiss[index] * 0.9);
  }
  return normalise(out, 0.66);
}

/** Scales a clip to a peak, so the mix law in `src/audio/engine.ts` is the only level control. */
function normalise(samples, peak) {
  let loudest = 0;
  for (const value of samples) loudest = Math.max(loudest, Math.abs(value));
  if (loudest === 0) throw new Error("TN_RACING_AUDIO_INVALID: a clip baked as silence.");
  const scale = peak / loudest;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= scale;
  return samples;
}

// --- the checks -----------------------------------------------------------------------------

function bake() {
  return {
    engine: engineBody(),
    nitro: nitroBody(),
    squeal: squealBody(),
  };
}

function fail(what) {
  throw new Error(`TN_RACING_AUDIO_INVALID: ${what}`);
}

function assert(what, condition) {
  if (!condition) fail(what);
}

/** Peak, RMS, and the count of samples that are not finite. */
function measure(samples) {
  let peak = 0;
  let sum = 0;
  let bad = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) bad += 1;
    else peak = Math.max(peak, Math.abs(value));
    sum += value * value;
  }
  return { bad, peak, rms: Math.sqrt(sum / samples.length) };
}

/**
 * The wrap step against the largest ordinary step near it — the ratio
 * `packages/assets/src/passes/audio.ts` fails a build on, computed the same way so this tool and
 * the cooker cannot disagree about whether a loop is clean.
 */
function seamRatio(samples) {
  const wrap = Math.abs(samples[0] - samples[samples.length - 1]);
  const steps = [];
  for (let index = 1; index < samples.length; index += 1)
    steps.push(Math.abs(samples[index] - samples[index - 1]));
  steps.sort((a, b) => a - b);
  const near = steps[Math.floor(steps.length * 0.99)];
  return near <= 0 ? (wrap <= 0 ? 0 : Number.POSITIVE_INFINITY) : wrap / near;
}

/**
 * The magnitude of one exact DFT bin, in Hz.
 *
 * A one-second loop has integer-Hz bins, so the engine's fundamental lands exactly on the bin it
 * is asked about. Autocorrelation is the wrong probe here: the bed's own 11 Hz lope is a quarter
 * of a cycle off at a one-period lag, and a genuine pitch then measures as noise.
 */
function bin(samples, hz) {
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const angle = (2 * Math.PI * hz * index) / SAMPLE_RATE;
    real += samples[index] * Math.cos(angle);
    imaginary += samples[index] * Math.sin(angle);
  }
  return Math.hypot(real, imaginary) / samples.length;
}

const LOOP_SLACK = 0.75;

function verify(clips) {
  for (const [name, clip] of Object.entries(CLIPS)) {
    const samples = clips[name];
    const stats = measure(samples);
    assert(`${name}: non-finite samples`, stats.bad === 0);
    assert(`${name}: silent`, stats.peak > 0.1);
    assert(`${name}: peak over full scale (${stats.peak.toFixed(3)})`, stats.peak <= 1);
    assert(`${name}: sample count`, samples.length === clip.frames);
    if (name === "nitro") continue;
    // The seam ratio is the gate the asset pass applies at cook time; it is measured here too, so
    // a bake that would fail a build fails before the file is written.
    const ratio = seamRatio(samples);
    assert(
      `${name}: seam step is ${ratio.toFixed(2)}× the local step, which the cook would reject`,
      ratio <= LOOP_SLACK,
    );
  }
  // The engine's pitch: one firing period is 1/44 s, and a bed with a body in it correlates with
  // itself there. Without this the file could be shaped noise and every other check would pass.
  // The bed's pitch: 42 Hz and its third harmonic stand well clear of the bins between them, which
  // is what "an engine and not shaped noise" means in the file rather than in the source.
  const fundamental = bin(clips.engine, 42);
  const between = (bin(clips.engine, 43) + bin(clips.engine, 62) + bin(clips.engine, 85)) / 3;
  assert(
    `engine: no 42 Hz body (bin ${fundamental.toFixed(4)} against ${between.toFixed(4)} between the partials)`,
    fundamental > between * 8,
  );
  assert(`engine: no third harmonic`, bin(clips.engine, 126) > between * 4);
}

/** The hash of a bake, taken from the samples rather than the bytes, so it is container-free. */
function digest(clips) {
  const hash = createHash("sha256");
  for (const name of Object.keys(CLIPS).sort()) {
    for (const value of clips[name]) hash.update(Float32Array.of(value));
  }
  return hash.digest("hex");
}

function report(clips) {
  const rows = Object.entries(CLIPS).map(([name, clip]) => {
    const stats = measure(clips[name]);
    return {
      clip: clip.file,
      seconds: Number((clip.frames / SAMPLE_RATE).toFixed(2)),
      peak: Number(stats.peak.toFixed(3)),
      rms: Number(stats.rms.toFixed(3)),
      seam: name === "nitro" ? "one shot" : seamRatio(clips[name]).toFixed(2),
    };
  });
  console.table(rows);
}

// --- main -----------------------------------------------------------------------------------

const checking = process.argv.includes("--check");
const clips = bake();
verify(clips);
const again = bake();
assert("the bake is not deterministic", digest(clips) === digest(again));

if (checking) {
  for (const [name, clip] of Object.entries(CLIPS)) {
    const committed = readFileSync(path.join(assetsDir, clip.file));
    assert(
      `${clip.file} is stale: run node tools/make-racing-audio.mjs`,
      Buffer.compare(committed, encodeWav(bake()[name])) === 0,
    );
  }
  report(clips);
  console.log("committed clips match the bake");
} else {
  for (const [name, clip] of Object.entries(CLIPS))
    writeFileSync(path.join(assetsDir, clip.file), encodeWav(clips[name]));
  report(clips);
  console.log(`baked ${Object.keys(CLIPS).length} clips into assets/ (sha256 ${digest(clips).slice(0, 16)})`);
}
