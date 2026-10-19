/**
 * The weather simulation and the shape of everything the UI reads.
 *
 * This is game-owned maths on purpose: presets, the finite clamp at the API boundary, the
 * exponential ease and the flash curve are the game's own rules, not a framework concept, so
 * they live here rather than in a package.
 */

export const WEATHER_KEYS = ["rain", "cloud", "wind", "fog", "exposure", "wet"] as const;

export type WeatherKey = (typeof WEATHER_KEYS)[number];

export type Weather = Record<WeatherKey, number>;

export type PresetName = "drizzle" | "storm" | "supercell" | "clearing";

export type QualityName = "performance" | "balanced" | "high" | "ultra";

/** What the simulation is doing right now, derived — never a literal the UI can drift from. */
export type SimStatus = "steady" | "settling" | "flashing" | "paused";

export const PRESETS: Record<PresetName, Weather> = {
  drizzle: { rain: 0.24, cloud: 0.48, wind: 0.2, fog: 0.2, exposure: 1.22, wet: 0.78 },
  storm: { rain: 0.76, cloud: 0.76, wind: 0.55, fog: 0.4, exposure: 1.12, wet: 1 },
  supercell: { rain: 1, cloud: 0.94, wind: 0.91, fog: 0.66, exposure: 1.04, wet: 1 },
  clearing: { rain: 0.04, cloud: 0.32, wind: 0.14, fog: 0.14, exposure: 1.3, wet: 0.94 },
};

/** A frame longer than this is a stall, and integrating it moves the weather in one visible jump. */
export const MAX_STEP = 0.08;

/** Seconds for the atmosphere to cover most of the gap to its target. */
export const EASE_TAU = 0.67;

/** Auto lightning waits for real cloud cover, so drizzle does not flash overhead. */
export const AUTO_STRIKE_CLOUD = 0.35;

/**
 * Tab visibility, from the UI realm — the only place that knows whether the frame is still on
 * screen, since `document` is a browser API and portable game code does not reach for one.
 *
 * It is answered at the intent door rather than validated into a state patch: nothing in the
 * atmosphere changes when the tab is hidden, and the loop is stopped anyway, so no frame would ever
 * read the field.
 */
export const VISIBILITY_INTENT = "setHidden";

const SPEED_OF_SOUND = 343;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** A preset by name, falling back to the storm. A copy, so a caller cannot edit the table. */
export function preset(name: PresetName): Weather {
  return { ...(PRESETS[name] ?? PRESETS.storm) };
}

/**
 * The finite clamp at the API boundary: a key whose value is not a finite number keeps `base`,
 * everything else is clamped into its range. Exposure is the one channel that is not 0..1.
 */
export function sanitizeWeather(
  input: Partial<Record<WeatherKey, unknown>>,
  base?: Weather,
): Weather {
  const result = { ...(base ?? preset("storm")) };
  for (const key of WEATHER_KEYS) {
    const value = Number(input[key]);
    if (input[key] === undefined || !Number.isFinite(value)) continue;
    result[key] = key === "exposure" ? clamp(value, 0.3, 2) : clamp(value, 0, 1);
  }
  return result;
}

/** Exponential ease towards the target, independent of frame rate because `dt` is real seconds. */
export function easeWeather(current: Weather, target: Weather, dt: number): Weather {
  const k = 1 - Math.exp(-dt / EASE_TAU);
  const next = { ...current };
  for (const key of WEATHER_KEYS) next[key] = current[key] + (target[key] - current[key]) * k;
  return next;
}

/**
 * Every UI toggle, and the state field each one actually writes. The intent name is the UI's
 * vocabulary and the field is the game's, so the mapping lives in one table rather than as six
 * spelled-out cases that can drift apart.
 */
export const TOGGLE_FIELDS = {
  setAudioEnabled: "audioEnabled",
  setAutoLightning: "autoLightning",
  setCinematic: "cinematic",
  setDroplets: "droplets",
  setFrozen: "frozen",
  setMuted: "muted",
  setSafe: "safe",
} as const satisfies Record<string, keyof GameState>;

const QUALITIES: readonly QualityName[] = ["performance", "balanced", "high", "ultra"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A weather payload turned into a clamped target, or a throw. Every channel is checked before any
 * is written, so a malformed payload leaves the atmosphere exactly where it was rather than
 * half-moved, and only real finite numbers are accepted: a slider that emits `null` or `"0.5"` is
 * a bug in the control, not a value to coerce.
 */
function weatherTarget(payload: unknown, base: Weather): Weather {
  if (!isRecord(payload)) throw new Error("expected an object of weather channels");
  const patch: Partial<Record<WeatherKey, number>> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!(WEATHER_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${key} is not a weather channel`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${key} must be a finite number`);
    }
    patch[key as WeatherKey] = value;
  }
  return sanitizeWeather(patch, base);
}

/**
 * The one door every UI intent comes through: intent name and payload in, the state patch the
 * game applies out. It throws on a malformed payload and it takes the current target as an
 * argument, so it is the whole rule set with no engine, no GPU and no module state — which is
 * also what the automation API will call.
 */
