import { AudioListener, Object3D, PositionalAudio, Audio as ThreeAudio, type Vector3 } from "three";

/**
 * Bus-level dynamics compression, every value the game's.
 *
 * All five are required and none has an engine default: a compressor is a mix decision, and a
 * bus that filled in the threshold itself would be deciding how loud the game is. The ranges are
 * Web Audio's own — threshold -100 to 0 dBFS, knee 0–40 dB, ratio 1–20, attack and release
 * 0–1 s, where 0 is an instant response — and anything outside them throws rather than being
 * quietly clamped into a mix the game did not ask for.
 */
export interface IAudioCompressorOptions {
  /** Level above which the bus is compressed, in dBFS. Must be finite and between -100 and 0. */
  readonly threshold: number;
  /** Width of the soft transition around `threshold`, in dB. Must be finite and 0–40. */
  readonly knee: number;
  /** Input:output ratio above the threshold. Must be finite and 1–20. */
  readonly ratio: number;
  /** Seconds to reach full compression once a peak arrives. Must be finite and 0–1. */
  readonly attack: number;
  /** Seconds to return to unity once the mix falls back. Must be finite and 0–1. */
  readonly release: number;
}

export interface IAudioBusOptions {
  readonly camera: Object3D;
  /**
   * A compressor on this bus's master, holding a loud mix below clipping.
   *
   * Every voice sums into it before the bus's volume gain, so it sees the mix rather than each
   * cue alone — which is the whole point: three cues that are each fine and add up to a clipped
   * master is a defect no per-voice option can see, and a compressor that sat after the gain
   * would be working on a level the bus volume had already moved. Opt in, and every value comes
   * from the game. A runtime with no dynamics node reports `compressor` in `unsupported` rather
   * than playing on uncompressed and quiet about it.
   */
  readonly compressor?: IAudioCompressorOptions;
  readonly gestureTarget?: EventTarget;
  readonly listener?: AudioListener;
  readonly source?: () => EventTarget | undefined;
  /**
   * Ceiling on simultaneously sounding one-shots. Past it the oldest voice is stopped and its
   * slot reused: a firefight generates far more cues than a listener can resolve, and the newest
   * event is always the one they need to hear. Looping voices from `music` are exempt.
   * Defaults to 48.
   */
  readonly maxVoices?: number;
}

export interface IAudioPlayOptions {
  /**
   * What this cue is, for anything reading back what the game played — a playtest above all.
   *
   * Nothing about the sound changes. Every other audio check answers "is the file right": that it
   * exists, decodes, and is inside its byte budget. None of them can answer "did the game say the
   * general-quarters line twice", which is the class of defect players actually report, so the bus
   * keeps a ledger of the labels it was given.
   */
  readonly cue?: string;
  readonly fade?: number;
  readonly loop?: boolean;
  readonly volume?: number;
  /**
   * Metres from the source where positional attenuation begins; `playAt` only. Three's panner
   * default of 1 m makes a shot 20 m away all but inaudible — raise this to keep mid-distance
   * sounds loud. Must be finite and positive.
   */
  readonly refDistance?: number;
  /**
   * How fast volume falls off past `refDistance`; `playAt` only. 0 keeps the sound at full
   * volume at any distance. Must be finite and non-negative.
   */
  readonly rolloffFactor?: number;
  /**
   * Pitch offset in cents; ±100 is a semitone. Applied before the first sample rather than
   * through three's `setDetune`, which ramps over ~30 ms and turns a percussive attack into an
   * audible sweep. A few dozen cents of per-shot spread is what stops a repeated sample
   * comb-filtering with its own copies into a metallic buzz.
   */
  readonly detune?: number;
  /**
   * Seconds of the buffer to pass before an exponential cut-off. A 1.4 s gunshot fired ten times
   * a second stacks fourteen overlapping tails into mush; truncating all but the last keeps the
   * transient and drops the wash. Must be finite and positive.
   */
  readonly cutoffSeconds?: number;
  /**
   * Low-pass corner in Hz. Air and geometry eat the top of a sound as it crosses a space, and a
   * sample played flat at every range is the loudest tell that a game's audio is not in a place.
   * Must be finite and positive.
   */
  readonly lowpassHz?: number;
}

