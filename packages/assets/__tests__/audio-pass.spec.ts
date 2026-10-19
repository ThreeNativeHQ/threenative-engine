import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_AUDIO_CONTAINERS,
  detectAudioContainer,
  // The pass's output has to be a container the native runtime actually decodes. Reading the
  // preflight's own table rather than restating it means a decoder list that drifts fails here
  // too, instead of leaving this suite green over a silent asset on every native target.
} from "../../runtime-native/scripts/asset-preflight.mjs";
import type { IAssetPassOutput } from "../src/compile.js";
import type * as AudioPcm from "../src/passes/audio-pcm.js";
import { audioPass } from "../src/passes/audio.js";
import {
  bandLimitedNoise,
  compileAudio,
  decodedSeam,
  noise,
  sine,
  wavClip,
} from "./audio-fixtures.js";

/**
 * The audio conditioning pass.
 *
 * `AssetKind` has classified `.ogg`, `.wav` and `.mp3` as audio since the pipeline was written,
 * and until now nothing acted on that: audio was classified and shipped through untouched. A lane
 * conditioned nineteen clips for a game in a one-off script instead, which reported success on all
 * nineteen while measuring none of them.
 *
 * The seam is the assertion these tests care about most, and the pair worth reading first is
 * "cross-fade did not take" against "step around the same jump": identical bytes, rejected when
 * the splice is pinned and accepted when it is free. It is measured on the decoded output bytes —
 * the ones that ship — because a cross-fade that is perfect in the intermediate PCM and ruined by
 * the encoder is still a click in the player's ears, and it is measured as a **ratio** to the steps
 * beside the join, because an absolute bound condemns dense clips and excuses quiet ones.
 */

const RATE = 44_100;

function passOutput(value: Buffer | IAssetPassOutput): IAssetPassOutput {
  if (Buffer.isBuffer(value)) throw new Error("audio pass test expected manifest output");
  return value;
}

describe("the audio pass direct seam", () => {
  it("should leave non-audio bytes untouched and publish its effective configuration", async () => {
    const input = Buffer.from("not an audio asset");
    const pass = audioPass({ normalise: "peak", peakDb: -3, quality: 4, seamMaxRatio: 2 });

    expect(pass.configuration).toMatchObject({
      normalise: "peak",
      peakDb: -3,
      quality: 4,
      seamMaxRatio: 2,
    });
    await expect(pass.apply(input, "notes/readme.txt")).resolves.toBe(input);
  });

  it("should condition a WAV directly and return native-readable Vorbis output", async () => {
    const output = passOutput(
      await audioPass().apply(
        wavClip({ frames: RATE, sample: bandLimitedNoise(71) }),
        "audio/bed.wav",
      ),
    );

    expect(output.outputExtension).toBe(".ogg");
    expect(output.entry?.audio).toMatchObject({
      conditioned: true,
      container: "Ogg Vorbis",
      reencoded: true,
    });
    expect(output.buffer.subarray(0, 4).toString("ascii")).toBe("OggS");
  });

  it("should preserve a declared unconditioned loop and its WAV bytes", async () => {
    const input = wavClip({ frames: RATE, sample: () => 0 });
    const output = passOutput(
      await audioPass({
        overrides: [{ glob: "bar.wav", conditioning: "none", loop: { crossFadeMs: 0 } }],
      }).apply(input, "bar.wav"),
    );

    expect(output.buffer).toBe(input);
    expect(output.outputExtension).toBe(".wav");
    expect(output.entry?.audio).toMatchObject({
      conditioned: false,
      container: "RIFF/WAVE",
      crossFadeMs: 0,
      crossFadeMsRequested: 0,
      loop: true,
      reencoded: false,
    });
  });

  it("should downmix positional stereo before encoding and report the memory saving", async () => {
    const output = passOutput(
      await audioPass({ overrides: [{ glob: "step.wav", positional: true }] }).apply(
        wavClip({ channels: 2, frames: RATE, sample: noise(73) }),
        "step.wav",
      ),
    );
    const audio = output.entry?.audio as Record<string, unknown>;

    expect(audio.channelsBefore).toBe(2);
    expect(audio.channelsAfter).toBe(1);
    expect(audio.decodedBytesAfter).toBe((audio.decodedBytesBefore as number) / 2);
  });

  it("should reuse an already-conditioned Ogg without another lossy generation", async () => {
    const first = passOutput(
      await audioPass().apply(wavClip({ frames: RATE, sample: bandLimitedNoise(79) }), "bed.wav"),
    );
    const second = passOutput(await audioPass().apply(first.buffer, "bed.ogg"));

    expect(second.buffer).toBe(first.buffer);
    expect(second.entry?.audio).toMatchObject({ container: "Ogg Vorbis", reencoded: false });
    expect(second.outputExtension).toBe(".ogg");
  });
});