export function intentPatch(
  intent: string,
  payload: unknown,
  currentTarget: Weather,
): Partial<GameState> {
  const toggle = Object.hasOwn(TOGGLE_FIELDS, intent)
    ? TOGGLE_FIELDS[intent as keyof typeof TOGGLE_FIELDS]
    : undefined;
  if (toggle !== undefined) {
    if (typeof payload !== "boolean") throw new Error("expected a boolean payload");
    // Photosensitivity mode also takes automatic lightning down, at the one door every caller
    // uses: a reader who asked for no flashes must not get them from the sky on their own.
    if (toggle === "safe" && payload) return { autoLightning: false, safe: true };
    return { [toggle]: payload } as Partial<GameState>;
  }
  switch (intent) {
    case "setPreset": {
      // Own keys only: `in` would accept `toString` and hand back the storm's prototype.
      if (typeof payload !== "string" || !Object.hasOwn(PRESETS, payload)) {
        throw new Error("expected one of drizzle, storm, supercell, clearing");
      }
      const name = payload as PresetName;
      return { preset: name, target: { ...PRESETS[name] } };
    }
    case "setQuality":
      if (!QUALITIES.includes(payload as QualityName)) {
        throw new Error("expected performance, balanced, high or ultra");
      }
      return { quality: payload as QualityName, qualityExplicit: true };
    case "setWeather":
      return { target: weatherTarget(payload, currentTarget) };
    case "pause":
      return { paused: true };
    case "resume":
      return { paused: false };
    case "resetCamera":
      // The scene owns the rig, so this is a request it acts on and clears.
      return { cameraReset: true, cinematic: false };
    case "strike":
      // A request, not a value: the scene owns the clock the flash is measured against.
      return { strikeRequested: true };
    case "step":
      // The automation's `step(dt)`: seconds of simulation for the next frame, clamped as the
      // study clamped them. Consumed by that frame, and ignored while paused.
      if (typeof payload !== "number" || !Number.isFinite(payload)) {
        throw new Error("expected a finite number of seconds");
      }
      return { stepRequest: clamp(payload, 0, 60) };
    case "hideUi":
      return { uiHidden: true };
    case "showUi":
      return { uiHidden: false };
    case "help":
      return { helpOpen: true };
    case "closeHelp":
      return { helpOpen: false };
    default:
      throw new Error(`${intent} is not a rain intent`);
  }
}

/** The four-peak flash envelope: one strike is a stutter, not one fade. */
export function flashAt(secondsSinceStrike: number): number {
  if (secondsSinceStrike < 0 || secondsSinceStrike > 0.82) return 0;
  return Math.min(
    2.4,
    1.6 * Math.exp(-secondsSinceStrike * 34) +
      1.2 * Math.exp(-(((secondsSinceStrike - 0.105) / 0.016) ** 2)) +
      1.7 * Math.exp(-(((secondsSinceStrike - 0.21) / 0.025) ** 2)) +
      0.32 * Math.exp(-(((secondsSinceStrike - 0.38) / 0.09) ** 2)),
  );
}

/** Thunder arrives after the sound crosses the distance it was struck at. */
export function thunderDelay(metres: number): number {
  return Math.max(0, Number.isFinite(metres) ? metres : 0) / SPEED_OF_SOUND;
}

export type GameState = {
  /** Where the atmosphere is now, which is what the scene actually drew. */
  weather: Weather;
  /** Where it is heading. The UI writes here; the simulation eases `weather` towards it. */
  target: Weather;
  preset: PresetName;
  quality: QualityName;
  /** A URL or player choice outranks the scene's first-frame default. */
  qualityExplicit?: boolean;
  /** Observed before scene entry; the UI must not infer an adapter from window width. */
  softwareRendering?: boolean;
  elapsed: number;
  frame: number;
  flash: number;
  safe: boolean;
  droplets: boolean;
  autoLightning: boolean;
  cinematic: boolean;
  audioEnabled: boolean;
  muted: boolean;
  paused: boolean;
  uiHidden: boolean;
  helpOpen: boolean;
  uiReady: boolean;
  heading: number;
  /** Where the fly camera stands, in metres, so a move is read back rather than assumed. */
  position: { x: number; y: number; z: number };
  fps: number;
  /**
   * Drops the renderer was actually asked to draw this frame — the rain geometry's own
   * `instanceCount`, not the budget it was derived from, so the readout cannot report a number the
   * GPU was never handed.
   */
  dropCount: number;
  /** Absolute simulation time thunder is due, or -1 when nothing is in the air. */
  pendingThunderAt: number;
  /** Strikes so far, manual and automatic, that got past the photosensitivity gate. */
  strikes: number;
  /** The last strike: simulation time, metres from the camera, and its thunder delay in seconds. */
  lastStrike: { at: number; delay: number; metres: number };
  /** The cloud target the renderer really drew last frame, and the march steps it ran. */
  cloudPass: { width: number; height: number; steps: number };
  /** The engine's launch: how far first-use compilation has got, and whether the frame is ready. */
  loading: { progress: number; ready: boolean };
  /** The automation's stopped clock: frames still draw, only `stepRequest` advances it. */
  frozen: boolean;
  /** Seconds the next frame simulates on top of its own, from `step(dt)`. Cleared once used. */
  stepRequest: number;
  status: SimStatus;
  /** Set by the reset-camera intent, cleared by the frame that acted on it. */
  cameraReset: boolean;
  /** Set by the strike intent, cleared by the frame that struck. */
  strikeRequested: boolean;
};
