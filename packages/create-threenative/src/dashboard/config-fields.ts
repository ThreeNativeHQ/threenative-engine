// The `threenative.config.ts` fields the Dev Dashboard edits (PRD-918). One list for both halves:
// the Settings form draws a control per row and the PATCH route accepts only these paths.
// `loadConfig` stays the validator; this list only says which paths exist and how a value parses.

export type ConfigFieldKind = "text" | "integer" | "number" | "boolean" | "choice" | "color";

export interface IConfigField {
  /** Dotted path into the config object, e.g. `display.maxFps`. */
  readonly path: string;
  readonly label: string;
  readonly group: "App" | "Engine & Renderer" | "Display & Window" | "UI & Boot Splash";
  readonly kind: ConfigFieldKind;
  /** For `choice`: the literal values. A number-or-literal field lists its literals here. */
  readonly options?: readonly (string | boolean)[];
  /** `number` or `integer` fields that also take one of `options` (e.g. `"auto"` or `false`). */
  readonly orNumber?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly hint?: string;
}

export const CONFIG_FIELDS: readonly IConfigField[] = [
  { path: "app.name", label: "Name", group: "App", kind: "text" },
  { path: "app.id", label: "Bundle id", group: "App", kind: "text", hint: "com.studio.game" },
  { path: "app.version", label: "Version", group: "App", kind: "text" },
  { path: "app.build", label: "Build number", group: "App", kind: "integer", min: 1 },
  {
    path: "engine",
    label: "Engine",
    group: "Engine & Renderer",
    kind: "choice",
    options: ["threenative", "threejs"],
    hint: "Restarts the dev server",
  },
  {
    path: "renderer.preferWebGPU",
    label: "Prefer WebGPU",
    group: "Engine & Renderer",
    kind: "boolean",
  },
  {
    path: "renderer.resolutionScale",
    label: "Resolution scale",
    group: "Engine & Renderer",
    kind: "number",
    options: ["auto"],
    orNumber: true,
    min: 0.25,
    max: 1,
  },
  {
    path: "renderer.antialias",
    label: "Antialias (MSAA)",
    group: "Engine & Renderer",
    kind: "boolean",
  },
  {
    path: "renderer.alphaAntialiasing",
    label: "Alpha antialiasing",
    group: "Engine & Renderer",
    kind: "boolean",
  },
  {
    path: "renderer.matrixWorld",
    label: "Matrix world updates",
    group: "Engine & Renderer",
    kind: "choice",
    options: ["visible", "all"],
  },
  {
    path: "renderer.minimumProjectedPixels",
    label: "Minimum projected pixels",
    group: "Engine & Renderer",
    kind: "number",
    options: [false],
    orNumber: true,
    min: 0,
  },
  {
    path: "display.orientation",
    label: "Orientation",
    group: "Display & Window",
    kind: "choice",
    options: ["landscape", "portrait", "sensor"],
  },
  { path: "display.fullscreen", label: "Fullscreen", group: "Display & Window", kind: "boolean" },
  {
    path: "display.keepScreenOn",
    label: "Keep screen on",
    group: "Display & Window",
    kind: "boolean",
  },
  {
    path: "display.maxFps",
    label: "Max FPS",
    group: "Display & Window",
    kind: "integer",
    min: 0,
    hint: "Empty = display refresh, 0 = uncapped",
  },
  {
    path: "display.priority",
    label: "Priority",
    group: "Display & Window",
    kind: "choice",
    options: ["game", "normal"],
  },
  {
    path: "display.backgroundMode",
    label: "Background mode",
    group: "Display & Window",
    kind: "choice",
    options: ["pause", "continue"],
  },
  { path: "window.title", label: "Window title", group: "Display & Window", kind: "text" },
  {
    path: "window.width",
    label: "Window width",
    group: "Display & Window",
    kind: "integer",
    min: 1,
  },
  {
    path: "window.height",
    label: "Window height",
    group: "Display & Window",
    kind: "integer",
    min: 1,
  },
  {
    path: "window.maximized",
    label: "Start maximized",
    group: "Display & Window",
    kind: "boolean",
  },
  { path: "window.resizable", label: "Resizable", group: "Display & Window", kind: "boolean" },
  {
    path: "ui.renderer",
    label: "UI renderer",
    group: "UI & Boot Splash",
    kind: "choice",
    options: ["web", "native", "native-css"],
  },
  {
    path: "bootSplash.backgroundColor",
    label: "Boot splash color",
    group: "UI & Boot Splash",
    kind: "color",
  },
];

/** The project-level telemetry switch (PRD-918): the only telemetry setting a repo carries. */
export const CRASH_REPORTS_PATH = "telemetry.crashReports";

const BY_PATH = new Map(CONFIG_FIELDS.map((field) => [field.path, field]));

/** A config path the editor may write, or undefined. */
export function configField(path: string): IConfigField | undefined {
  if (path === CRASH_REPORTS_PATH)
    return { path, label: "Crash & engine error data", group: "App", kind: "boolean" };
  return BY_PATH.get(path);
}

/**
 * Parses one submitted value for its field: `null` means "remove the key" (back to the default).
 * Throws with the field path on a value of the wrong shape; range and enum rules beyond these
 * belong to `loadConfig`, which runs on the whole candidate before anything is written.
 */
export function parseFieldValue(field: IConfigField, value: unknown): unknown {
  if (value === null) return null;
  const literal = field.options?.find((option) => option === value);
  if (literal !== undefined) return literal;
  switch (field.kind) {
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
    case "text":
    case "color":
      if (typeof value === "string" && value.length <= 200) return value;
      break;
    case "integer":
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) {
        if (field.kind === "integer" && !Number.isInteger(value)) break;
        if (field.min !== undefined && value < field.min) break;
        if (field.max !== undefined && value > field.max) break;
        return value;
      }
      break;
    case "choice":
      break;
  }
  throw new Error(
    `${field.path}: ${JSON.stringify(value)} is not a valid ${field.label.toLowerCase()}`,
  );
}
