// Bakes the reference study's `StormAudio` into the committed clips `src/audio/storm.ts` plays.
//
//   node tools/make-storm-audio.mjs                    # write assets/*.wav and self-check them
//   node tools/make-storm-audio.mjs --verify <file>    # also prove the constants match that source
//
// The bake is deterministic: one seeded generator, no clock, no environment, no arguments. Two
// runs produce byte-identical files, and the self-check below is what makes that a fact rather
// than a hope — it re-runs the whole bake and compares hashes.
//
// `--verify` takes a copy of the reference study. It re-reads the constants out of that file and
// refuses to run if any of them has drifted from the transcription in `storm-dsp.mjs`, so this
// file cannot quietly stop being the source. It is optional only because the reference is not
// vendored into this repository.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOOPS,
  LOOP_SECONDS,
  STORM_SEED,
  THUNDER_SECONDS,
  biquad,
  filterLoop,
  loopBody,
  mulberry32,
  thunderBody,
} from "./storm-dsp.mjs";

/** Committed at 44.1 kHz stereo, float32 — see `encodeWav` for why not 16-bit. */
const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BITS = 32;
const BYTES_PER_SAMPLE = BITS / 8;
const BLOCK_ALIGN = CHANNELS * BYTES_PER_SAMPLE;
const WAVE_FORMAT_IEEE_FLOAT = 3;

const ASSETS = {
  rain: { file: "rain-loop.wav", label: "rain hiss" },
  wind: { file: "wind-loop.wav", label: "wind bed" },
  thunder: { file: "thunder.wav", label: "thunder" },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(here, "..", "assets");

function usage() {
  console.log("usage: node tools/make-storm-audio.mjs [--verify <tempest.html>]");
  process.exit(2);
}

/**
 * Minimal float32 RIFF/WAVE writer: `fmt ` then `data`, which is what `THREE.AudioLoader` parses
 * and what the asset compiler re-conditions on cook. No LIST or timestamp chunk, so the bytes
 * depend on the samples and nothing else.
 *
 * **Float32, not 16-bit PCM.** The source ran these bodies in a `Float32Array` AudioBuffer and
 * mixed them through gain nodes afterwards, so a loop is allowed to peak above full scale: wind is
 * `pink * 4`, and after its 35..350 Hz band the committed loop still peaks at 1.05, which the
 * source's own `.02 + wind * .18 *` node then brought down to at most .2. A 16-bit file cannot hold
 * that — 0.012% of its samples were pinned to ±1.0 and the loudest transient of the loop was
 * flattened into a clipped plateau. Every consumer of these files reads the format rather than
 * guessing it: `@threenative/assets`' decoder takes `format 3` at 32 bits as `readFloatLE`, the
 * native host's `SDL_LoadWAV_IO` path takes the `SDL_AUDIO_F32` branch, and `decodeAudioData`
 * scales only integer PCM.
 */
function encodeWav(channels) {
  const frames = channels[0].length;
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
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < CHANNELS; c += 1) {
      buffer.writeFloatLE(channels[c][i], offset);
      offset += 4;
    }
  }
  return buffer;
}

/** One seeded draw, so the three clips come out of one stream exactly as the source did. */
function bake() {
  const rng = mulberry32(STORM_SEED);
  const rain = loopBody({ band: LOOPS.rain, sampleRate: SAMPLE_RATE, rng });
  const wind = loopBody({ band: LOOPS.wind, sampleRate: SAMPLE_RATE, rng });
  const thunder = thunderBody({ sampleRate: SAMPLE_RATE, rng });
  // The source filtered live; the filter has to live in the file now. Same two biquads, same
  // frequencies, same Q.
  for (const [band, channels] of [
    [LOOPS.rain, rain],
    [LOOPS.wind, wind],
  ]) {
    const highpass = biquad("highpass", band.highpassHz, SAMPLE_RATE);
    const lowpass = biquad("lowpass", band.lowpassHz, SAMPLE_RATE);
    for (let c = 0; c < CHANNELS; c += 1)
      channels[c] = filterLoop(filterLoop(channels[c], highpass), lowpass);
  }
  return {
    rain: { bytes: encodeWav(rain), samples: rain },
    thunder: { bytes: encodeWav(thunder), samples: thunder },
    wind: { bytes: encodeWav(wind), samples: wind },
  };
}