describe("the audio pass seam assertion", () => {
  /**
   * A smooth, slow clip with one large jump planted exactly where a fixed 250 ms fade would splice.
   *
   * With the splice free to move, the pass steps around a jump like this and the loop comes out
   * clean, which is the whole point of choosing the splice. Pinning the tolerance to zero takes
   * that away and reproduces the original failure: the fade runs, lands on the jump, and the wrap
   * is left anomalous against a neighbourhood that is otherwise smooth. This is the shape of the
   * defect the hand-written conditioning script reported success on.
   */
  const clickingAtTheSplice = () => {
    const frames = RATE * 2;
    const splice = frames - Math.round(0.25 * RATE);
    return wavClip({
      frames,
      sample: (frame) =>
        0.4 * Math.sin((2 * Math.PI * 40 * frame) / RATE) + (frame >= splice ? 0.5 : -0.5),
    });
  };
  const fixedSplice = { crossFadeMs: 250, spliceToleranceMs: 0 } as const;

  it("should reject a declared loop whose cross-fade did not take", async () => {
    await expect(
      compileAudio("threenative-audio-seam-reject-", "bed.wav", clickingAtTheSplice(), {
        audio: { overrides: [{ glob: "bed.wav", loop: fixedSplice }] },
      }),
    ).rejects.toThrow(/TN_ASSETS_AUDIO_SEAM/u);
  });

  it("should say the fade ran, and that a pinned splice is why it could not help", async () => {
    // The remedy has to name the situation the build is actually in. Here the game pinned the
    // splice, so the honest fix is to let the pass choose the join — not to move the bar.
    await expect(
      compileAudio("threenative-audio-seam-applied-", "bed.wav", clickingAtTheSplice(), {
        audio: { overrides: [{ glob: "bed.wav", loop: fixedSplice }] },
      }),
    ).rejects.toThrow(
      /cross-fade of \d+ ms ran and the wrap survived it, and loop\.spliceToleranceMs is 0/u,
    );
  });

  it("should never offer raising the bound as the way out of a seam failure", async () => {
    // A throwing gate people learn to tune around is worse than no gate: it teaches the habit and
    // then gets deleted. Every branch of the remedy says so in as many words.
    for (const override of [
      { glob: "bed.wav", loop: fixedSplice },
      { glob: "bed.wav", loop: { crossFadeMs: 0 } },
      { glob: "bed.wav", loop: true as const, conditioning: "none" as const },
    ]) {
      await expect(
        compileAudio("threenative-audio-seam-no-tuning-", "bed.wav", clickingAtTheSplice(), {
          audio: { overrides: [override] },
        }),
      ).rejects.toThrow(/tunes the gate rather than the audio/u);
    }
  });

  it("should say the search already had room when it did, so the clip is the fix", async () => {
    // The other branch: the pass was free to move the splice, looked, and found nothing. Then the
    // configuration is not the problem and the message must not imply it is.
    const white = wavClip({ frames: RATE, sample: (frame) => (frame % 2 === 0 ? 0.95 : -0.95) });

    await expect(
      compileAudio("threenative-audio-seam-searched-", "bed.wav", white, {
        audio: {
          overrides: [{ glob: "bed.wav", loop: { crossFadeMs: 0 }, seamMaxRatio: 1.5 }],
        },
      }),
    ).rejects.toThrow(/the fix is in the clip/u);
  });

  it("should name the wrap, its neighbourhood and the limit, so no number is folklore", async () => {
    await expect(
      compileAudio("threenative-audio-seam-message-", "bed.wav", clickingAtTheSplice(), {
        audio: { overrides: [{ glob: "bed.wav", loop: fixedSplice }] },
      }),
    ).rejects.toThrow(
      /wrap step of \d+\.\d+ against a neighbourhood whose largest ordinary step is \d+\.\d+ — \d+\.\d+x, which exceeds the 1\.5x/u,
    );
  });

  it("should step around the same jump when the splice is free to move", async () => {
    // The other half of the pair above, on identical bytes: the only difference is that the game
    // let the splice move. A gate that fires here would be failing a clip the pass can fix.
    const compiled = await compileAudio(
      "threenative-audio-seam-splice-",
      "bed.wav",
      clickingAtTheSplice(),
      { audio: { overrides: [{ glob: "bed.wav", loop: true }] } },
    );

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.seamRatio as number).toBeLessThan(1.5);
    expect(audio.crossFadeMs as number).not.toBe(250);
  });

  it("should assert the seam of a loop declared with no cross-fade, which keeps its own timing", async () => {
    // A bar-accurate musical loop cannot be shortened by a fade, so `crossFadeMs: 0` is the
    // declared way to keep the length. It buys the game nothing on the assertion: a ramp that
    // jumps 1.8 at the wrap, in a neighbourhood that is otherwise perfectly smooth, is refused
    // with its own timing intact.
    const ramp = wavClip({ frames: RATE, sample: (frame) => (frame / RATE) * 1.8 - 0.9 });

    await expect(
      compileAudio("threenative-audio-seam-nofade-", "bar.wav", ramp, {
        audio: { overrides: [{ glob: "bar.wav", loop: { crossFadeMs: 0 } }] },
      }),
    ).rejects.toThrow(/TN_ASSETS_AUDIO_SEAM/u);
  });

  it("should make a band-limited bed loop seamlessly and report the fade it actually used", async () => {
    const bed = wavClip({ frames: RATE * 3, sample: bandLimitedNoise(7) });

    const compiled = await compileAudio("threenative-audio-seam-pass-", "bed.wav", bed, {
      audio: { overrides: [{ glob: "bed.wav", loop: true }] },
    });

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.loop).toBe(true);
    expect(audio.seamRatio as number).toBeLessThan(1.5);
    // Measured again here, independently of what the pass reported, on the bytes on disk.
    expect((await decodedSeam(compiled.outputBytes)).ratio).toBeLessThan(1.5);
    // The splice moves to find a quiet seam, so the fade the pass used is reported next to the
    // one the game asked for — the same honesty the model pass owes its simplify ratio.
    expect(audio.crossFadeMsRequested).toBe(250);
    expect(audio.crossFadeMs as number).toBeGreaterThan(200);
    expect(audio.crossFadeMs as number).toBeLessThan(300);
  });

  it("should not judge untreated white noise a click, because its wrap is an ordinary step", async () => {
    // Neighbouring samples are independent, so the wrap is a typical draw from the same
    // distribution as every step beside it — audibly no worse than any other point in the clip.
    // The bare step is large here, and an absolute bound would have failed it wrongly.
    const bed = wavClip({ frames: RATE * 2, sample: noise(101) });

    const compiled = await compileAudio("threenative-audio-seam-white-", "bed.wav", bed, {
      audio: { overrides: [{ glob: "bed.wav", loop: true }] },
    });

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.seamWrap as number).toBeGreaterThan(0.03);
    expect(audio.seamRatio as number).toBeLessThan(1.5);
  });

  it("should measure and report the seam of an undeclared clip without asserting it", async () => {
    // Turning a convention off must not turn its measurement off. Nothing declares this clip, so
    // nothing fails — and every number that would have caught a bad join is in the receipt anyway.
    const ramp = wavClip({ frames: RATE, sample: (frame) => (frame / RATE) * 1.8 - 0.9 });

    const compiled = await compileAudio("threenative-audio-seam-report-", "loose.wav", ramp);

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.loop).toBe(false);
    expect(audio.seamMaxRatio).toBeUndefined();
    expect(audio.seamWrap as number).toBeGreaterThan(1);
    expect(audio.seamRatio as number).toBeGreaterThan(1.5);
  });

  it("should carry the bound it judged against into the manifest, not just into the throw", async () => {
    // Guarding a green-for-the-wrong-reason: the manifest narrowing silently dropped
    // `seamMaxRatio` for a while, which made the assertion above pass on an absent field rather
    // than on an undeclared one. Asserting the present case is what gives the absent case meaning.
    const bed = wavClip({ frames: RATE * 2, sample: bandLimitedNoise(67) });

    const compiled = await compileAudio("threenative-audio-bound-recorded-", "bed.wav", bed, {
      audio: { overrides: [{ glob: "bed.wav", loop: true, seamMaxRatio: 2 }] },
    });

    expect((compiled.entry.audio as Record<string, unknown>).seamMaxRatio).toBe(2);
  });

  it("should refuse a seam bound loose enough to be no assertion at all", async () => {
    const bed = wavClip({ frames: RATE, sample: noise(3) });

    await expect(
      compileAudio("threenative-audio-seam-cap-", "bed.wav", bed, {
        audio: { overrides: [{ glob: "bed.wav", loop: true, seamMaxRatio: 20 }] },
      }),
    ).rejects.toThrow(/TN_ASSETS_CONFIG_INVALID/u);
  });

  it("should refuse a seam bound tight enough to fail a flawless loop", async () => {
    // Below 1.0 the bound condemns a wrap that lands on the signal's own steepest point, which is
    // a perfect join. A looped pure sine measures 1.0 there on float error alone.
    const bed = wavClip({ frames: RATE, sample: noise(3) });

    await expect(
      compileAudio("threenative-audio-seam-floor-", "bed.wav", bed, {
        audio: { overrides: [{ glob: "bed.wav", loop: true, seamMaxRatio: 0.5 }] },
      }),
    ).rejects.toThrow(/TN_ASSETS_CONFIG_INVALID/u);
  });
});

