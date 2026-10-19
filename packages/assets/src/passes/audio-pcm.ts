import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";
import { createOggEncoder } from "wasm-media-encoders";

/**
 * Decoding and encoding for the audio pass, in-process through WASM.
 *
 * Both codecs are WASM builds resolved from this package's own dependencies, for the same reason
 * `texture.ts` encodes KTX2 through `ktx2-encoder` rather than shelling out to a tool: users
 * install nothing extra, and a byte transform that has to be reproducible in CI cannot depend on
 * whichever `ffmpeg` a build host happens to carry.
 *
 * **Ogg Vorbis is forced, not preferred.** `packages/runtime-native`'s `decodeAudioFile`
 * implements exactly RIFF/WAVE and Ogg Vorbis, compiled into desktop, Android and iOS alike, so
 * an MP3 asset is silent on every native target — a black-screen-class bug that
 * `asset-preflight.mjs` already refuses to package. Vorbis is roughly a tenth of WAV's size and is
 * what the browser half of the same source already plays, so one file serves both halves.
 */

/** Interleaved-free PCM: one Float32Array per channel, all the same length. */
export interface IDecodedAudio {
  readonly channels: readonly Float32Array[];
  readonly frames: number;
  readonly sampleRate: number;
  /** What the bytes turned out to be, read from the header rather than the extension. */
  readonly container: AudioContainer;
}

export type AudioContainer = "Ogg Vorbis" | "RIFF/WAVE";

/**
 * What the file *is*, read from its bytes.
 *
 * Deliberately a copy of the sniff in `packages/runtime-native/scripts/asset-preflight.mjs` rather
 * than an import of it: a published `@threenative/assets` tarball carries no runtime-native
 * sources, so importing across would break the package for every consumer. What keeps the copy
 * honest is `audio-native-contract.spec.ts`, which reads both and fails when they disagree — the
 * same two-halves-must-agree discipline `audio-decode-ogg.test.mjs` applies to the decoder itself.
 *
 * Ogg is a container, not a codec: the same `OggS` magic carries Vorbis, Opus and FLAC, and the
 * runtime decodes Vorbis alone. A magic-number match would wave an Opus file straight through.
 */
export function sniffAudioContainer(bytes: Buffer): string {
  const ascii = asciiMatcher(bytes);
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "RIFF/WAVE";
  if (ascii(0, "OggS")) return oggCodec(bytes);
  if (ascii(0, "ID3")) return "MP3 (ID3)";
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] as number) & 0xe0) === 0xe0)
    return "MP3";
  if (ascii(0, "fLaC")) return "FLAC";
  if (ascii(4, "ftyp")) return "MP4/M4A";
  return "an unknown format";
}

function asciiMatcher(bytes: Buffer): (offset: number, text: string) => boolean {
  return (offset, text) => {
    if (bytes.length < offset + text.length) return false;
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  };
}

/**
 * Which codec an Ogg stream carries, from the identifier in its first packet.
 *
 * The identifier sits after the 27-byte page header and its one-entry segment table, which is why
 * these offsets are 28 and 29 rather than anything derived.
 */
function oggCodec(bytes: Buffer): string {
  const ascii = asciiMatcher(bytes);
  if (bytes[28] === 0x01 && ascii(29, "vorbis")) return "Ogg Vorbis";
  if (ascii(28, "OpusHead")) return "Ogg Opus";
  if (bytes[28] === 0x7f && ascii(29, "FLAC")) return "Ogg FLAC";
  return "Ogg (unknown codec)";
}

/** The containers this pass reads, which are exactly the containers every native target decodes. */
export const DECODABLE_CONTAINERS: readonly AudioContainer[] = ["Ogg Vorbis", "RIFF/WAVE"];

export async function decodeAudioBytes(bytes: Buffer, logicalPath: string): Promise<IDecodedAudio> {
  const container = sniffAudioContainer(bytes);
  if (container === "RIFF/WAVE") return decodeWave(bytes, logicalPath);
  if (container === "Ogg Vorbis") return decodeVorbis(bytes, logicalPath);
  throw new Error(
    `TN_ASSETS_AUDIO_UNDECODABLE: '${logicalPath}' is ${container}; the audio pass reads ${DECODABLE_CONTAINERS.join(" and ")}, which is exactly what every native target decodes, so this source would be silent on desktop, Android and iOS. Re-encode it: ffmpeg -y -i "${logicalPath}" -c:a libvorbis -ar 44100 "${logicalPath.replace(/\.[^.]*$/u, "")}.ogg"`,
  );
}

