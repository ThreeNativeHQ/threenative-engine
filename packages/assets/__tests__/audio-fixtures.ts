import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { type IAssetSourceConfig, compileAssets } from "../src/index.js";
import { type ISeamMeasurement, measureSeam } from "../src/passes/audio-dsp.js";
import { decodeAudioBytes } from "../src/passes/audio-pcm.js";

/**
 * Audio fixtures written as RIFF/WAVE rather than encoded to Ogg.
 *
 * A WAV source hands the pass the exact PCM the test asked for, so an assertion about a seam or a
 * peak is about the pass and not about what a Vorbis round trip did to the input on the way in.
 * The output side is still a real encode, which is where the codec noise belongs.
 */
export interface IWavClipOptions {
  readonly bitsPerSample?: 8 | 16 | 24 | 32;
  readonly channels?: number;
  readonly float?: boolean;
  readonly frames: number;
  readonly sampleRate?: number;
  /** Sample value in [-1, 1] for frame `frame` of channel `channel`. */
  readonly sample: (frame: number, channel: number) => number;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;

export function wavClip(options: IWavClipOptions): Buffer {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 44_100;
  const float = options.float ?? false;
  const bits = float ? 32 : (options.bitsPerSample ?? 16);
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = options.frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(float ? FORMAT_FLOAT : FORMAT_PCM, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < options.frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const at = 44 + frame * blockAlign + channel * bytesPerSample;
      writeSample(buffer, at, options.sample(frame, channel), bits, float);
    }
  }
  return buffer;
}

function writeSample(
  buffer: Buffer,
  at: number,
  value: number,
  bits: number,
  float: boolean,
): void {
  // Float32 WAV is not clamped: values above 1.0 are the headroom a Float32 source can hold, and a
  // fixture that silently clipped them would make that unrepresentable in any test.
  if (float) {
    buffer.writeFloatLE(value, at);
    return;
  }
  const clamped = Math.max(-1, Math.min(1, value));
  if (bits === 8) {
    buffer.writeUInt8(Math.round(clamped * 127) + 128, at);
    return;
  }
  if (bits === 16) {
    buffer.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(clamped * 32_767))), at);
    return;
  }
  if (bits === 24) {
    buffer.writeIntLE(
      Math.max(-8_388_608, Math.min(8_388_607, Math.round(clamped * 8_388_607))),
      at,
      3,
    );
    return;
  }
  buffer.writeInt32LE(
    Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(clamped * 2_147_483_647))),
    at,
  );
}

/** Deterministic broadband material: a real encode subject, and the same one on every run. */
export function noise(seed: number): (frame: number, channel: number) => number {
  let state = seed >>> 0;
  const values: number[] = [];
  return (frame, channel) => {
    const index = frame * 8 + channel;
    while (values.length <= index) {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      values.push((state / 0xff_ff_ff_ff) * 1.4 - 0.7);
    }
    return values[index] as number;
  };
}

/**
 * Band-limited noise: what an ambience bed actually is, and what white noise is not.
 *
 * A splice-aligned cross-fade leaves a wrap step equal to the source's own adjacent-sample delta at
 * the splice, so material with no correlation between neighbouring samples has no quiet splice to
 * find. Real beds are band-limited and cross zero constantly — the three this pass was built
 * against have median adjacent steps of 0.0014 to 0.09 — so a test that wants a small wrap step
 * has to hand the pass material of that kind rather than a per-sample coin flip.
 *
 * Note that white noise still *passes* the seam gate, because its wrap is a typical step for that
 * clip and therefore inaudible as a click; what it cannot produce is a small step. The two
 * fixtures separate those two things.
 */
export function bandLimitedNoise(
  seed: number,
  poles = 3,
): (frame: number, channel: number) => number {
  const white = noise(seed);
  const cache = new Map<number, number[]>();
  return (frame, channel) => {
    let series = cache.get(channel);
    if (series === undefined) {
      series = [];
      cache.set(channel, series);
    }
    while (series.length <= frame) {
      const index = series.length;
      let value = white(index, channel);
      // One-pole lowpasses in cascade, carrying their own state through the series built so far.
      for (let pole = 0; pole < poles; pole += 1) {
        const previous = index === 0 ? 0 : (series[index - 1] as number);
        value = previous + 0.3 * (value - previous);
      }
      series.push(value);
    }
    // The cascade costs amplitude; scaled back up so the clip is a real encode subject.
    return (series[frame] as number) * 6;
  };
}

export function sine(hz: number, sampleRate = 44_100, amplitude = 0.6) {
  return (frame: number): number => amplitude * Math.sin((2 * Math.PI * hz * frame) / sampleRate);
}

export interface ICompiledAudio {
  readonly entry: Record<string, unknown>;
  readonly outputBytes: Buffer;
  readonly root: string;
}

/** Compiles one audio source through the real driver and returns its entry and output bytes. */
export async function compileAudio(
  prefix: string,
  fileName: string,
  bytes: Buffer,
  config?: IAssetSourceConfig,
): Promise<ICompiledAudio> {
  const root = await makeTempDir(prefix);
  await mkdir(path.dirname(path.join(root, "assets", fileName)), { recursive: true });
  await writeFile(path.join(root, "assets", fileName), bytes);
  await compileAssets({ config: { textures: "none", models: "none", ...config }, cwd: root });
  const manifest = JSON.parse(
    await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
  ) as { entries: Record<string, Record<string, unknown> | undefined> };
  const entry = manifest.entries[fileName];
  if (entry === undefined) throw new Error(`no manifest entry for '${fileName}'`);
  return {
    entry,
    outputBytes: await readFile(path.join(root, "public", String(entry.output))),
    root,
  };
}

/**
 * The seam of the bytes on disk, measured independently of what the pass reported about them.
 *
 * A pass that measured its own output and then wrote a different file would pass its own tests;
 * this reads the emitted file back.
 */
export async function decodedSeam(bytes: Buffer): Promise<ISeamMeasurement> {
  const decoded = await decodeAudioBytes(bytes, "measured.ogg");
  return measureSeam(decoded.channels, decoded.sampleRate);
}