describe("the audio pass channel policy", () => {
  it("should downmix a positional clip to mono and halve what it costs decoded", async () => {
    const stereo = wavClip({ channels: 2, frames: RATE, sample: noise(11) });

    const compiled = await compileAudio("threenative-audio-mono-", "step.wav", stereo, {
      audio: { overrides: [{ glob: "step.wav", positional: true }] },
    });

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.channelsBefore).toBe(2);
    expect(audio.channelsAfter).toBe(1);
    // The decoded cost is the larger of the two and the one a phone's memory pays.
    expect(audio.decodedBytesAfter).toBe((audio.decodedBytesBefore as number) / 2);
  });

  it("should keep the channels of a clip the game never declared positional", async () => {
    const stereo = wavClip({ channels: 2, frames: RATE, sample: noise(11) });

    const compiled = await compileAudio("threenative-audio-stereo-", "music.wav", stereo);

    expect((compiled.entry.audio as Record<string, unknown>).channelsAfter).toBe(2);
  });

  it("should refuse to invent a downmix for a source with more channels than a target reads", async () => {
    const surround = wavClip({ channels: 6, frames: RATE, sample: noise(13) });

    await expect(compileAudio("threenative-audio-surround-", "amb.wav", surround)).rejects.toThrow(
      /TN_ASSETS_AUDIO_CHANNELS/u,
    );
  });
});