// --- the checks -----------------------------------------------------------------------------

function fail(what) {
  throw new Error(`TN_STORM_AUDIO_INVALID: ${what}`);
}

function assert(what, condition) {
  if (!condition) fail(what);
}

/** Peak and RMS of one decoded channel, plus the NaN/infinity count. */
function measure(samples) {
  let peak = 0;
  let sum = 0;
  let bad = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) bad += 1;
    else if (Math.abs(value) > peak) peak = Math.abs(value);
    sum += value * value;
  }
  return { bad, peak, rms: Math.sqrt(sum / samples.length) };
}

/**
 * Normalised autocorrelation at one lag — the check that the baked filters are the source's bands
 * and not a name on a white-noise file.
 *
 * A signal with energy concentrated near `fs / lag` is correlated with itself there; white noise
 * is not. Wind is band-limited to 35..350 Hz, so at the 350 Hz period it correlates hard. Rain is
 * high-passed at 1800 Hz, so at the same lag it does not correlate at all.
 */
function autocorrelation(samples, lag) {
  let mean = 0;
  for (const value of samples) mean += value;
  mean /= samples.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i + lag < samples.length; i += 1) {
    const a = samples[i] - mean;
    const b = samples[i + lag] - mean;
    num += a * b;
    den += a * a;
  }
  return num / den;
}

/**
 * The wrap step of a loop against the largest ordinary step in its own neighbourhood — the ratio
 * `packages/assets/src/passes/audio.ts` fails a build on. `filterLoop` runs the steady-state
 * response of a periodic input, so this has to come out clean; if it does not, the bake is not
 * the source's filter and the loop clicks once per three seconds.
 */
function seamRatio(samples) {
  const wrap = Math.abs(samples[0] - samples[samples.length - 1]);
  const steps = [];
  for (let i = 1; i < samples.length; i += 1) steps.push(Math.abs(samples[i] - samples[i - 1]));
  steps.sort((a, b) => a - b);
  const near = steps[Math.floor(steps.length * 0.99)];
  return near <= 0 ? (wrap <= 0 ? 0 : Number.POSITIVE_INFINITY) : wrap / near;
}

/**
 * How much of the generated signal a float32 file is allowed to lose.
 *
 * Below half a ULP at 1.0, so a container that clamped or requantised the samples cannot pass it
 * by rounding: 16-bit would move a sample by up to 1.5e-5, and it fails here by two orders of
 * magnitude. It is a round-trip check, which is the strongest statement available about amplitude
 * — "no sample was altered" rather than "few samples were altered".
 */
const FLOAT32_TOLERANCE = 1e-7;

/**
 * The header the runtime's loader, the asset compiler and the native decoder all read, asserted
 * before the samples. The format tag is the check that matters: it is what a 16-bit re-encode
 * would silently change, and what the three decoders above branch on.
 */
function assertWavHeader(buffer) {
  assert("RIFF header", buffer.toString("ascii", 0, 4) === "RIFF");
  assert("WAVE header", buffer.toString("ascii", 8, 12) === "WAVE");
  assert("IEEE float format tag", buffer.readUInt16LE(20) === WAVE_FORMAT_IEEE_FLOAT);
  assert("channel count", buffer.readUInt16LE(22) === CHANNELS);
  assert("sample rate", buffer.readUInt32LE(24) === SAMPLE_RATE);
  assert("bit depth", buffer.readUInt16LE(34) === BITS);
}

