// Ported from three.js r185 (three@0.185.1). The MIT License, Copyright © 2010-2026 three.js authors.
/**
 * three's audio classes (`AudioListener`, `Audio`, `PositionalAudio`, `AudioLoader`) over an
 * engine's own `Object3D`, for both back ends: the browser-JS one and the V8 facade.
 *
 * Upstream's classes are plain JS over WebAudio, but they extend upstream `Object3D`, so the
 * engine's scene graph cannot hold them (`camera.add(listener)` would pass a foreign object) and
 * `voice instanceof Object3D` is false. These are the same classes, ported from three r185, with
 * the engine's `Object3D` as the base. One difference is structural: upstream pushes positions to
 * WebAudio from `updateMatrixWorld`, which three's renderer calls from JS each frame. The engine
 * updates world matrices natively, so the host calls `updateAudio()` once per frame instead.
 */

interface IAudioVector3 {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): IAudioVector3;
  applyQuaternion(quaternion: object): IAudioVector3;
}

interface IAudioObject3D {
  readonly parent: object | null;
  readonly matrixWorld: { decompose(position: object, quaternion: object, scale: object): unknown };
  updateMatrixWorld(force?: boolean): void;
  updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
  copy(source: object, recursive?: boolean): unknown;
}

/** What one engine supplies: its classes, and how `AudioLoader` reads a URL's bytes. */
export interface IAudioEngine {
  // quality-allow: three's PascalCase class name passed in engine constructor map.
  // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
  readonly Object3D: new () => IAudioObject3D;
  // quality-allow: three's PascalCase class name passed in engine constructor map.
  // biome-ignore lint/style/useNamingConvention: see Object3D.
  readonly Vector3: new () => IAudioVector3;
  // quality-allow: three's PascalCase class name passed in engine constructor map.
  // biome-ignore lint/style/useNamingConvention: see Object3D.
  readonly Quaternion: new () => object;
  readonly read: (url: string) => Promise<ArrayBuffer>;
}

interface IRamped {
  linearRampToValueAtTime(value: number, endTime: number): unknown;
}
interface ILegacyListener {
  positionX?: IRamped;
  setPosition(x: number, y: number, z: number): void;
  setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
}