describe("the audio pass level conditioning", () => {
  const offsetTone = (offset: number, amplitude: number) =>
    wavClip({
      frames: RATE,
      sample: (frame) => offset + amplitude * Math.sin((2 * Math.PI * 220 * frame) / RATE),
    });

  it("should remove a DC offset, which wastes headroom and thumps on every start", async () => {
    const compiled = await compileAudio("threenative-audio-dc-", "tone.wav", offsetTone(0.3, 0.25));

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.dcOffsetBefore as number).toBeGreaterThan(0.25);
    expect(Math.abs(audio.dcOffsetAfter as number)).toBeLessThan(0.01);
  });

  it("should leave a quiet clip where the author put it, so the game keeps its own mix", async () => {
    // Normalising every clip up to one peak would make a footstep as loud as a chime and force
    // the game to undo the pipeline in its volume settings. The default is a ceiling, so a clip
    // already under it is not touched.
    const compiled = await compileAudio(
      "threenative-audio-ceiling-quiet-",
      "step.wav",
      offsetTone(0, 0.25),
    );

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.peakBefore as number).toBeCloseTo(0.25, 2);
    expect(audio.peakAfter as number).toBeLessThan(0.3);
  });

  it("should pull a clip that exceeds the ceiling down to it", async () => {
    const compiled = await compileAudio(
      "threenative-audio-ceiling-loud-",
      "shout.wav",
      offsetTone(0, 1),
    );

    // -1 dBFS is 0.891 of full scale; the encode moves it by its own noise, not more.
    const peakAfter = (compiled.entry.audio as Record<string, unknown>).peakAfter as number;
    expect(peakAfter).toBeGreaterThan(0.85);
    expect(peakAfter).toBeLessThan(0.95);
  });

  it("should lift a quiet clip to the ceiling only when the game asks for it by name", async () => {
    const compiled = await compileAudio(
      "threenative-audio-normalise-peak-",
      "step.wav",
      offsetTone(0, 0.25),
      { audio: { normalise: "peak" } },
    );

    const peakAfter = (compiled.entry.audio as Record<string, unknown>).peakAfter as number;
    expect(peakAfter).toBeGreaterThan(0.85);
    expect(peakAfter).toBeLessThan(0.95);
  });
});