/** One clip's own claims: right length, finite, unaltered, audible, and — for a loop — seamless. */
function checkClip(key, label, channels, source) {
  const seconds = channels[0].length / SAMPLE_RATE;
  const expected = key === "thunder" ? THUNDER_SECONDS : LOOP_SECONDS;
  assert(
    `${label}: duration is ${expected}s, got ${seconds.toFixed(4)}s`,
    Math.abs(seconds - expected) < 1e-9,
  );
  const rows = [];
  for (let c = 0; c < CHANNELS; c += 1) {
    const m = measure(channels[c]);
    assert(`${label} ch${c}: ${m.bad} non-finite samples`, m.bad === 0);
    assert(
      `${label} ch${c}: not silent (peak ${m.peak.toFixed(4)}, rms ${m.rms.toFixed(5)})`,
      m.rms > 0.001 && m.peak > 0.05,
    );
    let moved = 0;
    for (let i = 0; i < channels[c].length; i += 1)
      moved = Math.max(moved, Math.abs(channels[c][i] - source[c][i]));
    assert(
      `${label} ch${c}: the file moved a sample by ${moved.toExponential(2)}`,
      moved <= FLOAT32_TOLERANCE,
    );
    rows.push({ key, channel: c, peak: m.peak, rms: m.rms });
  }
  // The clip the 16-bit file could not hold. Wind's body is `pink * 4` and peaks above full scale,
  // because the source's own gain node is what brought the loop down to at most .2 — so a peak over
  // 1.0 in this file is the amplitude surviving, and a peak at or under it is a clip that lost the
  // top of its transient to a container.
  if (key === "wind") {
    const peak = measure(channels[0]).peak;
    assert(`${label}: the file holds its ${peak.toFixed(3)} peak, above full scale`, peak > 1);
  }
  if (key !== "thunder") {
    const wrap = seamRatio(channels[0]);
    assert(
      `${label}: loop seam ${wrap.toFixed(3)}x exceeds 1.5x the neighbourhood step`,
      wrap <= 1.5,
    );
    rows.push({ key, seam: wrap });
  }
  return rows;
}

/** Reads the written bytes back and checks the claims the runtime will rest on. */
function selfCheck(baked) {
  const decode = (bytes) => {
    assertWavHeader(bytes);
    const frames = bytes.readUInt32LE(40) / BLOCK_ALIGN;
    const channels = [];
    for (let c = 0; c < CHANNELS; c += 1) channels.push(new Float64Array(frames));
    for (let i = 0; i < frames; i += 1)
      for (let c = 0; c < CHANNELS; c += 1)
        channels[c][i] = bytes.readFloatLE(44 + (i * CHANNELS + c) * BYTES_PER_SAMPLE);
    return channels;
  };

  const results = [];
  const decoded = {};
  for (const [key, { label }] of Object.entries(ASSETS)) {
    const channels = decode(baked[key].bytes);
    decoded[key] = channels;
    results.push(...checkClip(key, label, channels, baked[key].samples));
  }

  // The filters, as heard: wind is correlated over its own band, rain is not correlated below its
  // high-pass corner. One lag, taken from a source constant — the period of rain's 1800 Hz corner.
  const lag = Math.round(SAMPLE_RATE / LOOPS.rain.highpassHz);
  const windAcf = autocorrelation(decoded.wind[0], lag);
  const rainAcf = autocorrelation(decoded.rain[0], lag);
  assert(
    `wind correlates over its 35..350 Hz band at lag ${lag} (${windAcf.toFixed(3)})`,
    windAcf > 0.5,
  );
  assert(
    `rain does not correlate below its ${LOOPS.rain.highpassHz} Hz corner at lag ${lag} (${rainAcf.toFixed(3)})`,
    Math.abs(rainAcf) < 0.1,
  );

  // The thunder envelope: a crack in the first tenth of a second and a decay of real dynamic range.
  const strike = decoded.thunder[0];
  const crackWindow = Math.floor(0.1 * SAMPLE_RATE);
  const tailWindow = Math.floor(0.5 * SAMPLE_RATE);
  let crackPeak = 0;
  for (let i = 0; i < crackWindow; i += 1) crackPeak = Math.max(crackPeak, Math.abs(strike[i]));
  let tail = 0;
  for (let i = strike.length - tailWindow; i < strike.length; i += 1) tail += strike[i] * strike[i];
  const tailRms = Math.sqrt(tail / tailWindow);
  const decayDb = 20 * Math.log10(crackPeak / Math.max(tailRms, 1e-9));
  assert(
    `thunder attack is inside the first 100 ms (peak ${crackPeak.toFixed(3)})`,
    crackPeak > 0.2,
  );
  assert(`thunder decays ${decayDb.toFixed(1)} dB into its tail`, decayDb > 20);
  // The 9 Hz tremolo is the only term that decorrelates the channels, so a near-identical pair
  // would mean it was dropped somewhere between the source and here.
  let cross = 0;
  let energy = 0;
  for (let i = 0; i < strike.length; i += 1) {
    cross += decoded.thunder[0][i] * decoded.thunder[1][i];
    energy += decoded.thunder[0][i] * decoded.thunder[0][i];
  }
  const stereo = cross / energy;
  assert(
    `thunder channels are decorrelated by the tremolo phase (r=${stereo.toFixed(3)})`,
    stereo < 0.2,
  );

  return { results, windAcf, rainAcf, decayDb, stereo, lag };
}

