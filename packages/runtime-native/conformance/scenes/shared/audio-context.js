import { assertCondition, startBehaviorScene } from "./scene-support.js";

/**
 * Whether an `AudioParam` read back the value that was written to it.
 *
 * A Web Audio `AudioParam` stores a `float`, so `0.004` comes back as `0.004000000189…` and an
 * exact `===` would fail a browser that is behaving exactly as specified. Both sides go through
 * `Math.fround`, so the scene measures the same thing on each lane.
 */
function written(param, expected) {
  return Math.fround(param.value) === Math.fround(expected);
}

export function startScene(canvas, dimensions) {
  return startBehaviorScene(canvas, dimensions, "audio-context", async () => {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    assertCondition(typeof AudioContextClass === "function", "AudioContext must exist");
    const context = new AudioContextClass();
    assertCondition(typeof context.createGain === "function", "AudioContext.createGain must exist");
    const gain = context.createGain();
    assertCondition(typeof gain.connect === "function", "GainNode.connect must exist");
    gain.connect(context.destination);

    // The two nodes `AudioBus` reaches for on a target it cannot web-preview: a low-pass for
    // `lowpassHz` and a master compressor. Both are plain Web Audio factories, so a runtime that
    // binds neither fails here instead of only on device.
    assertCondition(
      typeof context.createBiquadFilter === "function",
      "AudioContext.createBiquadFilter must exist",
    );
    const filter = context.createBiquadFilter();
    assertCondition(typeof filter.frequency?.value === "number", "BiquadFilterNode.frequency must exist");
    filter.type = "lowpass";
    filter.frequency.value = 900;
    assertCondition(written(filter.frequency, 900), "BiquadFilterNode.frequency must be writable");
    filter.connect(context.destination);

    assertCondition(
      typeof context.createDynamicsCompressor === "function",
      "AudioContext.createDynamicsCompressor must exist",
    );
    const compressor = context.createDynamicsCompressor();
    for (const [name, value] of Object.entries({
      attack: 0.004,
      knee: 6,
      ratio: 5,
      release: 0.18,
      threshold: -15,
    })) {
      assertCondition(
        typeof compressor[name]?.value === "number",
        `DynamicsCompressorNode.${name} must exist`,
      );
      compressor[name].value = value;
      assertCondition(
        written(compressor[name], value),
        `DynamicsCompressorNode.${name} must be writable`,
      );
    }
    assertCondition(
      typeof compressor.reduction === "number",
      "DynamicsCompressorNode.reduction must be readable",
    );
    compressor.connect(context.destination);
    if (typeof context.close === "function") await context.close();
    return { biquadFilter: true, dynamicsCompressor: true, gainNode: true };
  });
}