export interface IAudioRuntimeSnapshot {
  /**
   * How many times each labelled cue has sounded, across every live bus.
   *
   * This is the only observation that can answer "what did the game actually say, and how often".
   * Every other audio check in the repository is about the *file* — that it exists, decodes and is
   * inside its budget — and all of them stay green while a one-shot line plays a second time
   * halfway through a match, which is the defect players report. A game opts a cue in by passing
   * `cue` to `play`/`playAt`; unlabelled sounds never appear here.
   */
  readonly cues: Readonly<Record<string, number>>;
  /** The most recent labelled cues in the order they sounded, bounded per bus. */
  readonly recentCues: ReadonlyArray<{ readonly atMs: number; readonly cue: string }>;
  readonly queued: number;
  readonly voices: number;
  /** Retired voices held for reuse. Bounded by peak concurrency, never by session length. */
  readonly pooled: number;
  /**
   * Voices stopped mid-cue by `pause` and holding their position. Nonzero here while a game
   * claims to be running is a menu that muted the world and forgot to give it back.
   */
  readonly paused: number;
  /**
   * Cue-shaping options this runtime accepted and could not honour, sorted and de-duplicated.
   *
   * The native host binds a biquad filter and a compressor but no schedulable `detune`, so
   * `detune` is silently dropped there. A mix tuned on the web and shipped to a phone is flat in
   * a way nothing else reports, and a build can be failed on this.
   */
  readonly unsupported: readonly string[];
}

/**
 * The live buses and the cue ledger, held on `globalThis` rather than in this module.
 *
 * Two reasons, and the second is why this is not over-engineering. The ledger has to outlive the
 * bus, because a scene change disposes one and builds another and the question being asked is
 * "did this one-shot line play again after the restart". And core ships one bundle per entry point
 * with no shared chunks (`splitting: false`), so a game importing `@threenative/core` and
 * `@threenative/core/playtest` loads **two copies of this module**, each with its own state: the
 * playtest bridge runs in the second copy, so every audio observation it ever published — voices,
 * pooled, paused, unsupported — described an empty registry no game had touched, and read as a
 * clean zero rather than "not measured". State something else reads back has to outlive the copy
 * it was written into.
 */
const AUDIO_STATE = Symbol.for("threenative.audio.runtime");

interface IAudioRuntimeState {
  readonly buses: Set<AudioBus>;
  readonly cueCounts: Map<string, number>;
  cueLog: Array<{ atMs: number; cue: string }>;
}

function audioState(): IAudioRuntimeState {
  const host = globalThis as Record<symbol, unknown>;
  const existing = host[AUDIO_STATE] as IAudioRuntimeState | undefined;
  if (existing !== undefined) return existing;
  const created: IAudioRuntimeState = { buses: new Set(), cueCounts: new Map(), cueLog: [] };
  host[AUDIO_STATE] = created;
  return created;
}

/** Records one labelled cue. Bounded: a session that plays for hours keeps the last 200. */
function noteCue(cue: string | undefined): void {
  if (cue === undefined || cue.length === 0) return;
  const state = audioState();
  state.cueCounts.set(cue, (state.cueCounts.get(cue) ?? 0) + 1);
  state.cueLog.push({ atMs: Math.round(globalThis.performance?.now() ?? Date.now()), cue });
  if (state.cueLog.length > 200) state.cueLog = state.cueLog.slice(-200);
}

/**
 * Forgets every recorded cue.
 *
 * @situation clear the recorded audio cue counts between tests so one test cannot read another's plays
 * @example resetAudioCueLedger();
 */
export function resetAudioCueLedger(): void {
  const state = audioState();
  state.cueCounts.clear();
  state.cueLog = [];
}

const DEFAULT_MAX_VOICES = 48;
/** Above 20 kHz a low-pass is inaudible, so this doubles as "no filter". */
const OPEN_LOWPASS_HZ = 20_000;
/**
 * Ramp back in over this on `resume`, and settle a `setVolume` with no fade over it.
 *
 * A buffer restarted mid-waveform steps the signal, and a step is a click. 15 ms is under a
 * frame and inaudible as a fade, which is the shortest thing that is not a click.
 */
const CLICKLESS_SECONDS = 0.015;

/**
 * Every voice this bus has ever played, one-shot or looping, positional or flat.
 *
 * A voice is recycled rather than rebuilt. Each one owns a `GainNode`, a `PannerNode` when it is
 * positional, and an `Object3D` in whatever scene graph it was parented into; minting a fresh set
 * per cue and abandoning them is unbounded growth in three places at once — scene children walked
 * every frame, nodes left connected to the listener, and garbage produced on the hottest path a
 * game has. A shooter emits hundreds of footsteps, shots and impacts a minute, so that growth is
 * measured in a single round, not over a session.
 *
 * The pool is bounded by peak concurrency: a bus that never plays more than eight cues at once
 * holds eight voices forever, whatever its uptime.
 */