/**
 * Re-reads the reference study and refuses to bake if the transcription has drifted. Every check
 * is a literal that has to appear in the source; a missing file, an unreadable file or a renamed
 * constant all throw rather than quietly passing.
 */
function verifySource(file) {
  const source = readFileSync(file, "utf8");
  const required = [
    ["STORM_SEED", `rng(${STORM_SEED})`],
    ["LOOPS.rain.highpassHz", `makeLoop(${LOOPS.rain.highpassHz},${LOOPS.rain.lowpassHz},.09)`],
    ["LOOPS.wind.highpassHz", `makeLoop(${LOOPS.wind.highpassHz},${LOOPS.wind.lowpassHz},.05)`],
    ["LOOP_SECONDS", `createBuffer(2,ctx.sampleRate*${LOOP_SECONDS},ctx.sampleRate)`],
    ["THUNDER_SECONDS", `duration=${THUNDER_SECONDS}`],
    ["pink", "pink=.96*pink+.04*w"],
    ["white scale", "d[i]=low<100?pink*4:w*.6"],
    ["brown", "low=.985*low+n*.015"],
    ["crack", "Math.exp(-t*22)*n*.8"],
    ["rumble", "low*7*(1.-Math.exp(-t*4))*Math.exp(-t*.66)"],
    ["tremolo", "( .68+.32*Math.sin(t*9+c))"],
    ["rain gain", "this.rainGain.gain.setTargetAtTime(weather.rain*.20"],
    ["wind gain", ".02+weather.wind*.18*(.78+.22*Math.sin(time*.37))"],
    ["master", "this.master.gain.setTargetAtTime(.42,this.ctx.currentTime,.12)"],
    ["distance lowpass", "filter.frequency.value=clamp(4500-distance*5,280,4500)"],
    ["distance gain", "gain.gain.value=clamp(1.05-distance*.0009,.18,.95)"],
  ];
  for (const [name, literal] of required)
    if (!source.includes(literal)) fail(`source '${file}' no longer contains ${name} (${literal})`);
  return required.length;
}

// --- run -------------------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.some((a) => a === "--help" || a === "-h")) usage();
const verifyAt = args.indexOf("--verify");
if (verifyAt !== -1 && args[verifyAt + 1] === undefined) usage();
const verified = verifyAt === -1 ? null : verifySource(args[verifyAt + 1]);

const first = bake();
const second = bake();
for (const key of Object.keys(ASSETS)) {
  const a = createHash("sha256").update(first[key].bytes).digest("hex");
  const b = createHash("sha256").update(second[key].bytes).digest("hex");
  assert(`${ASSETS[key].label} is not reproducible across two bakes (${a} vs ${b})`, a === b);
}
const check = selfCheck(first);

for (const [key, { file, label }] of Object.entries(ASSETS)) {
  const bytes = first[key].bytes;
  writeFileSync(path.join(assetsDir, file), bytes);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  console.log(
    `${file}  ${label}  ${(bytes.length / 1024).toFixed(0)} KiB  float32  sha256:${hash}`,
  );
}
for (const row of check.results) {
  if (row.seam !== undefined)
    console.log(
      `  ${ASSETS[row.key].label}: loop seam ${row.seam.toFixed(3)}x the neighbourhood step`,
    );
  else
    console.log(
      `  ${ASSETS[row.key].label} ch${row.channel}: peak ${row.peak.toFixed(3)} rms ${row.rms.toFixed(4)}`,
    );
}
console.log(
  `self-check ok: wind acf@${check.lag} ${check.windAcf.toFixed(3)} (correlated), rain ${check.rainAcf.toFixed(3)} (not), thunder ${check.decayDb.toFixed(1)} dB decay at r=${check.stereo.toFixed(3)}, two bakes byte-identical`,
);
console.log(
  verified === null
    ? "note: constants unverified against the reference (pass --verify <tempest.html> to check)"
    : `verified ${verified} source literals against the reference`,
);