async function decodeVorbis(bytes: Buffer, logicalPath: string): Promise<IDecodedAudio> {
  const decoder = new OggVorbisDecoder();
  await decoder.ready;
  try {
    const decoded = await decoder.decodeFile(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    // Fail closed on a decode error rather than conditioning a clip with holes in it and
    // reporting measurements taken across the gaps.
    if (decoded.errors.length > 0) {
      throw new Error(
        `TN_ASSETS_AUDIO_DECODE_FAILED: '${logicalPath}' decoded with ${decoded.errors.length} error(s), the first being ${decoded.errors[0]?.message ?? "unknown"}.`,
      );
    }
    if (decoded.samplesDecoded <= 0 || decoded.channelData.length === 0) {
      throw new Error(`TN_ASSETS_AUDIO_EMPTY: '${logicalPath}' decoded to no samples.`);
    }
    return {
      channels: decoded.channelData.map((channel) => channel.subarray(0, decoded.samplesDecoded)),
      container: "Ogg Vorbis",
      frames: decoded.samplesDecoded,
      sampleRate: decoded.sampleRate,
    };
  } finally {
    decoder.free();
  }
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * A RIFF/WAVE reader over the chunk table, not over a fixed 44-byte header.
 *
 * Real authoring tools write `LIST`, `fact` and `cue ` chunks before `data`, and a reader that
 * assumes the canonical layout treats their bytes as samples — a loud burst of noise at the head
 * of the clip that every measurement here would then be taken across.
 */
function decodeWave(bytes: Buffer, logicalPath: string): IDecodedAudio {
  const fail = (reason: string): never => {
    throw new Error(`TN_ASSETS_AUDIO_MALFORMED: '${logicalPath}' is not a readable WAV: ${reason}`);
  };
  if (bytes.length < 12) return fail("the 12-byte RIFF header is truncated");
  const walked = walkWaveChunks(bytes);
  if (typeof walked === "string") return fail(walked);
  const { bitsPerSample, channelCount, data, format, sampleRate } = walked;
  if (channelCount <= 0) return fail("the fmt chunk declares no channels");
  if (sampleRate <= 0) return fail("the fmt chunk declares no sample rate");
  const readSample = sampleReaderFor(format, bitsPerSample);
  if (readSample === undefined) {
    return fail(
      `format ${String(format)} at ${String(bitsPerSample)} bits is not PCM or IEEE float this pass reads`,
    );
  }
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channelCount * bytesPerSample;
  const frames = Math.floor(data.length / blockAlign);
  if (frames <= 0) return fail("the data chunk holds no whole frames");
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      (channels[channel] as Float32Array)[frame] = readSample(
        data,
        frame * blockAlign + channel * bytesPerSample,
      );
    }
  }
  return { channels, container: "RIFF/WAVE", frames, sampleRate };
}

interface IWaveChunks {
  readonly bitsPerSample: number;
  readonly channelCount: number;
  readonly data: Buffer;
  readonly format: number;
  readonly sampleRate: number;
}

interface IWaveChunk {
  readonly id: string;
  readonly size: number;
  readonly start: number;
}

/** Every chunk header in the table, in order, each padded to an even boundary as RIFF requires. */
function* waveChunks(bytes: Buffer): Generator<IWaveChunk> {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    yield { id: bytes.toString("ascii", offset, offset + 4), size, start };
    offset = start + size + (size % 2);
  }
}