export function defineAudioClasses(engine: IAudioEngine) {
  const { Object3D, Vector3, Quaternion } = engine;
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  const forward = new Vector3();
  const up = new Vector3();
  // An attached audio object is held strongly, since the native scene graph does not keep a JS
  // wrapper (or its WebAudio nodes) alive; a detached one only weakly, so dropping it frees it.
  type Tracked = { sync(refresh?: boolean): void } & IAudioObject3D;
  const attached = new Set<Tracked>();
  const detached = new Set<WeakRef<Tracked>>();
  const warn = (message: string) => console.warn(`Audio: ${message}`);
  const setType = (target: object, type: string) =>
    Object.defineProperty(target, "type", { value: type, writable: true, configurable: true });

  let shared: BaseAudioContext | undefined;
  // Upstream's AudioContext is a class of two statics; the same two calls on a plain object.
  const AudioContext = {
    getContext(): BaseAudioContext {
      if (shared === undefined) {
        // quality-allow: webkitAudioContext is the legacy Safari global prefix missing from standard DOM types.
        const host = globalThis as unknown as Record<
          string,
          (new () => BaseAudioContext) | undefined
        >;
        const Context = host.AudioContext ?? host.webkitAudioContext;
        if (Context === undefined)
          throw new Error("TN_AUDIO_CONTEXT_MISSING: this host has no WebAudio AudioContext");
        shared = new Context();
      }
      return shared;
    },
    setContext(value: BaseAudioContext): void {
      shared = value;
    },
  };

  class AudioListener extends Object3D {
    context = AudioContext.getContext();
    gain = this.context.createGain();
    filter: AudioNode | null = null;
    timeDelta = 0;
    #last: number | undefined;

    constructor() {
      super();
      setType(this, "AudioListener");
      this.gain.connect(this.context.destination);
      detached.add(new WeakRef(this));
    }
    getInput(): GainNode {
      return this.gain;
    }
    removeFilter(): this {
      if (this.filter !== null) {
        this.gain.disconnect(this.filter);
        this.filter.disconnect(this.context.destination);
        this.gain.connect(this.context.destination);
        this.filter = null;
      }
      return this;
    }
    getFilter(): AudioNode | null {
      return this.filter;
    }
    setFilter(value: AudioNode): this {
      if (this.filter !== null) {
        this.gain.disconnect(this.filter);
        this.filter.disconnect(this.context.destination);
      } else {
        this.gain.disconnect(this.context.destination);
      }
      this.filter = value;
      this.gain.connect(this.filter);
      this.filter.connect(this.context.destination);
      return this;
    }
    getMasterVolume(): number {
      return this.gain.gain.value;
    }
    setMasterVolume(value: number): this {
      this.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
      return this;
    }
    override updateMatrixWorld(force?: boolean): void {
      super.updateMatrixWorld(force);
      this.sync();
    }
    /** Pushes the world pose to WebAudio; `refresh` first brings the native world matrix up to date. */
    sync(refresh = false): void {
      if (refresh) this.updateWorldMatrix(true, false);
      const now = globalThis.performance.now();
      this.timeDelta = this.#last === undefined ? 0 : (now - this.#last) / 1000;
      this.#last = now;
      // quality-allow: WebAudio AudioListener differences between standard AudioParam and legacy setPosition/orientation.
      const listener = this.context.listener as unknown as ILegacyListener &
        Record<string, IRamped>;
      this.matrixWorld.decompose(position, quaternion, scale);
      forward.set(0, 0, -1).applyQuaternion(quaternion);
      up.set(0, 1, 0).applyQuaternion(quaternion);
      if (listener.positionX) {
        const end = this.context.currentTime + this.timeDelta;
        const ramp = (name: string, value: number) =>
          listener[name]?.linearRampToValueAtTime(value, end);
        ramp("positionX", position.x);
        ramp("positionY", position.y);
        ramp("positionZ", position.z);
        ramp("forwardX", forward.x);
        ramp("forwardY", forward.y);
        ramp("forwardZ", forward.z);
        ramp("upX", up.x);
        ramp("upY", up.y);
        ramp("upZ", up.z);
      } else {
        listener.setPosition(position.x, position.y, position.z);
        listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      }
    }
  }

  class Audio<TNode extends AudioNode = GainNode> extends Object3D {
    readonly listener: AudioListener;
    readonly context: BaseAudioContext;
    gain: GainNode;
    autoplay = false;
    buffer: AudioBuffer | null = null;
    detune = 0;
    loop = false;
    loopStart = 0;
    loopEnd = 0;
    offset = 0;
    duration: number | undefined = undefined;
    playbackRate = 1;
    isPlaying = false;
    hasPlaybackControl = true;
    source: AudioScheduledSourceNode | AudioNode | null = null;
    sourceType = "empty";
    filters: AudioNode[] = [];
    _startedAt = 0;
    _progress = 0;
    _connected = false;

    constructor(listener: AudioListener) {
      super();
      setType(this, "Audio");
      this.listener = listener;
      this.context = listener.context;
      this.gain = this.context.createGain();
      this.gain.connect(listener.getInput());
      detached.add(new WeakRef(this));
    }
    getOutput(): TNode {
      // quality-allow: Audio.gain is GainNode which bridges to TNode (defaulting to GainNode or subtype).
      return this.gain as unknown as TNode;
    }
    setNodeSource(audioNode: AudioNode): this {
      this.hasPlaybackControl = false;
      this.sourceType = "audioNode";
      this.source = audioNode;
      this.connect();
      return this;
    }
    setMediaElementSource(mediaElement: HTMLMediaElement): this {
      this.hasPlaybackControl = false;
      this.sourceType = "mediaNode";
      this.source = (this.context as globalThis.AudioContext).createMediaElementSource(
        mediaElement,
      );
      this.connect();
      return this;
    }
    setMediaStreamSource(mediaStream: MediaStream): this {
      this.hasPlaybackControl = false;
      this.sourceType = "mediaStreamNode";
      this.source = (this.context as globalThis.AudioContext).createMediaStreamSource(mediaStream);
      this.connect();
      return this;
    }
    setBuffer(audioBuffer: AudioBuffer): this {
      this.buffer = audioBuffer;
      this.sourceType = "buffer";
      if (this.autoplay) this.play();
      return this;
    }
    play(delay = 0): this | undefined {
      if (this.isPlaying) {
        warn("Audio is already playing.");
        return undefined;
      }
      if (!this.hasPlaybackControl) {
        warn("this Audio has no playback control.");
        return undefined;
      }
      this._startedAt = this.context.currentTime + delay;
      const source = this.context.createBufferSource();
      source.buffer = this.buffer;
      source.loop = this.loop;
      source.loopStart = this.loopStart;
      source.loopEnd = this.loopEnd;
      source.onended = this.onEnded.bind(this);
      source.start(this._startedAt, this._progress + this.offset, this.duration);
      this.isPlaying = true;
      this.source = source;
      this.setDetune(this.detune);
      this.setPlaybackRate(this.playbackRate);
      return this.connect();
    }
    pause(): this | undefined {
      if (!this.hasPlaybackControl) {
        warn("this Audio has no playback control.");
        return undefined;
      }
      if (this.isPlaying) {
        this._progress +=
          Math.max(this.context.currentTime - this._startedAt, 0) * this.playbackRate;
        if (this.loop)
          this._progress = this._progress % (this.duration || (this.buffer?.duration ?? 1));
        const source = this.source as AudioScheduledSourceNode;
        source.stop();
        source.onended = null;
        this.isPlaying = false;
      }
      return this;
    }
    stop(delay = 0): this | undefined {
      if (!this.hasPlaybackControl) {
        warn("this Audio has no playback control.");
        return undefined;
      }
      this._progress = 0;
      if (this.source !== null) {
        const source = this.source as AudioScheduledSourceNode;
        source.stop(this.context.currentTime + delay);
        source.onended = null;
      }
      this.isPlaying = false;
      return this;
    }
    connect(): this {
      const source = this.source as AudioNode;
      if (this.filters.length > 0) {
        source.connect(this.filters[0] as AudioNode);
        for (let i = 1; i < this.filters.length; i++)
          (this.filters[i - 1] as AudioNode).connect(this.filters[i] as AudioNode);
        (this.filters.at(-1) as AudioNode).connect(this.getOutput());
      } else {
        source.connect(this.getOutput());
      }
      this._connected = true;
      return this;
    }
    disconnect(): this | undefined {
      if (!this._connected) return undefined;
      const source = this.source as AudioNode;
      if (this.filters.length > 0) {
        source.disconnect(this.filters[0] as AudioNode);
        for (let i = 1; i < this.filters.length; i++)
          (this.filters[i - 1] as AudioNode).disconnect(this.filters[i] as AudioNode);
        (this.filters.at(-1) as AudioNode).disconnect(this.getOutput());
      } else {
        source.disconnect(this.getOutput());
      }
      this._connected = false;
      return this;
    }
    getFilters(): AudioNode[] {
      return this.filters;
    }
    setFilters(value?: AudioNode[] | null): this {
      if (this._connected) {
        this.disconnect();
        this.filters = (value ?? []).slice();
        this.connect();
      } else {
        this.filters = (value ?? []).slice();
      }
      return this;
    }
    setDetune(value: number): this {
      this.detune = value;
      const source = this.source as AudioBufferSourceNode | null;
      if (this.isPlaying && source?.detune !== undefined)
        source.detune.setTargetAtTime(this.detune, this.context.currentTime, 0.01);
      return this;
    }
    getDetune(): number {
      return this.detune;
    }
    getFilter(): AudioNode | undefined {
      return this.getFilters()[0];
    }
    setFilter(filter?: AudioNode | null): this {
      return this.setFilters(filter ? [filter] : []);
    }
    setPlaybackRate(value: number): this | undefined {
      if (!this.hasPlaybackControl) {
        warn("this Audio has no playback control.");
        return undefined;
      }
      this.playbackRate = value;
      if (this.isPlaying)
        (this.source as AudioBufferSourceNode).playbackRate.setTargetAtTime(
          this.playbackRate,
          this.context.currentTime,
          0.01,
        );
      return this;
    }
    getPlaybackRate(): number {
      return this.playbackRate;
    }
    onEnded(): void {
      this.isPlaying = false;
      this._progress = 0;
    }
    getLoop(): boolean {
      if (!this.hasPlaybackControl) {
        warn("this Audio has no playback control.");
        return false;
      }
      return this.loop;
    }
    setLoop(value: boolean): this | undefined {
      if (!this.hasPlaybackControl) {
        warn("this Audio has no playback control.");
        return undefined;
      }
      this.loop = value;
      if (this.isPlaying) (this.source as AudioBufferSourceNode).loop = this.loop;
      return this;
    }
    setLoopStart(value: number): this {
      this.loopStart = value;
      return this;
    }
    setLoopEnd(value: number): this {
      this.loopEnd = value;
      return this;
    }
    getVolume(): number {
      return this.gain.gain.value;
    }
    setVolume(value: number): this {
      this.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
      return this;
    }
    override copy(source: Audio<TNode>, recursive?: boolean): this {
      super.copy(source, recursive);
      if (source.sourceType !== "buffer") {
        warn("Audio source type cannot be copied.");
        return this;
      }
      this.autoplay = source.autoplay;
      this.buffer = source.buffer;
      this.detune = source.detune;
      this.loop = source.loop;
      this.loopStart = source.loopStart;
      this.loopEnd = source.loopEnd;
      this.offset = source.offset;
      this.duration = source.duration;
      this.playbackRate = source.playbackRate;
      this.hasPlaybackControl = source.hasPlaybackControl;
      this.sourceType = source.sourceType;
      this.filters = source.filters.slice();
      return this;
    }
    clone(recursive?: boolean): this {
      const Self = this.constructor as new (listener: AudioListener) => this;
      return new Self(this.listener).copy(this, recursive);
    }
    /** Upstream `Audio` sets no position; only `PositionalAudio` has one to push. */
    sync(_refresh?: boolean): void {}
  }

  const orientation = new Vector3();
  type LegacyPanner = PannerNode & {
    setPosition(x: number, y: number, z: number): void;
    setOrientation(x: number, y: number, z: number): void;
  };

  class PositionalAudio extends Audio<PannerNode> {
    panner: PannerNode;

    constructor(listener: AudioListener) {
      super(listener);
      setType(this, "PositionalAudio");
      this.panner = this.context.createPanner();
      this.panner.panningModel = "HRTF";
      this.panner.connect(this.gain);
    }
    override connect(): this {
      super.connect();
      this.panner.connect(this.gain);
      return this;
    }
    override disconnect(): this | undefined {
      super.disconnect();
      this.panner.disconnect(this.gain);
      return this;
    }
    override getOutput(): PannerNode {
      return this.panner;
    }
    getRefDistance(): number {
      return this.panner.refDistance;
    }
    setRefDistance(value: number): this {
      this.panner.refDistance = value;
      return this;
    }
    getRolloffFactor(): number {
      return this.panner.rolloffFactor;
    }
    setRolloffFactor(value: number): this {
      this.panner.rolloffFactor = value;
      return this;
    }
    getDistanceModel(): DistanceModelType {
      return this.panner.distanceModel;
    }
    setDistanceModel(value: DistanceModelType): this {
      this.panner.distanceModel = value;
      return this;
    }
    getMaxDistance(): number {
      return this.panner.maxDistance;
    }
    setMaxDistance(value: number): this {
      this.panner.maxDistance = value;
      return this;
    }
    setDirectionalCone(
      coneInnerAngle: number,
      coneOuterAngle: number,
      coneOuterGain: number,
    ): this {
      this.panner.coneInnerAngle = coneInnerAngle;
      this.panner.coneOuterAngle = coneOuterAngle;
      this.panner.coneOuterGain = coneOuterGain;
      return this;
    }
    override updateMatrixWorld(force?: boolean): void {
      super.updateMatrixWorld(force);
      this.sync();
    }
    override sync(refresh = false): void {
      if (this.hasPlaybackControl && !this.isPlaying) return;
      if (refresh) this.updateWorldMatrix(true, false);
      this.matrixWorld.decompose(position, quaternion, scale);
      orientation.set(0, 0, 1).applyQuaternion(quaternion);
      const panner = this.panner as LegacyPanner;
      if (panner.positionX) {
        const end = this.context.currentTime + this.listener.timeDelta;
        panner.positionX.linearRampToValueAtTime(position.x, end);
        panner.positionY.linearRampToValueAtTime(position.y, end);
        panner.positionZ.linearRampToValueAtTime(position.z, end);
        panner.orientationX.linearRampToValueAtTime(orientation.x, end);
        panner.orientationY.linearRampToValueAtTime(orientation.y, end);
        panner.orientationZ.linearRampToValueAtTime(orientation.z, end);
      } else {
        panner.setPosition(position.x, position.y, position.z);
        panner.setOrientation(orientation.x, orientation.y, orientation.z);
      }
    }
  }

  class AudioLoader {
    path = "";
    setPath(path: string): this {
      this.path = path;
      return this;
    }
    load(
      url: string,
      onLoad: (buffer: AudioBuffer) => void,
      _onProgress?: unknown,
      onError?: (error: unknown) => void,
    ): void {
      this.loadAsync(url).then(onLoad, (error: unknown) => {
        if (onError) onError(error);
        else console.error(error);
      });
    }
    async loadAsync(url: string): Promise<AudioBuffer> {
      const bytes = await engine.read(this.path + url);
      return AudioContext.getContext().decodeAudioData(bytes.slice(0));
    }
  }

  /** Pushes every attached listener and voice to WebAudio; the host calls this once per frame. */
  function updateAudio(): void {
    for (const reference of detached) {
      const object = reference.deref();
      if (object === undefined) detached.delete(reference);
      else if (object.parent) {
        detached.delete(reference);
        attached.add(object);
      }
    }
    for (const object of attached) {
      if (!object.parent) {
        attached.delete(object);
        detached.add(new WeakRef(object));
        continue;
      }
      object.sync(true);
    }
  }

  return { AudioContext, AudioListener, Audio, PositionalAudio, AudioLoader, updateAudio };
}
