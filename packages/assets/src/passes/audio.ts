import { type IAssetPass, type IAssetPassOutput, classify } from "../compile-types.js";
import type { IAudioRow } from "../report.js";
import {
  DEFAULT_CROSS_FADE_MS,
  DEFAULT_PEAK_DB,
  DEFAULT_QUALITY,
  DEFAULT_SEAM_MAX_RATIO,
  DEFAULT_SPLICE_TOLERANCE_MS,
  type IAudioLoopOptions,
  type IAudioPassOptions,
  type IAudioSpectrumExpectation,
} from "./audio-config.js";
import { AUDIO_BANDS } from "./audio-dsp.js";
import {
  type AudioBand,
  type ISeamMeasurement,
  crossFadeLoop,
  downmixToMono,
  measureBands,
  measureDcOffset,
  measurePeak,
  measureSeam,
  normalisePeak,
  removeDcOffset,
  spliceForQuietestSeam,
} from "./audio-dsp.js";
import { type IDecodedAudio, decodeAudioBytes, encodeVorbis } from "./audio-pcm.js";
import { globMatch } from "./glob.js";

/**
 * Conditions a game's audio at build time and proves it did not destroy it.
 *
 * `AssetKind` has classified `.ogg`, `.wav` and `.mp3` as audio since the pipeline was written and
 * nothing acted on it: audio was classified and then shipped through untouched. A lane generated
 * nineteen clips for a game and conditioned them in a one-off script instead — downmix, cross-fade,
 * DC removal, peak, encode — and the script reported success on every one while having measured
 * nothing at all.
 *
 * What it actually got wrong was **content**, not joins: a chime that came back 92% low-mid with
 * nothing above 1 kHz, and footsteps carrying heavy sub-bass. The joins were fine — an early
 * reading that one bed was clicking came from comparing bare wrap steps between clips, and by the
 * measurement that reflects audibility that bed has the *cleaner* join of the two. That correction
 * is why the seam gate here judges a ratio and not a magnitude, and why the declared-band check
 * exists at all: the defect that shipped was the one nobody thought to measure.
 *
 * So this is `model.ts`'s shape rather than a filter chain: it transforms bytes and then measures
 * the result, and every measurement it takes is reported whether or not it was asked to assert on
 * it. Turning a convention off must not turn its measurement off — an undeclared clip's seam is
 * measured and lands in the receipt, it just does not fail the build.
 *
 * What it deliberately does not do:
 *
 * - **Own the mix.** Peak handling defaults to a *ceiling*, which only ever attenuates. Normalising
 *   every clip up to the same peak would make a footstep as loud as a chime and force the game to
 *   undo the pipeline in its volume settings; that is deciding how the game sounds, and it belongs
 *   to the game. `normalise: "peak"` asks for the lift by name.
 * - **Guess intent.** See `audio-config.ts`.
 * - **Process at runtime.** Every measurement and every transform here happens once, at build time.
 */
export function audioPass(options: IAudioPassOptions = {}): IAssetPass {
  return {
    appliesTo: ["audio"],
    configuration: {
      normalise: options.normalise ?? "ceiling",
      overrides: options.overrides ?? [],
      peakDb: options.peakDb ?? DEFAULT_PEAK_DB,
      quality: options.quality ?? DEFAULT_QUALITY,
      seamMaxRatio: options.seamMaxRatio ?? DEFAULT_SEAM_MAX_RATIO,
    },
    apply: async (input: Buffer, logicalPath: string): Promise<Buffer | IAssetPassOutput> => {
      if (classify(logicalPath) !== "audio") return input;
      return await condition(input, logicalPath, resolve(logicalPath, options));
    },
    name: "audio",
  };
}

/** Every setting for one asset, after the first matching override won. */
interface IResolved {
  readonly conditioned: boolean;
  readonly crossFadeMs: number;
  readonly loop: boolean;
  readonly normalise: "ceiling" | "peak";
  readonly peakCeiling: number;
  readonly positional: boolean;
  readonly quality: number;
  readonly seamMaxRatio: number;
  readonly spectrum: IAudioSpectrumExpectation | undefined;
  readonly spliceToleranceMs: number;
}

