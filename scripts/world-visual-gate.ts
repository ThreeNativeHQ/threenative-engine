/**
 * PRD-477 Phase 1. Capture with the existing playtest runner, then:
 *   pnpm visuals:world --before reference/world.json --after candidate/world.json --out artifacts/world-gate
 *   pnpm visuals:world --score artifacts/world-gate --verdict critic-1.json --verdict critic-2.json --verdict critic-3.json
 * Share only out/blind with critics. Never share seal.json, poses/reveal.json or walk-reveal.json.
 * Exit 0 = judged pass; 1 = measured regression; 2 = inconclusive, invalid or not yet judged.
 * This is a model instrument, not the human blind session or Machinefall acceptance proof.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { softwareAdapterName } from "../packages/playtest/src/runner/browser.js";
import { assertFrameShowsSomething } from "./capture-guard.js";
import { createImageBlindBundle, sha256Text } from "./score-blind.js";
import {
  VISUAL_FLOOR,
  type VisualAbScore,
  buildVisualAbBundle,
  scoreVisualAb,
} from "./visual-ab.js";

type Vector = readonly [number, number, number];
interface IFrame {
  id: string;
  image: string;
  position: Vector;
  target: Vector;
  timeMs?: number;
}
interface ILandmark {
  id: string;
  position: Vector;
}
/** Paths are relative to the manifest; poses and times must be actual captured observations. */
export interface IWorldCaptureManifest {
  schemaVersion: 1;
  world: string;
  build: string;
  route: string;
  seed: string;
  nearBandMeters: number;
  capture: string;
  landmarks: readonly ILandmark[];
  samePose: readonly IFrame[];
  walk: readonly IFrame[];
}
interface ICapture {
  adapter: Record<string, string>;
  viewport: { width: number; height: number };
}
interface ILoaded {
  manifest: IWorldCaptureManifest;
  capture: ICapture;
  files: string[];
}
interface IBlindImage {
  label: string;
  image: string;
  sha256: string;
}
interface IWalkFrame extends IBlindImage {
  timeMs: number;
  position: Vector;
  target: Vector;
  distances: readonly { landmark: string; meters: number }[];
}
interface ISeries {
  label: string;
  frames: IWalkFrame[];
}
interface IBundle {
  schemaVersion: 1;
  evidenceSha256: string;
  promptSha256: string;
  nearBandMeters: number;
  landmarks: readonly ILandmark[];
  samePose: IBlindImage[];
  walk: ISeries[];
}
interface ISeal {
  bundleContentSha256: string;
  files: { file: string; sha256: string }[];
  /** Which anonymous series belongs to which side and capture run; never inside the blind bundle. */
  series: { label: string; arm: "before" | "after"; run: number }[];
  poseNames: Record<string, string>;
  adapters: { before: Record<string, string>[]; after: Record<string, string>[] };
}
export interface IWorldVisualBundle {
  bundle: string;
  bundleSha256: string;
}
export interface IPoppingEvent {
  critic: string;
  series: string;
  from: string;
  to: string;
  element: string;
  kind: "appear" | "disappear" | "lod-swap" | "missing";
  distanceMeters: number;
  description: string;
  candidate: boolean;
  disallowed: boolean;
}
export interface IIntermittentEvent {
  critic: string;
  series: string;
  kind: IPoppingEvent["kind"];
  distanceMeters: number;
  candidateRuns: number;
  referenceRuns: number;
}
export interface IWorldVisualScore {
  exitCode: 0 | 1 | 2;
  verdict: "pass" | "regression" | "inconclusive";
  reason?: "needs more runs";
  bundleSha256: string;
  samePose: VisualAbScore;
  popping: IPoppingEvent[];
  intermittent: IIntermittentEvent[];
  adapters: ISeal["adapters"];
  verdicts: { file: string; sha256: string }[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "docs/product/VISUAL-BASELINE.md");
const RUBRIC = path.join(ROOT, "docs/product/WORLD-VISUAL-GATE.md");
function fail(message: string): never {
  throw new Error(`TN_WORLD_VISUAL_INVALID: ${message}`);
}
const json = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const hash = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const write = (file: string, value: unknown): void =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    return fail(`${name} must be nonempty text`);
  return value;
}
function finite(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    return fail(`${name} must be a finite number >= ${minimum}`);
  return value;
}
function vector(value: unknown, name: string): Vector {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((n) => typeof n !== "number" || !Number.isFinite(n))
  )
    return fail(`${name} must be three finite coordinates`);
  return value as unknown as Vector;
}
function list(value: unknown, name: string, minimum = 1): unknown[] {
  if (!Array.isArray(value) || value.length < minimum)
    return fail(`${name} requires at least ${minimum} entries`);
  return value;
}
function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) fail(`${name} contains duplicates`);
}
function equal(a: unknown, b: unknown, name: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${name} does not match`);
}
function distance(a: Vector, b: Vector): number {
  return Math.hypot(...a.map((value, index) => value - (b[index] as number)));
}

function loadCapture(file: string): ILoaded {
  const value = record(json(file), file);
  if (value.schemaVersion !== 1) fail("unsupported capture manifest schemaVersion");
  for (const key of ["world", "build", "route", "seed"]) text(value[key], key);
  if (finite(value.nearBandMeters, "nearBandMeters") === 0) fail("nearBandMeters must be positive");
  const directory = path.dirname(file);
  const captureFile = path.resolve(directory, text(value.capture, "capture"));
  const capture = record(json(captureFile), "capture provenance");
  const adapter = record(capture.adapter, "adapter");
  const names = Object.values(adapter);
  if (
    names.length === 0 ||
    names.some((name) => typeof name !== "string") ||
    !["vendor", "architecture", "device", "description"].some((key) => {
      const name = adapter[key];
      return (
        typeof name === "string" &&
        name.trim() !== "" &&
        !/^(unknown|unavailable|none|n\/a)$/i.test(name.trim())
      );
    })
  )
    fail("a named hardware adapter is required");
  if (
    softwareAdapterName(adapter as Record<string, string>) !== undefined ||
    capture.rendererKind !== "webgpu" ||
    capture.target !== "web" ||
    capture.captureMethod !== "page.screenshot"
  )
    fail("requires hardware WebGPU browser capture provenance");
  const args = list(capture.browserArgs, "browserArgs");
  if (args.some((arg) => typeof arg !== "string") || !args.includes("--enable-unsafe-webgpu"))
    fail("capture must use the WebGPU browser recipe");
  const viewport = record(capture.viewport, "viewport");
  for (const key of ["width", "height"])
    if (!Number.isSafeInteger(finite(viewport[key], key, 1))) fail(`invalid viewport ${key}`);
  const files = [path.resolve(file), captureFile];
  const parseFrames = (name: "samePose" | "walk"): IFrame[] => {
    const frames = list(value[name], name, name === "walk" ? 2 : 1).map((raw): IFrame => {
      const frame = record(raw, name);
      const id = text(frame.id, "frame id");
      const image = path.resolve(directory, text(frame.image, "frame image"));
      const position = vector(frame.position, "position");
      const target = vector(frame.target, "target");
      if (distance(position, target) === 0) fail("camera position and target must differ");
      const stats = assertFrameShowsSomething(readFileSync(image), image);
      if (stats.width !== viewport.width || stats.height !== viewport.height)
        fail("image dimensions do not match capture viewport");
      files.push(image);
      return {
        id,
        image,
        position,
        target,
        ...(name === "walk" ? { timeMs: finite(frame.timeMs, "walk timeMs") } : {}),
      };
    });
    unique(
      frames.map((frame) => frame.id),
      `${name} ids`,
    );
    unique(
      frames.map((frame) => realpathSync(frame.image)),
      `${name} image paths`,
    );
    return frames;
  };
  const samePose = parseFrames("samePose");
  const walk = parseFrames("walk");
  if (
    walk.some(
      (frame, index) =>
        index > 0 && (frame.timeMs as number) <= (walk[index - 1]?.timeMs as number),
    )
  )
    fail("walk timeMs must be strictly chronological");
  if (walk.every((frame) => distance(frame.position, walk[0]?.position as Vector) === 0))
    fail("walk camera never moved");
  const landmarks = list(value.landmarks, "landmarks").map((raw): ILandmark => {
    const landmark = record(raw, "landmark");
    return {
      id: text(landmark.id, "landmark id"),
      position: vector(landmark.position, "landmark position"),
    };
  });
  unique(
    landmarks.map((landmark) => landmark.id),
    "landmark ids",
  );
  return {
    manifest: { ...(value as unknown as IWorldCaptureManifest), samePose, walk, landmarks },
    capture: capture as unknown as ICapture,
    files,
  };
}

/** Fisher-Yates with the crypto RNG already imported, so no extra dependency and no fixed seed. */
function shuffle<T>(values: readonly T[]): T[] {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [out[index], out[other]] = [out[other] as T, out[index] as T];
  }
  return out;
}

/** Every run on a side must walk the same route, so series stay index-comparable across runs. */
function assertRunMatches(
  side: string,
  loaded: ILoaded,
  canonical: ILoaded,
  metadata: (frames: readonly IFrame[]) => unknown,
): void {
  equal(loaded.capture.viewport, canonical.capture.viewport, `${side} run viewport`);
  equal(
    metadata(loaded.manifest.samePose),
    metadata(canonical.manifest.samePose),
    `${side} run same-pose coverage/poses`,
  );
  equal(
    metadata(loaded.manifest.walk),
    metadata(canonical.manifest.walk),
    `${side} run walk coverage/timing/poses`,
  );
}

/**
 * Two or more capture runs per side. Streaming arrival can miss a band in one run and not the next,
 * so a single capture is not evidence. The same-pose instrument still sees one run per side; every
 * run is carried into the walk bundle as its own anonymous series, and the private seal remembers
 * which arm and run each series is so the scorer can measure the reference's own run-to-run spread.
 */
export function buildWorldVisualBundle(
  beforeFiles: string | readonly string[],
  afterFiles: string | readonly string[],
  output: string,
): IWorldVisualBundle {
  const normalize = (value: string | readonly string[]): string[] =>
    typeof value === "string" ? [value] : [...value];
  const before = normalize(beforeFiles).map(loadCapture);
  const after = normalize(afterFiles).map(loadCapture);
  if (before.length === 0 || after.length === 0) fail("each side needs at least one capture run");
  const reference = before[0] as ILoaded;
  const candidate = after[0] as ILoaded;
  for (const key of ["world", "route", "seed", "nearBandMeters", "landmarks"] as const)
    equal(reference.manifest[key], candidate.manifest[key], key);
  equal(reference.capture.viewport, candidate.capture.viewport, "viewport");
  const metadata = (frames: readonly IFrame[]) => frames.map(({ image: _image, ...rest }) => rest);
  equal(
    metadata(reference.manifest.samePose),
    metadata(candidate.manifest.samePose),
    "same-pose coverage/poses",
  );
  equal(
    metadata(reference.manifest.walk),
    metadata(candidate.manifest.walk),
    "walk coverage/timing/poses",
  );
  // Every run on a side must walk the same route, so series stay index-comparable across runs.
  for (const loaded of before) assertRunMatches("before", loaded, reference, metadata);
  for (const loaded of after) assertRunMatches("after", loaded, candidate, metadata);
  const out = path.resolve(output);
  if (existsSync(out) && readdirSync(out).length !== 0)
    fail("output must be empty; score an existing bundle with --score");
  const blind = path.join(out, "blind");
  mkdirSync(blind, { recursive: true });
  const prompt = `${readFileSync(BASELINE, "utf8")}\n\n${readFileSync(RUBRIC, "utf8")}`;
  const promptFile = path.join(blind, "rubric.md");
  writeFileSync(promptFile, prompt);
  const staging = path.join(out, "staging");
  for (const arm of ["before", "after"]) mkdirSync(path.join(staging, arm), { recursive: true });
  // visual-ab has a public deterministic shuffle. Secretly swapping its two input arms prevents
  // its shuffle seed/order from revealing which arm is the candidate; restore only private reveal.
  const swap = randomInt(2) === 1;
  const names = reference.manifest.samePose.map(() => randomBytes(12).toString("hex"));
  for (const [arm, loaded] of [
    ["before", reference],
    ["after", candidate],
  ] as const) {
    const directory = swap ? (arm === "before" ? "after" : "before") : arm;
    loaded.manifest.samePose.forEach((frame, index) =>
      writeFileSync(
        path.join(staging, directory, `${names[index]}.png`),
        readFileSync(frame.image),
      ),
    );
  }
  const poses = buildVisualAbBundle(
    path.join(staging, "before"),
    path.join(staging, "after"),
    path.join(out, "poses"),
    promptFile,
    Math.min(2, names.length),
  );
  if (swap) {
    const reveal = json(poses.reveal) as { arm: string; id: string; label: string }[];
    write(
      poses.reveal,
      reveal.map((entry) => ({
        ...entry,
        arm: entry.arm.replace(
          /::(before|after)/u,
          (_, arm: string) => `::${arm === "before" ? "after" : "before"}`,
        ),
      })),
    );
  }
  renameSync(poses.bundle, path.join(blind, "poses"));
  rmSync(staging, { recursive: true });
  const imageEntry = (label: string, image: string): IBlindImage => ({
    label,
    image,
    sha256: hash(path.join(blind, image)),
  });
  const poseBundle = json(path.join(blind, "poses", "bundle.json")) as {
    samples: { label: string; image: string }[];
  };
  const samePose = poseBundle.samples.map(({ label, image }) =>
    imageEntry(label, `poses/${image}`),
  );
  const runs: { arm: "before" | "after"; run: number; loaded: ILoaded }[] = [
    ...before.map((loaded, run) => ({ arm: "before" as const, run, loaded })),
    ...after.map((loaded, run) => ({ arm: "after" as const, run, loaded })),
  ];
  const walkArtifacts = runs.flatMap(({ loaded }, runIndex) =>
    loaded.manifest.walk.map((frame, index) => ({
      arm: `${runIndex}:${index}`,
      id: `${runIndex}:${index}`,
      content: readFileSync(frame.image),
    })),
  );
  const walkRevealFile = path.join(out, "walk-reveal.json");
  createImageBlindBundle(
    sha256Text(prompt),
    walkArtifacts,
    path.join(blind, "walk"),
    walkRevealFile,
    randomBytes(24).toString("hex"),
    walkArtifacts.map(({ arm }) => arm),
  );
  const walkReveal = json(walkRevealFile) as { arm: string; label: string }[];
  const labels = new Map(walkReveal.map(({ arm, label }) => [arm, label]));
  const order = shuffle(runs.map((_run, index) => index));
  const walk = order.map(
    (runIndex, seriesIndex): ISeries => ({
      label: `series-${seriesIndex + 1}`,
      frames: (runs[runIndex] as { loaded: ILoaded }).loaded.manifest.walk.map((frame, index) => {
        const label = labels.get(`${runIndex}:${index}`) as string;
        return {
          ...imageEntry(`frame-${String(index + 1).padStart(3, "0")}`, `walk/${label}/image.png`),
          timeMs: frame.timeMs as number,
          position: frame.position,
          target: frame.target,
          distances: reference.manifest.landmarks.map((landmark) => ({
            landmark: landmark.id,
            meters: distance(frame.position, landmark.position),
          })),
        };
      }),
    }),
  );
  const boundFiles = [
    ...before.flatMap((run) => run.files),
    ...after.flatMap((run) => run.files),
    BASELINE,
    RUBRIC,
    promptFile,
    poses.reveal,
    walkRevealFile,
    path.join(blind, "poses/bundle.json"),
    path.join(blind, "walk/bundle.json"),
    ...samePose.map(({ image }) => path.join(blind, image)),
    ...walk.flatMap(({ frames }) => frames.map(({ image }) => path.join(blind, image))),
  ];
  const content: Omit<IBundle, "evidenceSha256"> = {
    schemaVersion: 1,
    promptSha256: sha256Text(prompt),
    nearBandMeters: reference.manifest.nearBandMeters,
    landmarks: reference.manifest.landmarks,
    samePose,
    walk,
  };
  const seal: ISeal = {
    bundleContentSha256: sha256Text(JSON.stringify(content)),
    files: [...new Set(boundFiles)].map((file) => ({ file, sha256: hash(file) })),
    series: order.map((runIndex, seriesIndex) => ({
      label: `series-${seriesIndex + 1}`,
      arm: (runs[runIndex] as { arm: "before" | "after" }).arm,
      run: (runs[runIndex] as { run: number }).run,
    })),
    poseNames: Object.fromEntries(
      names.map((name, index) => [name, reference.manifest.samePose[index]?.id as string]),
    ),
    adapters: {
      before: before.map((run) => run.capture.adapter),
      after: after.map((run) => run.capture.adapter),
    },
  };
  const sealFile = path.join(out, "seal.json");
  write(sealFile, seal);
  const bundle: IBundle = { ...content, evidenceSha256: hash(sealFile) };
  const bundleFile = path.join(blind, "bundle.json");
  write(bundleFile, bundle);
  return { bundle: blind, bundleSha256: hash(bundleFile) };
}

function poppingVerdict(
  value: Record<string, unknown>,
  bundle: IBundle,
  seal: ISeal,
  critic: string,
): IPoppingEvent[] {
  const series = list(value.series, "verdict series");
  equal(
    series.map((raw) => record(raw, "series").label).sort(),
    bundle.walk.map(({ label }) => label).sort(),
    "series coverage",
  );
  const readEvent = (
    raw: unknown,
    allowed: readonly IPoppingEvent["kind"][],
    from: string,
    to: string,
    label: string,
  ): IPoppingEvent => {
    const event = record(raw, "event");
    const kind = text(event.kind, "event kind");
    if (!allowed.includes(kind as IPoppingEvent["kind"])) fail(`unsupported event kind: ${kind}`);
    const sealed = seal.series.find((entry) => entry.label === label);
    if (sealed === undefined) fail(`verdict names an unknown series: ${label}`);
    const candidate = sealed.arm === "after";
    const distanceMeters = finite(event.distanceMeters, "event distanceMeters");
    return {
      critic,
      series: label,
      from,
      to,
      element: text(event.element, "event element"),
      kind: kind as IPoppingEvent["kind"],
      distanceMeters,
      description: text(event.description, "event description"),
      candidate,
      // Content the candidate never draws is a regression at any distance; a pop is judged by its band.
      disallowed: candidate && (kind === "missing" || distanceMeters <= bundle.nearBandMeters),
    };
  };
  return series.flatMap((raw) => {
    const entry = record(raw, "series");
    const label = text(entry.label, "series label");
    const found = (bundle.walk.find((item) => item.label === label) as ISeries).frames;
    const transitions = list(entry.transitions, "transitions");
    const expected = found.slice(1).map((frame, index) => [found[index]?.label, frame.label]);
    equal(
      transitions.map((raw) => {
        const t = record(raw, "transition");
        return [t.from, t.to];
      }),
      expected,
      "chronological transition coverage",
    );
    const pops = transitions.flatMap((raw) => {
      const transition = record(raw, "transition");
      return list(transition.events, "events (use [] when none)", 0).map((raw) =>
        readEvent(
          raw,
          ["appear", "disappear", "lod-swap"],
          transition.from as string,
          transition.to as string,
          label,
        ),
      );
    });
    // Content that never appears produces no transition: the same walk index in the other series is
    // the only place its absence can be seen.
    const other = (bundle.walk.find((item) => item.label !== label) as ISeries).frames;
    return [
      ...pops,
      ...list(entry.missing, "missing (use [] when none)", 0).map((raw) => {
        const event = record(raw, "missing event");
        const from = text(event.from, "missing from");
        const to = text(event.to, "missing to");
        if (other.findIndex((frame) => frame.label === from) < 0)
          fail("missing from must be the other series' frame at that walk index");
        if (
          found.findIndex((frame) => frame.label === to) !==
          other.findIndex((frame) => frame.label === from)
        )
          fail("a missing event must name both series' frames at one walk index");
        return readEvent(event, ["missing"], from, to, label);
      }),
    ];
  });
}

/** Same transition, kind and element: frame labels are index-based and shared across runs. */
function runSpreadKey(event: IPoppingEvent): string {
  return `${event.from}|${event.to}|${event.kind}|${event.element}`;
}

/**
 * Streaming arrival makes the same element miss a band in one run and not the next. A regression
 * only counts when it is outside the reference's own run-to-run spread:
 * the same critic reports it in every candidate run and in no reference run. With fewer than two
 * runs per side there is no spread to measure, so the strict single-run rule applies. Partial
 * candidate-only reports remain visible as intermittent events needing more evidence.
 */
export function applyReferenceSpread(
  events: readonly IPoppingEvent[],
  seal: ISeal,
  nearBandMeters: number,
): { popping: IPoppingEvent[]; intermittent: IIntermittentEvent[] } {
  const candidateRunCount = seal.series.filter((entry) => entry.arm === "after").length;
  const referenceRunCount = seal.series.filter((entry) => entry.arm === "before").length;
  const multiRun = candidateRunCount >= 2 && referenceRunCount >= 2;
  const runBySeries = new Map(seal.series.map((entry) => [entry.label, entry.run]));
  const failWorthy = (event: IPoppingEvent): boolean =>
    event.candidate && (event.kind === "missing" || event.distanceMeters <= nearBandMeters);
  const allowed = new Map<IPoppingEvent, boolean>();
  const intermittent: IIntermittentEvent[] = [];
  for (const event of events) {
    if (!event.candidate) continue;
    if (!multiRun) {
      allowed.set(event, false);
      continue;
    }
    const key = runSpreadKey(event);
    const matching = events.filter(
      (other) => other.critic === event.critic && runSpreadKey(other) === key,
    );
    const candidateRuns = new Set(
      matching.filter((other) => other.candidate).map((other) => runBySeries.get(other.series)),
    ).size;
    const referenceRuns = new Set(
      matching.filter((other) => !other.candidate).map((other) => runBySeries.get(other.series)),
    ).size;
    if (candidateRuns < candidateRunCount && referenceRuns === 0)
      intermittent.push({
        critic: event.critic,
        series: event.series,
        kind: event.kind,
        distanceMeters: event.distanceMeters,
        candidateRuns,
        referenceRuns,
      });
    const runsShowing = new Set(
      matching
        .filter((other) => failWorthy(other))
        .map((other) => runBySeries.get(other.series) as number),
    );
    allowed.set(event, runsShowing.size < candidateRunCount || referenceRuns > 0);
  }
  return {
    popping: events.map((event) => ({
      ...event,
      disallowed: failWorthy(event) && !(allowed.get(event) ?? false),
    })),
    intermittent,
  };
}

export function scoreWorldVisualBundle(
  output: string,
  verdictFiles: readonly string[],
  allowIntermittent = false,
): IWorldVisualScore {
  if (verdictFiles.length !== 3) fail("exactly three independent verdict files are required");
  unique(
    verdictFiles.map((file) => realpathSync(file)),
    "critic file paths",
  );
  const out = path.resolve(output);
  const bundleFile = path.join(out, "blind/bundle.json");
  const bundle = json(bundleFile) as IBundle;
  const sealFile = path.join(out, "seal.json");
  if (bundle.evidenceSha256 !== hash(sealFile)) fail("private evidence seal changed");
  const seal = json(sealFile) as ISeal;
  const { evidenceSha256: _evidenceSha256, ...content } = bundle;
  if (sha256Text(JSON.stringify(content)) !== seal.bundleContentSha256)
    fail("public bundle metadata changed");
  for (const { file, sha256 } of seal.files)
    if (hash(file) !== sha256) fail(`bound artifact changed: ${file}`);
  const bundleSha256 = hash(bundleFile);
  const verdicts = verdictFiles.map((file) => record(json(file), "verdict"));
  unique(
    verdicts.map((verdict) => text(verdict.critic, "critic identity").trim().toLowerCase()),
    "critic identities",
  );
  const reported = verdicts.flatMap((value) => {
    if (value.bundleSha256 !== bundleSha256 || value.promptSha256 !== bundle.promptSha256)
      fail("verdict does not bind this bundle and rubric");
    const samples = list(value.samples, "samples");
    equal(
      samples.map((raw) => record(raw, "sample").label).sort(),
      bundle.samePose.map(({ label }) => label).sort(),
      "same-pose verdict coverage",
    );
    return poppingVerdict(value, bundle, seal, text(value.critic, "critic"));
  });
  const { popping, intermittent } = applyReferenceSpread(reported, seal, bundle.nearBandMeters);
  const samePose = scoreVisualAb(path.join(out, "poses/reveal.json"), verdictFiles, 3);
  const regression =
    samePose.rows.some((row) => row.after < VISUAL_FLOOR || row.classification === "LOSS") ||
    popping.some(({ disallowed }) => disallowed);
  const inconclusive =
    !regression &&
    !allowIntermittent &&
    intermittent.some(
      (event) =>
        event.distanceMeters <= bundle.nearBandMeters ||
        event.kind === "missing" ||
        event.kind === "disappear",
    );
  return {
    exitCode: regression ? 1 : inconclusive ? 2 : 0,
    verdict: regression ? "regression" : inconclusive ? "inconclusive" : "pass",
    ...(inconclusive ? { reason: "needs more runs" as const } : {}),
    bundleSha256,
    samePose: {
      ...samePose,
      rows: samePose.rows.map((row) => ({
        ...row,
        template: seal.poseNames[row.template] as string,
      })),
    },
    popping,
    intermittent,
    adapters: seal.adapters,
    verdicts: verdictFiles.map((file) => ({ file: path.resolve(file), sha256: hash(file) })),
  };
}

function cliOptions(args: readonly string[]): Map<string, string[]> {
  const options = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i] as string;
    if (key === "--allow-intermittent") {
      if (options.has(key)) fail(`duplicate option ${key}`);
      options.set(key, []);
      continue;
    }
    const value = args[++i];
    if (
      !["--before", "--after", "--out", "--score", "--verdict"].includes(key) ||
      !value ||
      value.startsWith("--")
    )
      fail(
        "Usage: --before <manifest> [--before <manifest> ...] --after <manifest> [--after <manifest> ...] --out <new-dir> | --score <dir> --verdict <file> (exactly three times) [--allow-intermittent]",
      );
    if (!["--before", "--after", "--verdict"].includes(key) && options.has(key))
      fail(`duplicate option ${key}`);
    options.set(key, [...(options.get(key) ?? []), value]);
  }
  return options;
}

export function runCli(args: readonly string[]): number {
  try {
    const options = cliOptions(args);
    const scoring = options.get("--score")?.[0];
    if (scoring !== undefined) {
      if (["--before", "--after", "--out"].some((key) => options.has(key)))
        fail("score an existing bundle without rebuilding it");
      rmSync(path.join(scoring, "score.json"), { force: true });
      const result = scoreWorldVisualBundle(
        scoring,
        options.get("--verdict") ?? [],
        options.has("--allow-intermittent"),
      );
      write(path.join(scoring, "score.json"), result);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.exitCode;
    }
    const before = options.get("--before") ?? [];
    const after = options.get("--after") ?? [];
    const out = options.get("--out")?.[0];
    if (
      before.length === 0 ||
      after.length === 0 ||
      !out ||
      options.has("--verdict") ||
      options.has("--allow-intermittent")
    )
      fail(
        "bundle first with --before <manifest> --after <manifest> --out <new-dir>; then use --score",
      );
    const built = buildWorldVisualBundle(before, after, out);
    process.stdout.write(
      `${JSON.stringify({ ...built, verdict: "unjudged", exitCode: 2 }, null, 2)}\n`,
    );
    return 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = runCli(process.argv.slice(2));