describe("the audio pass container policy", () => {
  it("should encode every conditioned clip to a container every native target decodes", async () => {
    const bed = wavClip({ frames: RATE, sample: noise(17) });

    const compiled = await compileAudio("threenative-audio-container-", "bed.wav", bed);

    const container = detectAudioContainer(compiled.outputBytes);
    expect(container).toBe("Ogg Vorbis");
    expect(NATIVE_AUDIO_CONTAINERS).toContain(container);
    expect((compiled.entry.audio as Record<string, unknown>).container).toBe(container);
    expect(String(compiled.entry.output)).toMatch(/\.ogg$/u);
  });

  it("should fail the bake on a source no native target decodes instead of shipping silence", async () => {
    // An `.mp3` builds and plays on the web and is silent on desktop, Android and iOS alike. The
    // native packager already refuses it; failing here names the file while it is still cheap.
    const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4096, 0x33)]);

    await expect(compileAudio("threenative-audio-mp3-", "voice.mp3", mp3)).rejects.toThrow(
      /TN_ASSETS_AUDIO_UNDECODABLE/u,
    );
  });
});

describe("the audio pass declared-intent checks", () => {
  it("should fail a chime that came back a hum, against the floor the game declared", async () => {
    // The real defect: 200 Hz and nothing above it, declared as needing energy where a struck bell
    // lives. The pass does not guess what a chime is — the game says, and the pass measures.
    const hum = wavClip({ frames: RATE, sample: sine(200, RATE) });

    await expect(
      compileAudio("threenative-audio-spectrum-floor-", "chime.wav", hum, {
        audio: { overrides: [{ glob: "chime.wav", spectrum: { band: "high", minPercent: 40 } }] },
      }),
    ).rejects.toThrow(/under the 40% this clip was declared to need/u);
  });

  it("should fail a footstep built out of sub-bass, against the ceiling the game declared", async () => {
    // The other real defect, and the one a floor cannot express: fifteen footsteps carried up to
    // 45% of their energy below 100 Hz. A wood has nothing down there and a phone's speaker has no
    // headroom to spend on it.
    const thud = wavClip({
      frames: RATE,
      sample: (frame) =>
        0.8 * Math.sin((2 * Math.PI * 60 * frame) / RATE) +
        0.15 * Math.sin((2 * Math.PI * 3000 * frame) / RATE),
    });

    await expect(
      compileAudio("threenative-audio-spectrum-ceiling-", "step.wav", thud, {
        audio: { overrides: [{ glob: "step.wav", spectrum: { band: "sub", maxPercent: 15 } }] },
      }),
    ).rejects.toThrow(/over the 15% this clip was declared to allow/u);
  });

  it("should name the whole band profile when it fails, not only the bound that broke", async () => {
    const hum = wavClip({ frames: RATE, sample: sine(200, RATE) });

    await expect(
      compileAudio("threenative-audio-spectrum-profile-", "chime.wav", hum, {
        audio: { overrides: [{ glob: "chime.wav", spectrum: { band: "high", minPercent: 40 } }] },
      }),
    ).rejects.toThrow(
      /sub \d+\.\d+%, low \d+\.\d+%, mid \d+\.\d+%, high \d+\.\d+%, air \d+\.\d+%/u,
    );
  });

  it("should pass a clip that sits inside its declared band and report what it measured", async () => {
    const chime = wavClip({ frames: RATE, sample: sine(3000, RATE) });

    const compiled = await compileAudio("threenative-audio-spectrum-pass-", "chime.wav", chime, {
      audio: { overrides: [{ glob: "chime.wav", spectrum: { band: "high", minPercent: 40 } }] },
    });

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.spectrumPercent as number).toBeGreaterThan(40);
    expect(audio.spectrumMinPercent).toBe(40);
    expect(audio.spectrumBand).toBe("high");
    expect(audio.spectrumMaxPercent).toBeUndefined();
  });

  it("should record a declared ceiling in the manifest too", async () => {
    const chime = wavClip({ frames: RATE, sample: sine(3000, RATE) });

    const compiled = await compileAudio("threenative-audio-spectrum-ceil-ok-", "chime.wav", chime, {
      audio: { overrides: [{ glob: "chime.wav", spectrum: { band: "sub", maxPercent: 15 } }] },
    });

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.spectrumMaxPercent).toBe(15);
    expect(audio.spectrumMinPercent).toBeUndefined();
    expect(audio.spectrumPercent as number).toBeLessThan(15);
  });

  it("should measure and report the band profile of every clip, declared or not", async () => {
    // The number nobody looked at. It costs nothing and it is where both defects were.
    const chime = wavClip({ frames: RATE, sample: sine(3000, RATE) });

    const compiled = await compileAudio("threenative-audio-bands-", "chime.wav", chime);

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.spectrumBand).toBeUndefined();
    expect(audio.bandHigh as number).toBeGreaterThan(80);
    const total =
      (audio.bandSub as number) +
      (audio.bandLow as number) +
      (audio.bandMid as number) +
      (audio.bandHigh as number) +
      (audio.bandAir as number);
    expect(total).toBeCloseTo(100, 4);
  });

  it("should refuse a spectrum declaration that bounds nothing", async () => {
    // A check that runs, reports and can never fail is the v1 harness failure in miniature.
    const chime = wavClip({ frames: RATE, sample: sine(3000, RATE) });

    await expect(
      compileAudio("threenative-audio-spectrum-empty-", "chime.wav", chime, {
        audio: { overrides: [{ glob: "chime.wav", spectrum: { band: "high" } as never }] },
      }),
    ).rejects.toThrow(/TN_ASSETS_CONFIG_INVALID/u);
  });
});