function resolve(logicalPath: string, options: IAudioPassOptions): IResolved {
  const override = (options.overrides ?? []).find((candidate) =>
    globMatch(candidate.glob, logicalPath),
  );
  const loopDeclaration: boolean | IAudioLoopOptions | undefined = override?.loop;
  const loopOptions = typeof loopDeclaration === "object" ? loopDeclaration : {};
  const peakDb = override?.peakDb ?? options.peakDb ?? DEFAULT_PEAK_DB;
  return {
    conditioned: override?.conditioning !== "none",
    crossFadeMs: loopOptions.crossFadeMs ?? DEFAULT_CROSS_FADE_MS,
    loop: loopDeclaration !== undefined && loopDeclaration !== false,
    normalise: override?.normalise ?? options.normalise ?? "ceiling",
    peakCeiling: 10 ** (peakDb / 20),
    positional: override?.positional === true,
    quality: override?.quality ?? options.quality ?? DEFAULT_QUALITY,
    seamMaxRatio: override?.seamMaxRatio ?? options.seamMaxRatio ?? DEFAULT_SEAM_MAX_RATIO,
    spectrum: override?.spectrum,
    spliceToleranceMs: loopOptions.spliceToleranceMs ?? DEFAULT_SPLICE_TOLERANCE_MS,
  };
}

/** One Vorbis block: the most the encoder's own framing may move the frame count. */
const FRAME_DRIFT_TOLERANCE = 1024;

async function condition(
  input: Buffer,
  logicalPath: string,
  declared: IResolved,
): Promise<IAssetPassOutput> {
  // Decoded before anything else, so a container no native target reads fails the bake here —
  // naming the file while it is still cheap — instead of at package time or, worse, as silence
  // on a player's device. This is the throw an `.mp3` in the source tree gets.
  const source = await decodeAudioBytes(input, logicalPath);
  const before = {
    channels: source.channels.length,
    dcOffset: measureDcOffset(source.channels),
    peak: measurePeak(source.channels),
    seam: measureSeam(source.channels, source.sampleRate),
  };

  const produced = declared.conditioned
    ? await transform(input, source, logicalPath, declared)
    : { bytes: input, crossFadeFrames: 0, decoded: source, reencoded: false };
  const after = produced.decoded;

  assertNoDrift(logicalPath, source, after, produced.crossFadeFrames);
  const seam = measureSeam(after.channels, after.sampleRate);
  assertSeam(logicalPath, declared, seam, produced.crossFadeFrames, after.sampleRate);
  // Measured on every clip, declared or not: the band profile is the thing the hand-written script
  // never looked at, and a number in the receipt costs nothing.
  const bands = measureBands(after.channels, after.sampleRate);
  assertSpectrum(logicalPath, declared.spectrum, bands);

  const row: IAudioRow = {
    bytesAfter: produced.bytes.length,
    bytesBefore: input.length,
    channelsAfter: after.channels.length,
    channelsBefore: before.channels,
    conditioned: declared.conditioned,
    container: after.container,
    reencoded: produced.reencoded,
    ...(declared.loop && produced.crossFadeFrames > 0
      ? {
          crossFadeMs: (produced.crossFadeFrames / after.sampleRate) * 1000,
          crossFadeMsRequested: declared.crossFadeMs,
        }
      : declared.loop
        ? { crossFadeMs: 0, crossFadeMsRequested: declared.crossFadeMs }
        : {}),
    dcOffsetAfter: measureDcOffset(after.channels),
    dcOffsetBefore: before.dcOffset,
    // What the device's memory pays, which is the larger of the two costs and the reason a
    // positional clip is worth downmixing: a 21-second stereo bed is 220 KB on the wire and
    // 7.5 MB decoded.
    decodedBytesAfter: after.frames * after.channels.length * 4,
    decodedBytesBefore: source.frames * before.channels * 4,
    durationSeconds: after.frames / after.sampleRate,
    frames: after.frames,
    logicalPath,
    loop: declared.loop,
    peakAfter: measurePeak(after.channels),
    peakBefore: before.peak,
    sampleRate: after.sampleRate,
    seamNearP99: seam.nearP99,
    seamRatio: seam.ratio,
    seamRatioBefore: before.seam.ratio,
    seamWrap: seam.wrap,
    seamWrapBefore: before.seam.wrap,
    ...(declared.loop ? { seamMaxRatio: declared.seamMaxRatio } : {}),
    bandAir: bands.air,
    bandHigh: bands.high,
    bandLow: bands.low,
    bandMid: bands.mid,
    bandSub: bands.sub,
    ...(declared.spectrum === undefined
      ? {}
      : {
          spectrumBand: declared.spectrum.band,
          spectrumPercent: bands[declared.spectrum.band],
          ...(declared.spectrum.maxPercent === undefined
            ? {}
            : { spectrumMaxPercent: declared.spectrum.maxPercent }),
          ...(declared.spectrum.minPercent === undefined
            ? {}
            : { spectrumMinPercent: declared.spectrum.minPercent }),
        }),
  };
  // The extension follows the bytes, not the intent: a clip the game declared unconditioned keeps
  // its own container, and naming WAV bytes `.ogg` would put a lie in the manifest next to a
  // `container` field that said otherwise.
  return {
    buffer: produced.bytes,
    entry: { audio: row },
    outputExtension: after.container === "RIFF/WAVE" ? ".wav" : ".ogg",
  };
}