type PooledVoice = {
  voice: ThreeAudio<AudioNode>;
  /** Context time playback began; the stealing policy sorts on it. */
  startedAt: number;
  /** Built on this voice's first filtered cue and retuned after, never rebuilt. */
  filter: BiquadFilterNode | undefined;
  /** Looping voices are exempt from stealing and never self-retire. */
  looping: boolean;
  /** Sounded seconds so far, carried across pauses so a cut-off resumes with its tail intact. */
  elapsed: number;
  /** Stopped by `pause` and holding its position; `resume` is the only thing that starts it. */
  held: boolean;
  /** The cue's target gain, restated on resume because a scheduled cut-off may have run it down. */
  volume: number;
  /** The cue's `cutoffSeconds`, re-armed for the remainder after a pause. */
  cutoff: number | undefined;
  /** The cue's `detune`. A resume builds a fresh source node, which carries none of it over. */
  detune: number;
  /**
   * Which free list this voice goes back to. Recorded at construction rather than sniffed:
   * three's `PositionalAudio` carries no `isPositionalAudio` marker, so a duck-typed check
   * silently files every panner on the flat list and the pool never reuses one.
   */
  positional: boolean;
};

export class AudioBus {
  readonly listener: AudioListener;
  #camera: Object3D;
  #gestureTarget: EventTarget | undefined;
  #gesture: (() => void) | undefined;
  #queue: Array<{ start: () => void; voice: ThreeAudio<AudioNode> }> = [];
  #voices = new Set<ThreeAudio<AudioNode>>();
  /** Sounding voices, in start order, so the oldest can be stolen without a scan. */
  #live: PooledVoice[] = [];
  /** Retired voices ready to sound again, split by kind: a panner cannot be un-built. */
  #freeFlat: PooledVoice[] = [];
  #freePositional: PooledVoice[] = [];
  #maxVoices: number;
  /** The bus master compressor, ahead of the listener's volume gain. See `#installCompressor`. */
  #compressor: DynamicsCompressorNode | undefined;
  #unlocked = false;
  #disposed = false;
  #paused = false;
  #volume = 1;
  /** Names of cue options this runtime dropped. Reported once each, never per cue. */
  #unsupported = new Set<string>();

  constructor(options: IAudioBusOptions) {
    const maxVoices = options.maxVoices ?? DEFAULT_MAX_VOICES;
    if (!Number.isInteger(maxVoices) || maxVoices < 1)
      throw new RangeError("maxVoices must be a positive integer.");
    this.#maxVoices = maxVoices;
    this.#camera = options.camera;
    this.listener = options.listener ?? new AudioListener();
    if (options.compressor !== undefined) this.#installCompressor(options.compressor);
    const source = options.source ?? (() => (typeof window === "undefined" ? undefined : window));
    this.#gestureTarget = options.gestureTarget ?? source();
    this.setCamera(options.camera);
    this.#gesture = () => {
      void this.unlock().catch(() => undefined);
    };
    for (const event of ["keydown", "pointerdown", "touchstart"] as const) {
      this.#gestureTarget?.addEventListener(event, this.#gesture);
    }
    if (this.#unsupported.size > 0) this.#flushUnsupported();
    audioState().buses.add(this);
  }