describe("the audio pass declaration parsing", () => {
  it("should reject an unrecognised audio key rather than silently ignoring it", async () => {
    const bed = wavClip({ frames: 1024, sample: noise(19) });

    await expect(
      compileAudio("threenative-audio-unknown-key-", "bed.wav", bed, {
        audio: { overrides: [{ glob: "bed.wav", looping: true } as never] },
      }),
    ).rejects.toThrow(/TN_ASSETS_CONFIG_UNKNOWN_KEY/u);
  });

  it("should reject an override with no glob to match against", async () => {
    const bed = wavClip({ frames: 1024, sample: noise(23) });

    await expect(
      compileAudio("threenative-audio-no-glob-", "bed.wav", bed, {
        audio: { overrides: [{ loop: true } as never] },
      }),
    ).rejects.toThrow(/TN_ASSETS_CONFIG_INVALID/u);
  });
});

describe("the audio pass pass-through", () => {
  it("should ship declared-unconditioned bytes as committed and still assert a declared loop", async () => {
    const ramp = wavClip({ frames: RATE, sample: (frame) => (frame / RATE) * 1.8 - 0.9 });

    await expect(
      compileAudio("threenative-audio-none-loop-", "bar.wav", ramp, {
        audio: { overrides: [{ glob: "bar.wav", conditioning: "none", loop: true }] },
      }),
    ).rejects.toThrow(/TN_ASSETS_AUDIO_SEAM/u);
  });

  it("should keep an unconditioned clip's own container in its name and its manifest", async () => {
    // Writing WAV bytes under an `.ogg` name would decode — the runtime sniffs the header — and
    // would still be a lie sitting next to a `container` field that said otherwise.
    const bed = wavClip({ frames: RATE, sample: bandLimitedNoise(53) });

    const compiled = await compileAudio("threenative-audio-none-wav-", "bed.wav", bed, {
      audio: { overrides: [{ glob: "bed.wav", conditioning: "none" }] },
    });

    const audio = compiled.entry.audio as Record<string, unknown>;
    expect(audio.container).toBe("RIFF/WAVE");
    expect(audio.reencoded).toBe(false);
    expect(String(compiled.entry.output)).toMatch(/\.wav$/u);
    expect(compiled.outputBytes.equals(bed)).toBe(true);
  });

  it("should ship a float WAV whose samples exceed 1.0 unchanged, because that is headroom", async () => {
    // A Float32 WAV is allowed above 1.0 and a storm bed uses it: rain's own wind clip peaks at
    // 1.053, and the headroom above full scale is deliberate mix, not a defect to normalise away.
    // Clamping it into [-1, 1] here would make that unrepresentable in a test at all.
    const above = wavClip({ float: true, frames: RATE, sample: () => 1.053 });

    const compiled = await compileAudio("threenative-audio-float-headroom-", "wind.wav", above, {
      audio: { overrides: [{ glob: "wind.wav", conditioning: "none" }] },
    });

    expect(compiled.outputBytes.equals(above)).toBe(true);
    expect(compiled.entry.audio).toMatchObject({ container: "RIFF/WAVE", reencoded: false });
    expect((compiled.entry.audio as Record<string, unknown>).peakBefore).toBeCloseTo(1.053, 6);
    expect((compiled.entry.audio as Record<string, unknown>).peakAfter).toBeCloseTo(1.053, 6);
  });

  it("should show what the default pass does to that headroom, so the declaration is not free", async () => {
    // A sine rather than a constant, because a constant is pure DC and the pass removes DC before
    // it looks at the peak at all.
    const above = wavClip({
      float: true,
      frames: RATE,
      sample: (frame) => 1.053 * Math.sin((2 * Math.PI * 220 * frame) / RATE),
    });

    const cooked = await compileAudio("threenative-audio-float-drift-", "wind.wav", above);

    const audio = cooked.entry.audio as Record<string, unknown>;
    // The ceiling attenuates, and the Vorbis round trip lands a little above it, so the peak the
    // player hears is neither the authored one nor its absence. That is the drift the declaration
    // exists to prevent, and the tolerance here is the codec's overshoot, not a fudge.
    expect(Number(audio.peakAfter)).toBeLessThan(1.053);
    expect(Number(audio.peakAfter)).toBeCloseTo(10 ** (-1 / 20), 1);
  });

  it("should assert a declared float loop's seam on the bytes it ships", async () => {
    const loop = wavClip({
      float: true,
      frames: RATE * 2,
      sample: (frame) => 1.053 * Math.sin((2 * Math.PI * 80 * frame) / RATE),
    });

    const compiled = await compileAudio("threenative-audio-float-seam-", "bed.wav", loop, {
      audio: {
        overrides: [{ conditioning: "none", glob: "bed.wav", loop: { crossFadeMs: 0 } }],
      },
    });

    expect(Number((compiled.entry.audio as Record<string, unknown>).seamRatio)).toBeLessThanOrEqual(
      1.5,
    );
    expect(compiled.outputBytes.equals(loop)).toBe(true);
  });

  it("should ship an already-conditioned Ogg source untouched instead of re-encoding it", async () => {
    // Sixteen of wildwood's nineteen clips are already mono, already under the ceiling and carry
    // no DC: re-encoding them cost about 4% more bytes and a generation of lossy Vorbis to
    // deliver the identical audio. A pass with nothing to do says so.
    const wav = wavClip({ frames: RATE, sample: bandLimitedNoise(59) });
    const first = await compileAudio("threenative-audio-reencode-once-", "bed.wav", wav);
    expect((first.entry.audio as Record<string, unknown>).reencoded).toBe(true);

    // Feed the pass its own output: nothing is left to change, so the bytes must survive.
    const second = await compileAudio(
      "threenative-audio-reencode-twice-",
      "bed.ogg",
      first.outputBytes,
    );

    const audio = second.entry.audio as Record<string, unknown>;
    expect(audio.reencoded).toBe(false);
    expect(second.outputBytes.equals(first.outputBytes)).toBe(true);
  });

  it("should refuse to ship an undecodable container even when conditioning is declared off", async () => {
    const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4096, 0x33)]);

    await expect(
      compileAudio("threenative-audio-none-mp3-", "voice.mp3", mp3, {
        audio: { overrides: [{ glob: "voice.mp3", conditioning: "none" }] },
      }),
    ).rejects.toThrow(/TN_ASSETS_AUDIO_UNDECODABLE/u);
  });
});