interface IProduced {
  readonly bytes: Buffer;
  readonly crossFadeFrames: number;
  readonly decoded: IDecodedAudio;
  /** False when the source bytes were shipped as they came, because nothing moved the PCM. */
  readonly reencoded: boolean;
}

/**
 * Enough DC to waste headroom and thump on a wrap. Below it, removing the offset would move the
 * samples by less than the encoder's own noise and buy a whole generation of Vorbis loss for it.
 * The same line the audio inspector draws before it says a word about DC.
 */
const DC_WORTH_REMOVING = 0.01;
/**
 * How far off the ceiling a peak may sit before the pass touches the gain, as a linear factor for
 * half a decibel.
 *
 * Without it the ceiling is not idempotent: a clip attenuated to exactly -1 dBFS comes back from
 * the Vorbis round trip a shade *over* it, so the next build attenuates again, re-encodes again,
 * and every rebuild costs another generation. Half a decibel is comfortably more than the codec's
 * overshoot and far less than any level difference a person would set on purpose.
 */
const GAIN_TOLERANCE = 10 ** (0.5 / 20);

async function transform(
  input: Buffer,
  source: IDecodedAudio,
  logicalPath: string,
  declared: IResolved,
): Promise<IProduced> {
  let pcm: readonly Float32Array[] = declared.positional
    ? downmixToMono(source.channels)
    : source.channels;
  if (pcm.length > 2) {
    throw new Error(
      `TN_ASSETS_AUDIO_CHANNELS: '${logicalPath}' has ${String(pcm.length)} channels, and a surround downmix is a mix decision this pass will not make for a game. Declare it positional to fold it to mono, or supply a mono or stereo source.`,
    );
  }
  let changed = declared.positional && source.channels.length > 1;
  let crossFadeFrames = 0;
  if (declared.loop && declared.crossFadeMs > 0) {
    const requested = Math.round((declared.crossFadeMs / 1000) * source.sampleRate);
    if (requested * 2 >= source.frames) {
      throw new Error(
        `TN_ASSETS_AUDIO_FADE_TOO_LONG: '${logicalPath}' is ${(source.frames / source.sampleRate).toFixed(3)} s and the declared ${String(declared.crossFadeMs)} ms cross-fade would consume at least half of it. Declare a shorter crossFadeMs, or 0 to keep the clip's own length.`,
      );
    }
    const splice = spliceForQuietestSeam(
      pcm,
      requested,
      Math.round((declared.spliceToleranceMs / 1000) * source.sampleRate),
    );
    pcm = crossFadeLoop(pcm, splice.fadeFrames);
    crossFadeFrames = splice.fadeFrames;
    changed = true;
  }
  if (Math.abs(measureDcOffset(pcm)) > DC_WORTH_REMOVING) {
    pcm = removeDcOffset(pcm);
    changed = true;
  }
  const peak = measurePeak(pcm);
  // A ceiling attenuates and never lifts, so the relative loudness the game authored survives
  // the pipeline; "peak" is the game asking for the lift by name. Either way the gain only moves
  // when the peak is more than a tolerance off the ceiling, so a rebuild of an already-conditioned
  // clip is a no-op rather than another generation of loss.
  const tooLoud = peak > declared.peakCeiling * GAIN_TOLERANCE;
  const tooQuiet = declared.normalise === "peak" && peak < declared.peakCeiling / GAIN_TOLERANCE;
  if (peak > 0 && (tooLoud || tooQuiet)) {
    pcm = normalisePeak(pcm, declared.peakCeiling);
    changed = true;
  }
  // A source that is already the right container and that nothing here moved is shipped as it
  // came. Re-encoding it would cost a generation of lossy Vorbis and roughly 4% more bytes to
  // deliver the identical audio — measured across wildwood's sixteen footsteps, where the only
  // thing "conditioning" had to do was leave them alone.
  if (!changed && source.container === "Ogg Vorbis") {
    return { bytes: input, crossFadeFrames, decoded: source, reencoded: false };
  }
  const bytes = await encodeVorbis(pcm, source.sampleRate, declared.quality, logicalPath);
  return {
    bytes,
    crossFadeFrames,
    decoded: await decodeAudioBytes(bytes, logicalPath),
    reencoded: true,
  };
}

