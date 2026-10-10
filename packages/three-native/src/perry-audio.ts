/** WebAudio handles over the native host's decoder and mixer. PCM stays native until requested. */
import { physicsCopy } from "tn-native-transport";
import { createPerryAudioTransport } from "./perry-transport.js";

const unsupported = (member: string): never => {
  throw new Error(`TN_AUDIO_UNSUPPORTED: ${member}`);
};
function refuse(target: object, owner: string, members: readonly string[]): void {
  for (const member of members)
    Object.defineProperty(target, member, { value: () => unsupported(`${owner}.${member}`) });
}
function finite(value: number, member: string, minimum = Number.NEGATIVE_INFINITY): number {
  if (!Number.isFinite(value) || value < minimum)
    throw new RangeError(`TN_AUDIO_ARGUMENT: ${member}`);
  return value;
}

export function createPerryAudioHost() {
  const call = createPerryAudioTransport();
  const contexts = new Set<AudioContext>();

  class AudioBuffer {
    readonly handle: number;
    readonly numberOfChannels: number;
    readonly length: number;
    readonly sampleRate: number;
    constructor(
      readonly context: AudioContext,
      info: number[],
    ) {
      this.handle = info[0] as number;
      this.numberOfChannels = info[1] as number;
      this.length = info[2] as number;
      this.sampleRate = info[3] as number;
      refuse(this, "AudioBuffer", ["copyFromChannel", "copyToChannel"]);
    }
    get duration(): number {
      return this.length / this.sampleRate;
    }
    getChannelData(channel: number): Float32Array {
      const out = call(17, this.context.handle, this.handle, [channel]);
      const result = new Float32Array(this.length);
      if (physicsCopy(result, out[0] as number, this.length, 6, false))
        throw new Error("TN_AUDIO_COPY: AudioBuffer.getChannelData");
      // shortcut: channel data is a snapshot; writable shared PCM needs a native lease API.
      return result;
    }
  }

  class AudioParam {
    constructor(
      readonly context: AudioContext,
      readonly node: number,
      readonly kind: number,
      readonly defaultValue: number,
    ) {
      refuse(this, "AudioParam", [
        "exponentialRampToValueAtTime",
        "setValueCurveAtTime",
        "cancelAndHoldAtTime",
      ]);
    }
    get value(): number {
      return call(13, this.context.handle, this.node, [this.kind, 0])[0] as number;
    }
    set value(value: number) {
      this.set(1, value);
    }
    private set(method: number, value: number, time = 0, constant = 0): this {
      call(13, this.context.handle, this.node, [
        this.kind,
        method,
        finite(value, "AudioParam.value"),
        finite(time, "AudioParam.time", 0),
        finite(constant, "AudioParam.timeConstant", 0),
      ]);
      return this;
    }
    setValueAtTime(value: number, time: number): this {
      return this.set(2, value, time);
    }
    linearRampToValueAtTime(value: number, time: number): this {
      return this.set(3, value, time);
    }
    setTargetAtTime(value: number, time: number, constant: number): this {
      return this.set(4, value, time, constant);
    }
    cancelScheduledValues(time: number): this {
      return this.set(5, 0, time);
    }
  }

  // The shipped mixer has no pitch resampler. Accept three's neutral defaults, refuse a pitch
  // change by name, and keep cancellation absent so AudioBus reports its existing detune fallback.
  const fixedParam = (member: string, initial: number) => {
    const set = (value: number) => {
      if (value !== initial) unsupported(member);
      return param;
    };
    const param = {
      get value() {
        return initial;
      },
      set value(value: number) {
        set(value);
      },
      setValueAtTime: set,
      setTargetAtTime: set,
      linearRampToValueAtTime: set,
    };
    return param;
  };

  class AudioNode {
    constructor(
      readonly context: AudioContext,
      readonly handle: number,
    ) {
      refuse(this, "AudioNode", ["addEventListener", "removeEventListener", "dispatchEvent"]);
    }
    connect(destination: AudioNode, output = 0, input = 0): AudioNode {
      if (!(destination instanceof AudioNode) || destination.context !== this.context)
        throw new TypeError("TN_AUDIO_ARGUMENT: AudioNode.connect destination");
      if (output !== 0 || input !== 0) unsupported("AudioNode.connect ports");
      call(6, this.context.handle, this.handle, [destination.handle]);
      return destination;
    }
    disconnect(destination?: AudioNode): void {
      if (
        destination !== undefined &&
        (!(destination instanceof AudioNode) || destination.context !== this.context)
      )
        throw new TypeError("TN_AUDIO_ARGUMENT: AudioNode.disconnect destination");
      call(7, this.context.handle, this.handle, [destination?.handle ?? -1]);
    }
  }
  class GainNode extends AudioNode {
    gain = new AudioParam(this.context, this.handle, 0, 1);
  }
  class AudioBufferSourceNode extends AudioNode {
    private clip: AudioBuffer | null = null;
    private looping = false;
    private from = 0;
    private to = 0;
    private started = false;
    onended: (() => void) | null = null;
    detune = fixedParam("AudioBufferSourceNode.detune", 0);
    playbackRate = fixedParam("AudioBufferSourceNode.playbackRate", 1);
    get buffer(): AudioBuffer | null {
      return this.clip;
    }
    set buffer(buffer: AudioBuffer | null) {
      if (buffer !== null && (!(buffer instanceof AudioBuffer) || buffer.context !== this.context))
        throw new TypeError("TN_AUDIO_ARGUMENT: AudioBufferSourceNode.buffer");
      call(8, this.context.handle, this.handle, [buffer?.handle ?? 0]);
      this.clip = buffer;
    }
    private options(loop: boolean, from: number, to: number): void {
      call(9, this.context.handle, this.handle, [loop ? 1 : 0, from, to]);
      this.looping = loop;
      this.from = from;
      this.to = to;
    }
    get loop(): boolean {
      return this.looping;
    }
    set loop(value: boolean) {
      this.options(Boolean(value), this.from, this.to);
    }
    get loopStart(): number {
      return this.from;
    }
    set loopStart(value: number) {
      this.options(this.looping, value, this.to);
    }
    get loopEnd(): number {
      return this.to;
    }
    set loopEnd(value: number) {
      this.options(this.looping, this.from, value);
    }
    start(when = 0, offset = 0, duration = -1): void {
      if (this.started) throw new Error("TN_AUDIO_STATE: AudioBufferSourceNode.start called twice");
      if (this.buffer === null)
        throw new Error("TN_AUDIO_STATE: AudioBufferSourceNode.start without buffer");
      call(10, this.context.handle, this.handle, [when, offset, duration]);
      this.started = true;
      this.context.sources.add(this);
    }
    stop(when = 0): void {
      if (!this.started) throw new Error("TN_AUDIO_STATE: AudioBufferSourceNode.stop before start");
      call(11, this.context.handle, this.handle, [when]);
    }
  }
  class PannerNode extends AudioNode {
    private reference = 1;
    private maximum = 10000;
    private rolloff = 1;
    private model = "inverse";
    private panning = "equalpower";
    private warned = false;
    get refDistance(): number {
      return this.reference;
    }
    set refDistance(value: number) {
      call(18, this.context.handle, this.handle, [0, finite(value, "PannerNode.refDistance", 0)]);
      this.reference = value;
    }
    get maxDistance(): number {
      return this.maximum;
    }
    set maxDistance(value: number) {
      call(18, this.context.handle, this.handle, [1, finite(value, "PannerNode.maxDistance", 0)]);
      this.maximum = value;
    }
    get rolloffFactor(): number {
      return this.rolloff;
    }
    set rolloffFactor(value: number) {
      call(18, this.context.handle, this.handle, [2, finite(value, "PannerNode.rolloffFactor", 0)]);
      this.rolloff = value;
    }
    get distanceModel(): string {
      return this.model;
    }
    set distanceModel(value: string) {
      const kind = ["inverse", "linear", "exponential"].indexOf(value);
      if (kind < 0) throw new TypeError("TN_AUDIO_ARGUMENT: PannerNode.distanceModel");
      call(18, this.context.handle, this.handle, [3, kind]);
      this.model = value;
    }
    get panningModel(): string {
      return this.panning;
    }
    set panningModel(value: string) {
      if (value !== "HRTF" && value !== "equalpower")
        throw new TypeError("TN_AUDIO_ARGUMENT: PannerNode.panningModel");
      // The same bounded stereo panner as V8; three requests HRTF for every PositionalAudio.
      if (value === "HRTF" && !this.warned) {
        console.warn("TN_AUDIO_UNSUPPORTED: PannerNode.panningModel HRTF; using native stereo pan");
        this.warned = true;
      }
      this.panning = value;
    }
    get coneInnerAngle(): number {
      return 360;
    }
    set coneInnerAngle(value: number) {
      if (value !== 360) unsupported("PannerNode.coneInnerAngle");
    }
    get coneOuterAngle(): number {
      return 360;
    }
    set coneOuterAngle(value: number) {
      if (value !== 360) unsupported("PannerNode.coneOuterAngle");
    }
    get coneOuterGain(): number {
      return 0;
    }
    set coneOuterGain(value: number) {
      if (value !== 0) unsupported("PannerNode.coneOuterGain");
    }
    setPosition(x: number, y: number, z: number): void {
      call(18, this.context.handle, this.handle, [4, x, y, z]);
    }
    // Orientation cannot affect an omnidirectional source; directional cones refuse above.
    setOrientation(x: number, y: number, z: number): void {
      finite(x, "PannerNode.setOrientation");
      finite(y, "PannerNode.setOrientation");
      finite(z, "PannerNode.setOrientation");
    }
  }
  class BiquadFilterNode extends AudioNode {
    frequency = new AudioParam(this.context, this.handle, 1, 350);
    // biome-ignore lint/style/useNamingConvention: WebAudio names its quality factor Q.
    Q = new AudioParam(this.context, this.handle, 2, 1);
    get type(): string {
      return "lowpass";
    }
    set type(value: string) {
      if (value !== "lowpass") unsupported("BiquadFilterNode.type");
      call(20, this.context.handle, this.handle);
    }
  }
  class DynamicsCompressorNode extends AudioNode {
    threshold = new AudioParam(this.context, this.handle, 3, -24);
    knee = new AudioParam(this.context, this.handle, 4, 30);
    ratio = new AudioParam(this.context, this.handle, 5, 12);
    attack = new AudioParam(this.context, this.handle, 6, 0.003);
    release = new AudioParam(this.context, this.handle, 7, 0.25);
  }

  class AudioContext {
    readonly handle: number;
    readonly sampleRate: number;
    readonly destination: AudioNode;
    readonly listener;
    readonly sources = new Set<AudioBufferSourceNode>();
    readonly pending = new Map<
      number,
      { resolve(buffer: AudioBuffer): void; reject(error: unknown): void }
    >();
    private closed = false;
    constructor(options?: AudioContextOptions) {
      if (options && Object.keys(options).length)
        unsupported(`AudioContext.options.${Object.keys(options)[0]}`);
      const info = call(0);
      this.handle = info[0] as number;
      this.sampleRate = info[1] as number;
      this.destination = new AudioNode(this, 0);
      this.listener = {
        setPosition: (x: number, y: number, z: number) => {
          call(19, this.handle, 0, [0, x, y, z]);
        },
        setOrientation: (x: number, y: number, z: number, ux: number, uy: number, uz: number) => {
          call(19, this.handle, 0, [1, x, y, z, ux, uy, uz]);
        },
      };
      refuse(this, "AudioContext", [
        "createAnalyser",
        "createOscillator",
        "createStereoPanner",
        "createDelay",
        "createConvolver",
        "createWaveShaper",
        "createIIRFilter",
        "createPeriodicWave",
        "createChannelMerger",
        "createChannelSplitter",
        "createConstantSource",
        "createScriptProcessor",
        "createMediaElementSource",
        "createMediaStreamSource",
        "createMediaStreamDestination",
        "getOutputTimestamp",
        "addEventListener",
        "removeEventListener",
        "dispatchEvent",
      ]);
      contexts.add(this);
    }
    get currentTime(): number {
      return call(1, this.handle)[1] as number;
    }
    get state(): string {
      return this.closed ? "closed" : call(1, this.handle)[2] === 1 ? "running" : "suspended";
    }
    async resume(): Promise<void> {
      call(2, this.handle);
    }
    async suspend(): Promise<void> {
      call(3, this.handle);
    }
    async close(): Promise<void> {
      if (this.closed) return;
      call(4, this.handle);
      this.closed = true;
      contexts.delete(this);
      this.sources.clear();
      for (const pending of this.pending.values())
        pending.reject(new Error("TN_AUDIO_STATE: AudioContext.close during decodeAudioData"));
      this.pending.clear();
    }
    createGain(): GainNode {
      return new GainNode(this, call(5, this.handle, 0, [0])[0] as number);
    }
    createBufferSource(): AudioBufferSourceNode {
      return new AudioBufferSourceNode(this, call(5, this.handle, 0, [1])[0] as number);
    }
    createPanner(): PannerNode {
      return new PannerNode(this, call(5, this.handle, 0, [2])[0] as number);
    }
    createBiquadFilter(): BiquadFilterNode {
      return new BiquadFilterNode(this, call(5, this.handle, 0, [3])[0] as number);
    }
    createDynamicsCompressor(): DynamicsCompressorNode {
      return new DynamicsCompressorNode(this, call(5, this.handle, 0, [4])[0] as number);
    }
    createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
      return new AudioBuffer(this, call(21, this.handle, 0, [channels, length, sampleRate]));
    }
    decodeAudioData(
      input: ArrayBuffer | Uint8Array,
      success?: (buffer: AudioBuffer) => void,
      failure?: (error: unknown) => void,
    ): Promise<AudioBuffer> {
      const promise = new Promise<AudioBuffer>((resolve, reject) => {
        // Perry's Response.arrayBuffer() answers a Buffer, as for createImageBitmap.
        const bytes =
          input instanceof Uint8Array
            ? input
            : input instanceof ArrayBuffer
              ? new Uint8Array(input)
              : undefined;
        if (bytes === undefined)
          throw new TypeError("TN_AUDIO_ARGUMENT: AudioContext.decodeAudioData bytes");
        const id = call(14, this.handle, 0, [], bytes)[0] as number;
        this.pending.set(id, { resolve, reject });
      });
      return promise.then(
        (buffer) => {
          success?.(buffer);
          return buffer;
        },
        (error: unknown) => {
          failure?.(error);
          throw error;
        },
      );
    }
  }
  return {
    AudioContext,
    update(): void {
      if (contexts.size > 0) call(22);
      for (const context of contexts) {
        for (const [id, pending] of context.pending) {
          try {
            const info = call(15, context.handle, id);
            if (info[0] === 0) continue;
            context.pending.delete(id);
            pending.resolve(new AudioBuffer(context, info.slice(1)));
          } catch (error) {
            context.pending.delete(id);
            pending.reject(error);
          }
        }
        for (const source of context.sources) {
          if (call(12, context.handle, source.handle)[0] === 0) continue;
          context.sources.delete(source);
          source.onended?.();
        }
      }
    },
    close(): void {
      for (const context of contexts) void context.close();
    },
  };
}