describe("the audio pass determinism", () => {
  it("should emit the same bytes for the same input twice", async () => {
    const bed = wavClip({ frames: RATE, sample: bandLimitedNoise(29) });

    const first = await compileAudio("threenative-audio-det-a-", "bed.wav", bed, {
      audio: { overrides: [{ glob: "bed.wav", loop: true }] },
    });
    const second = await compileAudio("threenative-audio-det-b-", "bed.wav", bed, {
      audio: { overrides: [{ glob: "bed.wav", loop: true }] },
    });

    // The Ogg serial number is random by default in every encoder; left alone it makes every
    // build's bytes differ and the determinism gate unwinnable.
    expect(first.outputBytes.equals(second.outputBytes)).toBe(true);
  });
});

describe("the audio pass cross-fade and drift assertions", () => {
  it("should refuse a declared cross-fade that would consume half of a short clip", async () => {
    await expect(
      compileAudio(
        "threenative-audio-fade-",
        "short.wav",
        wavClip({ frames: RATE / 10, sample: sine(440) }),
        {
          audio: {
            overrides: [{ glob: "short.wav", loop: { crossFadeMs: 250, spliceToleranceMs: 0 } }],
          },
        },
      ),
    ).rejects.toThrow(/TN_ASSETS_AUDIO_FADE_TOO_LONG/u);
  });

  it("should fail when the codec hands back a different sample rate than it encoded", async () => {
    // Only the pass's own re-decode is faulted. The first decode reads the source faithfully.
    vi.resetModules();
    const actual = await vi.importActual<typeof AudioPcm>("../src/passes/audio-pcm.js");
    let decodes = 0;
    vi.doMock("../src/passes/audio-pcm.js", () => ({
      ...actual,
      decodeAudioBytes: async (bytes: Buffer, label: string) => {
        const decoded = await actual.decodeAudioBytes(bytes, label);
        decodes += 1;
        return decodes === 1 ? decoded : { ...decoded, sampleRate: 22_050 };
      },
    }));
    try {
      const { audioPass: faultyCodecPass } = await import("../src/passes/audio.js");
      await expect(
        faultyCodecPass().apply(wavClip({ frames: RATE, sample: sine(440) }), "tone.wav"),
      ).rejects.toThrow(/TN_ASSETS_AUDIO_DRIFT/u);
    } finally {
      vi.doUnmock("../src/passes/audio-pcm.js");
    }
  });
});