/**
 * The transform is allowed to change the audio; it is not allowed to lose it.
 *
 * `model.ts` verifies triangles, vertices, joints, clips and bounds against the source and throws
 * `TN_ASSETS_MODEL_DRIFT` rather than trusting that a chain of optimizers behaved. The audio
 * equivalents are the sample rate, the channel count and the frame count: a resample, a dropped
 * channel or a truncated tail are all silent in a byte count and loud in a game.
 */
function assertNoDrift(
  logicalPath: string,
  source: IDecodedAudio,
  output: IDecodedAudio,
  crossFadeFrames: number,
): void {
  if (output.sampleRate !== source.sampleRate) {
    throw new Error(
      `TN_ASSETS_AUDIO_DRIFT: '${logicalPath}' came back at ${String(output.sampleRate)} Hz from a ${String(source.sampleRate)} Hz source; the pass does not resample, so this is a codec fault and the clip would play at the wrong pitch.`,
    );
  }
  const expectedFrames = source.frames - crossFadeFrames;
  if (Math.abs(output.frames - expectedFrames) > FRAME_DRIFT_TOLERANCE) {
    throw new Error(
      `TN_ASSETS_AUDIO_DRIFT: '${logicalPath}' came back ${String(output.frames)} frames against the ${String(expectedFrames)} expected (${String(source.frames)} source frames less a ${String(crossFadeFrames)}-frame cross-fade); more than ${String(FRAME_DRIFT_TOLERANCE)} frames of drift is lost audio, not encoder framing.`,
    );
  }
}

/**
 * The one assertion a game cannot declare away.
 *
 * A clip declared a forever-loop that clicks at every wrap is the defect this pass was built for,
 * and it shipped once already because the conditioning was a hand pass that reported nothing. So
 * there is no `seam: "none"`: `conditioning: "none"` still lands here, and `crossFadeMs: 0` — the
 * bar-accurate loop that cannot be shortened by a fade — still lands here. The bound can be moved,
 * because some material genuinely needs a different number, but only inside a range that keeps it
 * an assertion (`MIN_SEAM_MAX_RATIO`/`MAX_SEAM_MAX_RATIO`), and the value used is always reported.
 *
 * Measured on the decoded output bytes, never on the intermediate PCM: a cross-fade that is exact
 * in the PCM and undone by the encoder is still a click in the player's ears.
 */
function assertSeam(
  logicalPath: string,
  declared: IResolved,
  seam: ISeamMeasurement,
  crossFadeFrames: number,
  sampleRate: number,
): void {
  if (!declared.loop || seam.ratio <= declared.seamMaxRatio) return;
  throw new Error(
    `TN_ASSETS_AUDIO_SEAM: '${logicalPath}' loops with a wrap step of ${seam.wrap.toFixed(4)} against a neighbourhood whose largest ordinary step is ${seam.nearP99.toFixed(4)} — ${seam.ratio.toFixed(2)}x, which exceeds the ${String(declared.seamMaxRatio)}x this loop may ship with, and is an audible click on every cycle of something that repeats forever. ${seamRemedy(declared, crossFadeFrames, sampleRate)}`,
  );
}