/** The `fmt ` and `data` chunks, or the reason the table could not be read. */
function walkWaveChunks(bytes: Buffer): IWaveChunks | string {
  const found = new Map<string, IWaveChunk>();
  for (const chunk of waveChunks(bytes)) {
    if (chunk.start + chunk.size > bytes.length && chunk.id !== "data") {
      return `chunk '${chunk.id}' is truncated`;
    }
    // First of a kind wins: a file with two `fmt ` chunks is malformed, and reading the first is
    // the only choice that cannot end up describing one chunk's samples with another's rate.
    if (!found.has(chunk.id)) found.set(chunk.id, chunk);
  }
  const format = found.get("fmt ");
  const data = found.get("data");
  if (format === undefined) return "it has no fmt chunk";
  if (data === undefined) return "it has no data chunk";
  if (format.size < 16) return "the fmt chunk is shorter than 16 bytes";
  return {
    bitsPerSample: bytes.readUInt16LE(format.start + 14),
    channelCount: bytes.readUInt16LE(format.start + 2),
    data: waveData(bytes, data),
    format: readFormatTag(bytes, format.start, format.size),
    sampleRate: bytes.readUInt32LE(format.start + 4),
  };
}

/** A streamed WAV can declare size 0 or 0xffffffff, in which case the rest of the file is data. */
function waveData(bytes: Buffer, chunk: IWaveChunk): Buffer {
  const overruns = chunk.size === 0 || chunk.start + chunk.size > bytes.length;
  return bytes.subarray(chunk.start, overruns ? undefined : chunk.start + chunk.size);
}

/** The real format tag: for an extensible file it is the head of the sub-format GUID. */
function readFormatTag(bytes: Buffer, start: number, size: number): number {
  const tag = bytes.readUInt16LE(start);
  return tag === WAVE_FORMAT_EXTENSIBLE && size >= 40 ? bytes.readUInt16LE(start + 24) : tag;
}

type SampleReader = (data: Buffer, at: number) => number;

function sampleReaderFor(format: number, bits: number): SampleReader | undefined {
  if (format === WAVE_FORMAT_FLOAT && bits === 32) return (data, at) => data.readFloatLE(at);
  if (format === WAVE_FORMAT_FLOAT && bits === 64) return (data, at) => data.readDoubleLE(at);
  if (format !== WAVE_FORMAT_PCM) return undefined;
  // 8-bit WAV is unsigned by definition; every wider PCM width is signed.
  if (bits === 8) return (data, at) => (data.readUInt8(at) - 128) / 128;
  if (bits === 16) return (data, at) => data.readInt16LE(at) / 32_768;
  if (bits === 24) return (data, at) => data.readIntLE(at, 3) / 8_388_608;
  if (bits === 32) return (data, at) => data.readInt32LE(at) / 2_147_483_648;
  return undefined;
}

/**
 * Encodes PCM to Ogg Vorbis with a serial number derived from the asset's own path.
 *
 * The serial number identifies a logical bitstream and every encoder picks it at random by
 * default. Left alone it puts fresh bytes in the output on every build: the manifest's byte counts
 * move, `sameEntry` never matches, and this repository's way of proving a change neutral — diffing
 * emitted output — reports every build as dirty. Deriving it from the logical path keeps it stable
 * across builds and distinct across assets.
 */
export async function encodeVorbis(
  channels: readonly Float32Array[],
  sampleRate: number,
  quality: number,
  logicalPath: string,
): Promise<Buffer> {
  if (channels.length !== 1 && channels.length !== 2) {
    throw new Error(
      `TN_ASSETS_AUDIO_CHANNELS: '${logicalPath}' reached the encoder with ${String(channels.length)} channel(s); Vorbis encoding here handles mono and stereo.`,
    );
  }
  const encoder = await createOggEncoder();
  encoder.configure({
    channels: channels.length,
    oggSerialNo: serialFor(logicalPath),
    sampleRate,
    vbrQuality: quality,
  });
  const chunks: Uint8Array[] = [];
  const block = 4096;
  const frames = channels[0]?.length ?? 0;
  for (let offset = 0; offset < frames; offset += block) {
    const end = Math.min(offset + block, frames);
    // `encode` returns a view the encoder still owns and reuses, so every chunk is copied out.
    chunks.push(Uint8Array.from(encoder.encode(channels.map((c) => c.subarray(offset, end)))));
  }
  chunks.push(Uint8Array.from(encoder.finalize()));
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/** A stable positive 31-bit serial from the logical path; collisions across a bake are harmless. */
function serialFor(logicalPath: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < logicalPath.length; index += 1) {
    hash ^= logicalPath.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 1 || 1;
}