  /**
   * Warn about cue shaping this runtime dropped, once per option, before the first frame.
   *
   * `#dropped` is reached while a cue plays, which is too late to act on and easy to miss in a
   * device log. A bus asked for a compressor it cannot have knows at construction, so that case
   * is reported here instead of waiting for a mix to prove it.
   */
  #flushUnsupported(): void {
    for (const option of this.#unsupported) {
      console.warn(`AudioBus: this runtime cannot honour "${option}"; the cue sounds without it.`);
    }
  }

  get queued(): number {
    return this.#queue.length;
  }

  get voices(): number {
    return this.#voices.size;
  }

  /**
   * Retired voices held for reuse. This is the number that used to climb without limit: it is
   * now bounded by how many cues have ever sounded at once, so a gate can pin it.
   */
  get pooled(): number {
    return this.#freeFlat.length + this.#freePositional.length;
  }

  /** Voices holding their position across a `pause`. */
  get pausedVoices(): number {
    let held = 0;
    for (const entry of this.#live) if (entry.held) held += 1;
    return held;
  }

  /** True between `pause` and `resume`. */
  get paused(): boolean {
    return this.#paused;
  }

  /** The master volume last asked for — the target, not a point some ramp is passing through. */
  get volume(): number {
    return this.#volume;
  }

  /** @see IAudioRuntimeSnapshot.unsupported */
  get unsupported(): readonly string[] {
    return [...this.#unsupported].sort();
  }

  /**
   * The compressor on this bus's master, or `undefined` when the bus has none — either because
   * the game did not ask for one or because this runtime has no dynamics node.
   *
   * Exposed so a game can read `reduction` off it, which is the only observation that answers
   * "is the compressor doing anything", and so a playtest can assert on it.
   */
  get compressor(): DynamicsCompressorNode | undefined {
    return this.#compressor;
  }

  /**
   * The whole bus's level, which is what a volume slider and a duck both move.
   *
   * One bus per category — ambience, effects, music — makes this the mixer: ducking the wood
   * under a discovery cue is `ambience.setVolume(0.35, 0.4)` and `setVolume(1, 0.8)` after. It
   * rides the listener's gain, so it costs nothing per voice and applies to cues already sounding.
   *
   * A bus constructed with a shared `listener` shares that listener's master with every other bus
   * on it; give each category its own bus (the default) to mix them apart.
   *
   * @param volume Linear gain, 0 or greater.
   * @param fade Seconds to reach it. Defaults to a 15 ms settle, which is a level change rather
   * than a fade — the shortest move that does not click.
   */
  setVolume(volume: number, fade = 0): void {
    if (!Number.isFinite(volume) || volume < 0)
      throw new RangeError("volume must be finite and non-negative.");
    if (!Number.isFinite(fade) || fade < 0)
      throw new RangeError("fade must be finite and non-negative.");
    this.#volume = volume;
    const gain = this.listener.gain.gain;
    const now = this.listener.context.currentTime;
    gain.cancelScheduledValues?.(now);
    if (fade > 0) {
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(volume, now + fade);
    } else {
      // Not `setValueAtTime`: an instant jump on a sounding bus is the same click a hard cut is.
      gain.setTargetAtTime(volume, now, CLICKLESS_SECONDS);
    }
  }

  /**
   * Stop every sounding voice where it stands and hold its position.
   *
   * The difference from `stop` is what happens next: a paused bed resumes mid-bar, a stopped one
   * starts over. Cues asked for while paused stay queued and sound on `resume`, so a menu opened
   * during a burst does not fire the backlog at the player when they close it.
   *
   * The audio context keeps running — suspending it would silence every other bus sharing it.
   */
  pause(): void {
    if (this.#disposed || this.#paused) return;
    this.#paused = true;
    const now = this.listener.context.currentTime;
    for (const entry of this.#live) {
      const voice = entry.voice;
      if (!voice.isPlaying) continue;
      entry.elapsed += Math.max(now - entry.startedAt, 0);
      // three's `pause` detaches `onended` before it stops the node, so the reclaim hook this
      // bus installed does not fire and the voice stays live and accounted for.
      voice.pause();
      entry.held = true;
    }
  }

  /** Sound the held voices again from where they stopped, then release anything queued. */
  resume(): void {
    if (this.#disposed || !this.#paused) return;
    this.#paused = false;
    for (const entry of [...this.#live]) {
      if (!entry.held) continue;
      entry.held = false;
      // A one-shot whose cut-off ran out while the game sat in a menu has nothing left to sound.
      if (entry.cutoff !== undefined && !entry.looping && entry.cutoff - entry.elapsed <= 0) {
        this.#reclaim(entry);
        continue;
      }
      this.#sound(entry, CLICKLESS_SECONDS);
    }
    this.#flushQueue();
  }

  /**
   * Put a compressor where every voice sums, ahead of this bus's volume gain.
   *
   * Three wires a voice's gain straight to `listener.getInput()` in its own constructor, and the
   * listener's input is the bus's volume gain — so the only honest place for a bus compressor is
   * the voice side of that junction, which is what `#attachToMaster` splices it into. Its
   * alternative, `AudioListener.setFilter`, sits *after* the gain and would compress a mix the
   * volume slider had already moved. It also shares the listener's single filter slot, so a game
   * with two buses on one listener would have the second compressor overwrite the first.
   */
  #installCompressor(options: IAudioCompressorOptions): void {
    assertCompressor(options);
    const context = this.listener.context as AudioContext & {
      createDynamicsCompressor?: () => DynamicsCompressorNode;
    };
    if (context.createDynamicsCompressor === undefined) {
      this.#dropped("compressor");
      return;
    }
    const compressor = context.createDynamicsCompressor();
    // Every value is the game's, written before the node hears a sample.
    for (const name of ["threshold", "knee", "ratio", "attack", "release"] as const) {
      compressor[name].value = options[name];
    }
    // The compressor's own output is the bus gain, so it is the one node every voice reaches
    // through rather than past. A bus sharing a provided listener still reaches that gain
    // directly, so installing a compressor here never silences another bus.
    compressor.connect(this.listener.getInput());
    this.#compressor = compressor;
  }

  /**
   * Route a freshly constructed voice into the bus master, through the compressor when there is one.
   *
   * The splice is the price of three not offering a way to route a voice anywhere but straight
   * into the listener. It is paid once per pooled voice, at claim time, so a bus pays for it at
   * peak concurrency and never again.
   */
  #attachToMaster(voice: ThreeAudio<AudioNode>): ThreeAudio<AudioNode> {
    if (this.#compressor === undefined) return voice;
    voice.gain.disconnect();
    voice.gain.connect(this.#compressor);
    return voice;
  }

  setCamera(camera: Object3D): void {
    this.#camera = camera;
    camera.add(this.listener);
  }

  reparent(camera: Object3D): void {
    this.setCamera(camera);
  }

  async unlock(): Promise<void> {
    if (this.#disposed || this.#unlocked) return;
    const context = this.listener.context as AudioContext & { resume?: () => Promise<void> };
    if (context.resume !== undefined) await context.resume();
    this.#unlocked = true;
    this.#flushQueue();
  }

  /**
   * A cue with no place: the listener's own weapon, UI, narration.
   *
   * The returned voice is valid for as long as it is sounding. Once it ends the bus reclaims it
   * and may hand the same object to a later cue, so a caller holding the reference past that
   * point is addressing somebody else's sound. Read `isPlaying` before touching a voice you kept.
   */
  play(buffer: AudioBuffer, options: IAudioPlayOptions = {}): ThreeAudio {
    assertBuffer(buffer);
    assertOptions(options);
    noteCue(options.cue);
    const entry = this.#claimFlat(options.loop ?? false);
    const voice = entry.voice as ThreeAudio;
    configureVoice(voice, options);
    voice.setBuffer(buffer);
    this.#queueOrStart(entry, options);
    return voice;
  }

  /**
   * A cue somewhere in the world, at a fixed point or riding a moving object.
   *
   * A `Vector3` source is read in the coordinate space of the camera's parent, which is the
   * scene in the ordinary case. Pass an `Object3D` to weld the cue to something that moves.
   *
   * The same reclaim rule as `play` applies to the returned voice.
   */
  playAt(
    buffer: AudioBuffer,
    source: Object3D | Vector3,
    options: IAudioPlayOptions = {},
  ): PositionalAudio {
    assertBuffer(buffer);
    assertOptions(options);
    noteCue(options.cue);
    if (typeof (this.listener.context as { createPanner?: unknown }).createPanner !== "function")
      throw new Error("AudioBus.playAt needs createPanner(); this runtime has none.");
    const entry = this.#claimPositional(options.loop ?? false);
    const voice = entry.voice as PositionalAudio;
    configureVoice(voice, options);
    // A recycled voice carries the previous cue's falloff, so both are restated every time
    // rather than only when the caller supplies them.
    voice.setRefDistance(options.refDistance ?? 1);
    voice.setRolloffFactor(options.rolloffFactor ?? 1);
    voice.setBuffer(buffer);
    if (source instanceof Object3D) source.add(voice);
    else {
      voice.position.copy(source);
      (this.#camera.parent ?? this.#camera).add(voice);
      // The panner reads its position off the world matrix, and this voice moved after the
      // renderer's last update. Without this the cue plays where the slot last sounded.
      voice.updateMatrixWorld(true);
    }
    this.#queueOrStart(entry, options);
    return voice;
  }

  music(buffer: AudioBuffer, options: IAudioPlayOptions = {}): ThreeAudio {
    return this.play(buffer, { ...options, loop: options.loop ?? true });
  }

  /**
   * Stop one voice and give it back to the pool.
   *
   * The missing primitive: `stop()` silenced every voice or none, and stopping the handle
   * directly does not work — three's `Audio.stop()` detaches `onended` before stopping the node,
   * so the bus's reclaim hook never fires and the voice leaks out of the pool while staying in
   * the scene. A game that wants one entity's loop to end needs exactly this, and `playAt` with
   * `loop` is the obvious way to reach for it.
   *
   * Returns false for a voice this bus is not sounding — a stale handle from a voice already
   * recycled, or one belonging to another bus. Reported rather than thrown: a caller stopping a
   * sound that already ended has made no mistake.
   */
  stopVoice(voice: ThreeAudio<AudioNode>): boolean {
    if (this.#disposed) return false;
    const entry = this.#live.find((candidate) => candidate.voice === voice);
    if (entry === undefined) return false;
    this.#queue = this.#queue.filter((pending) => pending.voice !== voice);
    this.#reclaim(entry);
    return true;
  }

  stop(): void {
    for (const { voice } of this.#queue) voice.removeFromParent();
    this.#queue = [];
    for (const entry of this.#live.splice(0)) this.#retire(entry);
    this.#voices.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Every voice feeds the compressor, so it has to be lifted out again: leaving it connected
    // keeps a node the game may still hold alive, still holding this bus's voices.
    if (this.#compressor !== undefined) {
      this.#compressor.disconnect();
      this.#compressor = undefined;
    }
    this.stop();
    // `stop` retires the live voices; `#retire` short-circuits its free-list push once disposed,
    // so the only thing left is to unhook the ones already parked there.
    for (const entry of [...this.#freeFlat, ...this.#freePositional]) {
      entry.voice.removeFromParent();
      entry.filter?.disconnect();
    }
    this.#freeFlat = [];
    this.#freePositional = [];
    this.listener.removeFromParent();
    for (const event of ["keydown", "pointerdown", "touchstart"] as const) {
      if (this.#gesture !== undefined)
        this.#gestureTarget?.removeEventListener(event, this.#gesture);
    }
    audioState().buses.delete(this);
  }

  #queueOrStart(entry: PooledVoice, options: IAudioPlayOptions): void {
    const start = () => this.#start(entry, options);
    if (this.#unlocked && !this.#paused) start();
    else this.#queue.push({ start, voice: entry.voice });
  }

  #flushQueue(): void {
    if (!this.#unlocked || this.#paused) return;
    const queued = this.#queue.splice(0);
    for (const { start } of queued) start();
  }

  #start(entry: PooledVoice, options: IAudioPlayOptions): void {
    if (this.#disposed) return;
    // Everything a resume has to restate lives on the entry, because `pause` throws the source
    // node away and `play` builds a new one carrying none of it.
    entry.elapsed = 0;
    entry.held = false;
    entry.volume = options.volume ?? 1;
    entry.cutoff = options.cutoffSeconds;
    entry.detune = options.detune ?? 0;
    this.#applyFilter(entry, options.lowpassHz ?? OPEN_LOWPASS_HZ);
    this.#voices.add(entry.voice);
    this.#live.push(entry);
    this.#sound(entry, options.fade);
    this.#enforceCeiling();
  }

  /**
   * Sound this entry's voice, first time or after a pause, and reapply everything a fresh source
   * node does not inherit: gain, detune, the remaining cut-off, and the reclaim hook.
   */
  #sound(entry: PooledVoice, fade: number | undefined): void {
    const voice = entry.voice;
    voice.play();
    const now = this.listener.context.currentTime;
    entry.startedAt = now;
    // Gain is driven by automation rather than `setVolume`, because a recycled voice can still
    // carry a scheduled ramp from a cut-off cue, and a scheduled ramp beats a plain value write.
    const gain = voice.gain.gain;
    gain.cancelScheduledValues?.(now);
    if (fade !== undefined && fade > 0) {
      gain.setValueAtTime(0, now);
      gain.linearRampToValueAtTime(entry.volume, now + fade);
    } else {
      gain.setValueAtTime(entry.volume, now);
    }
    const source = voice.source as
      | (AudioNode & { onended?: (() => void) | null; detune?: AudioParam })
      | null;
    if (entry.detune !== 0) this.#applyDetune(source, entry.detune, now);
    if (entry.cutoff !== undefined && entry.cutoff > 0 && !entry.looping) {
      // Exponential, not linear: a linear cut across a decaying tail clicks, and `setTargetAtTime`
      // follows the shape the tail already has. After a pause only the remainder is left to run.
      gain.setTargetAtTime?.(0, now + Math.max(entry.cutoff - entry.elapsed, 0), 0.045);
    }
    if (source !== null && "onended" in source) {
      const onended = source.onended;
      source.onended = () => {
        onended?.();
        this.#reclaim(entry);
      };
    }
  }

  #applyDetune(
    source: (AudioNode & { detune?: AudioParam }) | null,
    detune: number,
    now: number,
  ): void {
    const param = source?.detune;
    // The native host binds `detune` as an inert stand-in — it carries the three scheduling names
    // and drops every write — while a real `AudioParam` also cancels. That is the whole
    // difference visible from here, and a silently flat cue is worse than a named one.
    if (param === undefined || typeof param.cancelScheduledValues !== "function") {
      this.#dropped("detune");
      return;
    }
    // `setDetune` ramps over ~30 ms. On a percussive attack that is an audible pitch sweep,
    // and de-phasing the attack is the entire point, so it has to land before the first sample.
    param.cancelScheduledValues(now);
    param.setValueAtTime(detune, now);
  }

  /** Name a cue option this runtime cannot honour. Once per option, not once per cue. */
  #dropped(option: string): void {
    if (this.#unsupported.has(option)) return;
    this.#unsupported.add(option);
    console.warn(`AudioBus: this runtime cannot honour "${option}"; the cue sounds without it.`);
  }

  /** Oldest one-shot first, so a burst of new cues never silences itself waiting for old ones. */
  #enforceCeiling(): void {
    if (this.#live.length <= this.#maxVoices) return;
    for (let index = 0; index < this.#live.length && this.#live.length > this.#maxVoices; ) {
      const entry = this.#live[index];
      if (entry === undefined || entry.looping) {
        index += 1;
        continue;
      }
      this.#live.splice(index, 1);
      this.#retire(entry);
    }
  }

  /** A voice that ran out on its own: out of the graph, back on the free list. */
  #reclaim(entry: PooledVoice): void {
    const index = this.#live.indexOf(entry);
    if (index === -1) return;
    this.#live.splice(index, 1);
    this.#retire(entry);
  }

  #retire(entry: PooledVoice): void {
    const voice = entry.voice;
    try {
      if (voice.isPlaying) voice.stop();
    } catch {}
    this.#voices.delete(voice);
    // Out of whatever scene graph it was parented into. Skipping this is the whole bug: the
    // object outlives its sound and the scene grows for as long as the game runs.
    voice.removeFromParent();
    voice.setLoop(false);
    entry.looping = false;
    entry.held = false;
    entry.elapsed = 0;
    entry.cutoff = undefined;
    entry.detune = 0;
    if (this.#disposed) return;
    const free = entry.positional ? this.#freePositional : this.#freeFlat;
    if (!free.includes(entry)) free.push(entry);
  }

  /**
   * Recover voices a caller stopped behind the bus's back.
   *
   * The pool's reclaim hook rides on `source.onended`, and **three's `Audio.stop()` sets
   * `onended` to null before it stops the node** — so a caller doing the natural thing with the
   * handle `play`/`playAt` returned leaves the entry in `#live` for the life of the bus: off the
   * pool, uncounted against `maxVoices`, and still parented into whatever scene graph `playAt`
   * welded it to. That is precisely the leak the pool exists to prevent, reachable through the
   * public API, and `stopVoice` is the correct route rather than the only one anybody will find.
   *
   * So the sweep runs where it is free — at claim time, when the bus needs a voice anyway. A
   * voice that is not playing and is not held has nothing left to sound. `held` is the exception
   * that matters: a paused voice is legitimately stopped at the node level and must survive.
   */
  #sweepFinished(): void {
    for (const entry of [...this.#live]) {
      if (entry.held || entry.voice.isPlaying) continue;
      // A queued voice has not started yet, so "not playing" is not "finished".
      if (this.#queue.some((pending) => pending.voice === entry.voice)) continue;
      this.#reclaim(entry);
    }
  }

  #claimFlat(looping: boolean): PooledVoice {
    this.#sweepFinished();
    const reused = this.#freeFlat.pop();
    if (reused !== undefined) {
      reused.looping = looping;
      return reused;
    }
    return {
      voice: this.#attachToMaster(new ThreeAudio(this.listener)),
      startedAt: 0,
      filter: undefined,
      looping,
      positional: false,
      elapsed: 0,
      held: false,
      volume: 1,
      cutoff: undefined,
      detune: 0,
    };
  }

  #claimPositional(looping: boolean): PooledVoice {
    this.#sweepFinished();
    const reused = this.#freePositional.pop();
    if (reused !== undefined) {
      reused.looping = looping;
      return reused;
    }
    return {
      voice: this.#attachToMaster(new PositionalAudio(this.listener)),
      startedAt: 0,
      filter: undefined,
      looping,
      positional: true,
      elapsed: 0,
      held: false,
      volume: 1,
      cutoff: undefined,
      detune: 0,
    };
  }

  /**
   * Air absorption. One `BiquadFilterNode` is built on a voice's first filtered cue and retuned
   * thereafter, so filtering costs one extra node per voice for the life of the bus rather than
   * one per sound.
   */
  #applyFilter(entry: PooledVoice, hz: number): void {
    const voice = entry.voice;
    if (hz >= OPEN_LOWPASS_HZ) {
      if (voice.filters.length > 0) voice.setFilters([]);
      return;
    }
    const context = this.listener.context as AudioContext & {
      createBiquadFilter?: () => BiquadFilterNode;
    };
    if (entry.filter === undefined) {
      if (context.createBiquadFilter === undefined) {
        this.#dropped("lowpassHz");
        return;
      }
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      entry.filter = filter;
    }
    entry.filter.frequency.value = hz;
    if (voice.filters.length === 0) voice.setFilters([entry.filter]);
  }
}

export function audioRuntimeSnapshot(): IAudioRuntimeSnapshot {
  let queued = 0;
  let voices = 0;
  let pooled = 0;
  let paused = 0;
  const unsupported = new Set<string>();
  const state = audioState();
  for (const bus of state.buses) {
    queued += bus.queued;
    voices += bus.voices;
    pooled += bus.pooled;
    paused += bus.pausedVoices;
    for (const option of bus.unsupported) unsupported.add(option);
  }
  return {
    cues: Object.fromEntries(state.cueCounts),
    paused,
    pooled,
    queued,
    recentCues: state.cueLog.map((entry) => ({ ...entry })),
    unsupported: [...unsupported].sort(),
    voices,
  };
}

/**
 * The compressor contract, checked before the node is built rather than after it is wired in.
 *
 * Ranges are Web Audio's own, so a value the platform would reject is refused here with its name
 * rather than clamped into something the game did not ask for.
 */
function assertCompressor(options: IAudioCompressorOptions): void {
  for (const name of ["threshold", "knee", "ratio", "attack", "release"] as const) {
    if (!Number.isFinite(options[name])) {
      throw new TypeError(`compressor.${name} must be a finite number.`);
    }
  }
  if (options.threshold < -100 || options.threshold > 0)
    throw new RangeError("compressor.threshold must be between -100 and 0 dBFS.");
  if (options.knee < 0 || options.knee > 40)
    throw new RangeError("compressor.knee must be between 0 and 40 dB.");
  if (options.ratio < 1 || options.ratio > 20)
    throw new RangeError("compressor.ratio must be between 1 and 20.");
  if (options.attack < 0 || options.attack > 1)
    throw new RangeError("compressor.attack must be between 0 and 1 second.");
  if (options.release < 0 || options.release > 1)
    throw new RangeError("compressor.release must be between 0 and 1 second.");
}

/** Every numeric contract on a cue, checked before a voice is claimed rather than after. */
function assertOptions(options: IAudioPlayOptions): void {
  // A cue that is not a label is a mistake the ledger would swallow: a number, an object, or an
  // empty string all read as "unlabelled" in the counts and the miscount is silent.
  if (options.cue !== undefined && (typeof options.cue !== "string" || options.cue.length === 0)) {
    throw new TypeError("cue must be a non-empty string.");
  }
  if (
    options.cutoffSeconds !== undefined &&
    (!Number.isFinite(options.cutoffSeconds) || options.cutoffSeconds <= 0)
  ) {
    throw new RangeError("cutoffSeconds must be finite and positive.");
  }
  if (
    options.lowpassHz !== undefined &&
    (!Number.isFinite(options.lowpassHz) || options.lowpassHz <= 0)
  ) {
    throw new RangeError("lowpassHz must be finite and positive.");
  }
  if (options.detune !== undefined && !Number.isFinite(options.detune)) {
    throw new RangeError("detune must be finite.");
  }
  // Volume/fade/refDistance/rolloffFactor used to be validated only in configureVoice —
  // after play() had already claimed its voice, so a throwing option orphaned it for good.
  const volume = options.volume ?? 1;
  if (!Number.isFinite(volume) || volume < 0)
    throw new RangeError("volume must be finite and non-negative.");
  if (options.fade !== undefined && (!Number.isFinite(options.fade) || options.fade < 0)) {
    throw new RangeError("fade must be finite and non-negative.");
  }
  if (
    options.refDistance !== undefined &&
    (!Number.isFinite(options.refDistance) || options.refDistance <= 0)
  ) {
    throw new RangeError("refDistance must be finite and positive.");
  }
  if (
    options.rolloffFactor !== undefined &&
    (!Number.isFinite(options.rolloffFactor) || options.rolloffFactor < 0)
  ) {
    throw new RangeError("rolloffFactor must be finite and non-negative.");
  }
}

function configureVoice(voice: ThreeAudio<AudioNode>, options: IAudioPlayOptions): void {
  const volume = options.volume ?? 1;
  voice.setLoop(options.loop ?? false);
  voice.setVolume(options.fade === undefined || options.fade === 0 ? volume : 0);
}

function assertBuffer(buffer: AudioBuffer): void {
  if (buffer === null || buffer === undefined)
    throw new TypeError("AudioBus requires a non-null AudioBuffer.");
}