/**
 * What to actually do about it, which depends on whether the pass was allowed to pick the join.
 *
 * Deliberately never suggests raising `seamMaxRatio` or walking `crossFadeMs` until the build goes
 * green. Both would make this message disappear without making the clip loop any better, and a
 * throwing gate people learn to tune around is worse than no gate — it teaches the habit and then
 * gets deleted. Letting the splice move is a different kind of change: it does not move the bar, it
 * lets the pass find a join that genuinely measures clean.
 */
function seamRemedy(declared: IResolved, crossFadeFrames: number, sampleRate: number): string {
  const dontTune =
    "Raising seamMaxRatio, or walking crossFadeMs until this passes, tunes the gate rather than the audio.";
  if (crossFadeFrames === 0) {
    const why = declared.conditioned
      ? "no cross-fade ran, because this loop was declared to keep its own length"
      : "no conditioning ran, because this clip was declared to ship as committed";
    return `Here ${why}, so the join is exactly as the material was authored: the fix is in the clip. Trim it to a zero crossing, or let the pass cross-fade it by declaring a loop.crossFadeMs. ${dontTune}`;
  }
  const applied = `An equal-power cross-fade of ${((crossFadeFrames / sampleRate) * 1000).toFixed(0)} ms ran and the wrap survived it`;
  if (declared.spliceToleranceMs <= 0) {
    return `${applied}, and loop.spliceToleranceMs is 0, so the fade had to land exactly where the declared length put it — which is a lottery, and this clip lost it. Give the pass room to choose the join (loop.spliceToleranceMs: 25 is the default) and it will look for one that measures clean. ${dontTune}`;
  }
  return `${applied}, and the pass already searched +/-${String(declared.spliceToleranceMs)} ms for a quieter join without finding one. That means the material has no clean loop point near here, so the fix is the clip rather than the configuration: re-author the loop, or declare loop: false if it was never meant to repeat. ${dontTune}`;
}

/**
 * The check the defect that shipped would have needed.
 *
 * The joins were fine; the content was not. A hand pass conditioned nineteen clips and never
 * measured what was in them, so a chime that came back as a hum and fifteen footsteps built almost
 * half out of sub-bass both passed. Only the game can say what a clip is for, so only the game
 * declares the bound — and once it has, this is not skippable.
 */
function assertSpectrum(
  logicalPath: string,
  expectation: IAudioSpectrumExpectation | undefined,
  bands: Record<AudioBand, number>,
): void {
  if (expectation === undefined) return;
  const measured = bands[expectation.band];
  const range = AUDIO_BANDS[expectation.band];
  const where = `${String(range[0])}-${range[1] === Number.POSITIVE_INFINITY ? "Nyquist" : String(range[1])} Hz`;
  const shape = `Measured across the five bands: sub ${bands.sub.toFixed(1)}%, low ${bands.low.toFixed(1)}%, mid ${bands.mid.toFixed(1)}%, high ${bands.high.toFixed(1)}%, air ${bands.air.toFixed(1)}%.`;
  if (expectation.minPercent !== undefined && measured < expectation.minPercent) {
    throw new Error(
      `TN_ASSETS_AUDIO_SPECTRUM: '${logicalPath}' puts ${measured.toFixed(1)}% of its energy in '${expectation.band}' (${where}), under the ${String(expectation.minPercent)}% this clip was declared to need. The bytes are not what the game says this clip is for. ${shape}`,
    );
  }
  if (expectation.maxPercent !== undefined && measured > expectation.maxPercent) {
    throw new Error(
      `TN_ASSETS_AUDIO_SPECTRUM: '${logicalPath}' puts ${measured.toFixed(1)}% of its energy in '${expectation.band}' (${where}), over the ${String(expectation.maxPercent)}% this clip was declared to allow. ${shape}`,
    );
  }
}
