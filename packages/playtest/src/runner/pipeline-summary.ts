/** Shared parser and aggregation for browser pipeline censuses and native pipeline markers. */

export const PIPELINE_CAPTURE_VERSION = 1 as const;
export const PIPELINE_EVENT_MARKER = "TN_PIPELINE_EVENT:";
const PIPELINE_CAPTURE_MARKER = "TN_PIPELINE_CAPTURE:";
const PIPELINE_FIRST_PRESENT_MARKER = "TN_PIPELINE_FIRST_PRESENT:";
const PIPELINE_COMPLETE_MARKER = "TN_PIPELINE_COMPLETE:";
const PIPELINE_CHECKPOINT_MARKER = "TN_PIPELINE_CHECKPOINT:";

export type PipelineCaptureSource = "browser" | "native";
export type PipelineCaptureKind = "compute" | "render";
export type PipelineCaptureMode = "sync" | "async";
export type PipelineCaptureStatus = "created" | "failed" | "pending";

export interface IPipelineCaptureShader {
  readonly bytes: number;
  readonly hash: string;
}

export interface IPipelineCaptureProvenance {
  readonly material?: { readonly id?: number; readonly name?: string; readonly type?: string };
  readonly object?: { readonly id?: number; readonly name?: string; readonly uuid?: string };
  readonly unknown: boolean;
}

export interface IPipelineCaptureEvent {
  readonly sequence: number;
  readonly programIdentity: string;
  readonly pipelineIdentity: string;
  readonly kind: PipelineCaptureKind;
  readonly pass: string;
  readonly mode: PipelineCaptureMode;
  readonly status: PipelineCaptureStatus;
  readonly vertex?: IPipelineCaptureShader;
  readonly fragment?: IPipelineCaptureShader;
  readonly compute?: IPipelineCaptureShader;
  readonly provenance: IPipelineCaptureProvenance;
  readonly reasons: readonly string[];
  readonly startedMs: number;
  readonly settledMs?: number;
  readonly serviceMs?: number;
  readonly promiseMs?: number;
  readonly queueMs?: number;
  readonly wallMs?: number;
  readonly label?: string;
  readonly error?: string;
  readonly nodeBuilds?: number;
  readonly beforeFirstPresent?: boolean;
  readonly beforeWarmUpSettled?: boolean;
  readonly afterWarmUpScope?: string;
}

export interface IPipelineCaptureNodeBuild {
  readonly provenance: IPipelineCaptureProvenance;
  readonly startedMs: number;
  readonly beforeFirstPresent?: boolean;
  readonly beforeWarmUpSettled?: boolean;
  readonly afterWarmUpScope?: string;
}

export interface IPipelineCaptureCounts {
  readonly lookups: number;
  readonly creations: number;
  readonly failures: number;
  readonly pending: number;
  readonly uniquePrograms: number;
  readonly uniquePipelines: number;
  readonly recordedEvents: number;
  readonly droppedEvents: number;
  readonly nodeBuilds?: number;
}

/**
 * What ended the capture, and therefore what "complete" is allowed to mean.
 *
 * `finalized` is a process that exited: the host drained its compile pool and printed a final
 * count. `checkpoint` is a live snapshot from a present, which is all a run ended by
 * `am force-stop` can produce — every event up to that present is accounted for and nothing was
 * still compiling, and the capture claims nothing about the run after it.
 */
export interface IPipelineCaptureBoundary {
  readonly kind: "checkpoint" | "finalized";
  readonly events: number;
  readonly outstanding?: number;
  readonly present?: number;
}

export interface IPipelineCapture {
  readonly version: number;
  readonly source: PipelineCaptureSource;
  readonly boundary?: IPipelineCaptureBoundary;
  readonly complete: boolean;
  readonly overflowed: boolean;
  readonly backend?: Readonly<Record<string, unknown>>;
  readonly clock?: Readonly<Record<string, unknown>>;
  readonly build?: Readonly<Record<string, unknown>>;
  readonly adapter?: Readonly<Record<string, unknown>>;
  readonly firstPresent?: { readonly boundaryMs: number; readonly eventsSettled: number };
  readonly warmUpSettled?: {
    readonly boundaryMs: number;
    readonly eventsSettled: number;
    readonly nodeBuilds: number;
    readonly renderPipelineCreations: number;
  };
  readonly warmUpScopes?: readonly {
    readonly label: string;
    readonly boundaryMs: number;
    readonly eventsSettled: number;
    readonly nodeBuilds: number;
    readonly renderPipelineCreations: number;
    readonly firstDraw?: {
      readonly nodeBuilds: number;
      readonly renderPipelineCreations: number;
    };
  }[];
  readonly counts: IPipelineCaptureCounts;
  readonly events: readonly IPipelineCaptureEvent[];
  readonly nodeBuilds?: readonly IPipelineCaptureNodeBuild[];
  readonly incompleteReasons: readonly string[];
}

export interface IPipelinePassSummary {
  readonly creations: number;
  readonly failures: number;
  readonly beforeFirstPresent: number;
  /** Sum of observed device-call service durations; absent when the driver did not expose them. */
  readonly serviceMs?: number;
  readonly serviceSamples: number;
  readonly pass: string;
}

export interface IPipelineContributorSummary {
  readonly afterWarmUpSettledCreations: number;
  readonly afterWarmUpSettledNodeBuilds: number;
  readonly creations: number;
  readonly failures: number;
  readonly label: string;
  readonly nodeBuilds: number;
  readonly sampleCount: number;
  /** Sum of observed device-call service durations; absent when the driver did not expose them. */
  readonly serviceMs?: number;
}

export interface IPipelineProgramReasonSummary {
  readonly creations: number;
  readonly programIdentity: string;
  readonly reasons: readonly string[];
}

export interface IPipelineSizeTimePassSummary {
  readonly meanBytes: number;
  readonly meanServiceMs: number;
  readonly pass: string;
  readonly samples: number;
}

export interface IPipelineSizeTimeSummary {
  readonly byPass: readonly IPipelineSizeTimePassSummary[];
  readonly samples: number;
  readonly statement: string;
}

export interface IPipelineWarmupSummary {
  readonly afterFirstPresent: number;
  readonly afterWarmUpSettled: number;
  readonly beforeFirstPresent: number;
  readonly eventsSettledAtFirstPresent?: number;
  readonly eventsSettledAtWarmUpSettled?: number;
  readonly nodeBuildsAfterWarmUpSettled?: number;
  readonly renderPipelineCreationsAfterWarmUpSettled?: number;
  /** Post-boundary work attributed to material contributors already observed during warm-up. */
  readonly warmedNodeBuildsAfterWarmUpSettled?: number;
  readonly warmedRenderPipelineCreationsAfterWarmUpSettled?: number;
  readonly total: number;
  readonly unreported: number;
  readonly scopes: readonly {
    readonly label: string;
    readonly nodeBuilds: number;
    readonly renderPipelineCreations: number;
    readonly observed?: boolean;
  }[];
}

export interface IPipelineSummary {
  readonly adapter?: Readonly<Record<string, unknown>>;
  readonly boundary?: IPipelineCaptureBoundary;
  readonly build?: Readonly<Record<string, unknown>>;
  readonly complete: boolean;
  readonly counts: IPipelineCaptureCounts;
  readonly contributors: readonly IPipelineContributorSummary[];
  readonly incompleteReasons: readonly string[];
  readonly passTotals: readonly IPipelinePassSummary[];
  readonly programReasons: readonly IPipelineProgramReasonSummary[];
  readonly sizeTime: IPipelineSizeTimeSummary;
  readonly source: PipelineCaptureSource;
  readonly warmup: IPipelineWarmupSummary;
}

type JsonRecord = Record<string, unknown>;

/** The three counts a live host keeps apart, as printed by `reportPipelineCheckpoint`. */
interface INativeCheckpoint {
  readonly emitted: number;
  readonly outstanding: number;
  readonly present: number;
  readonly requested: number;
}

interface INativeMarkerCapture {
  readonly adapter?: Readonly<Record<string, unknown>>;
  readonly build?: Readonly<Record<string, unknown>>;
  readonly checkpoint?: INativeCheckpoint;
  readonly clock?: Readonly<Record<string, unknown>>;
  readonly events: readonly IPipelineCaptureEvent[];
  /** Distinct event lines that arrived after the last checkpoint, which bounds the capture. */
  readonly eventsAfterCheckpoint: number;
  readonly expectedEventCount?: number;
  readonly firstPresentBoundaryMs?: number;
}

type NativeMarkerLine =
  | { readonly kind: "capture"; readonly value: unknown }
  | { readonly kind: "checkpoint"; readonly value: unknown }
  | { readonly kind: "complete"; readonly value: unknown }
  | { readonly kind: "event"; readonly value: unknown }
  | { readonly kind: "first-present"; readonly value: unknown };

/** Parse a capture file, either as a JSON browser census or a native log containing markers. */
export function parsePipelineCapture(input: string | unknown): IPipelineCapture {
  if (typeof input === "string") return parseCaptureDocument(input);
  const root = asRecord(input);
  if (root === undefined) throw malformed("capture must be an object");
  if (root.nativeLog !== undefined) {
    if (root.version !== PIPELINE_CAPTURE_VERSION || typeof root.nativeLog !== "string")
      throw malformed("paired capture requires version 1 and a nativeLog string");
    const renderer = parsePipelineCapture(root.census);
    const native = nativeCapture(parseNativeMarkerCapture(root.nativeLog));
    return reconcilePipelineCaptures(renderer, native);
  }
  const observations = asRecord(root.observations);
  const nested = firstDefinedRecord(
    root.pipelineCensus,
    root.census,
    observations?.pipelineCensus,
    root.capture,
  );
  const value = nested ?? root;
  if (value.version === undefined) throw malformed("capture is missing its version");
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) {
    throw malformed("capture version must be an integer");
  }
  if (value.version !== PIPELINE_CAPTURE_VERSION) {
    return unsupportedCapture(value.version, value);
  }
  return parseBrowserCapture(value);
}

/**
 * Read the bytes of a capture file as the document they are, JSON before markers.
 *
 * A paired capture carries its native log as one escaped JSON string, so `TN_PIPELINE_*` occurs
 * inside a quoted field where it is text rather than a marker line. Sniffing markers first found
 * those and threw on the escaping before the file was ever parsed as what it is, which is why
 * `doctor --capture paired.json` exited 2 on a well-formed file. Nothing is lost by the order:
 * every line of a native log begins with its marker, so a log is never valid JSON, and a log whose
 * own marker lines are malformed still throws from the reader below.
 */
function parseCaptureDocument(text: string): IPipelineCapture {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    const native = parseNativeMarkerCapture(text);
    if (native.events.length === 0)
      throw malformed(`input is neither JSON nor a native event log (${errorMessage(error)})`);
    return nativeCapture(native);
  }
  return parsePipelineCapture(document);
}

/** A paired file must contain observations from the same native process and capture interval. */
function reconcilePipelineCaptures(renderer: IPipelineCapture, native: IPipelineCapture): IPipelineCapture {
  const byHandle = new Map<string, IPipelineCaptureEvent>();
  for (const event of renderer.events) {
    if (byHandle.has(event.pipelineIdentity)) throw malformed(`duplicate renderer pipeline ${event.pipelineIdentity}`);
    byHandle.set(event.pipelineIdentity, event);
  }
  const events = native.events.map((event) => {
    const observed = byHandle.get(event.pipelineIdentity);
    // Texture utilities and host-owned draws can create pipelines outside Three's render-object
    // walk. Keep that work in the native total with its explicit unknown provenance.
    if (observed === undefined) return event;
    byHandle.delete(event.pipelineIdentity);
    if (observed.kind !== event.kind || observed.status !== event.status || observed.mode !== event.mode)
      throw malformed(`pipeline creation mismatch for ${event.pipelineIdentity}`);
    for (const stage of ["vertex", "fragment", "compute"] as const) {
      const expected = observed[stage];
      const actual = event[stage];
      if (expected?.hash !== actual?.hash || expected?.bytes !== actual?.bytes)
        throw malformed(`shader ${stage} mismatch for ${event.pipelineIdentity}`);
    }
    // Native owns the clock, completion boundary and service time. Renderer-side wrapper or
    // promise latency must not replace those measurements when adding authoring provenance.
    return { ...event, pass: observed.pass, provenance: observed.provenance, reasons: observed.reasons };
  });
  if (byHandle.size > 0) throw malformed(`unmatched renderer pipeline ${byHandle.keys().next().value}`);
  const incompleteReasons = [...native.incompleteReasons, ...renderer.incompleteReasons];
  return {
    ...native, events, complete: native.complete && renderer.complete,
    counts: { ...native.counts, lookups: renderer.counts.lookups },
    overflowed: native.overflowed || renderer.overflowed, incompleteReasons,
  };
}

/** Parse only native marker lines, preserving the same malformed-input contract as perf. */
export function parsePipelineEventMarkers(text: string): IPipelineCaptureEvent[] {
  return [...parseNativeMarkerCapture(text).events];
}

function parseNativeMarkerCapture(text: string): INativeMarkerCapture {
  const state: INativeMarkerState = { events: [], eventsAfterCheckpoint: 0, seen: new Map<number, string>() };
  for (const line of text.split("\n")) {
    const marker = parseNativeMarkerLine(line);
    if (marker === undefined) continue;
    consumeNativeMarker(state, marker);
  }
  if (
    state.checkpoint !== undefined &&
    state.expectedEventCount !== undefined &&
    state.checkpoint.requested > state.expectedEventCount
  ) {
    // The finalizer prints the request ids it handed out, and a checkpoint can only have seen a
    // prefix of them. A checkpoint ahead of the final count means the two disagree about the run.
    throw malformed(
      `a native pipeline checkpoint requested ${state.checkpoint.requested}, past the completion marker's ${state.expectedEventCount}`,
    );
  }
  return {
    ...(state.adapter === undefined ? {} : { adapter: state.adapter }),
    ...(state.build === undefined ? {} : { build: state.build }),
    ...(state.checkpoint === undefined ? {} : { checkpoint: state.checkpoint }),
    ...(state.clock === undefined ? {} : { clock: state.clock }),
    events: state.events.sort((left, right) => left.sequence - right.sequence),
    eventsAfterCheckpoint: state.eventsAfterCheckpoint,
    ...(state.expectedEventCount === undefined ? {} : { expectedEventCount: state.expectedEventCount }),
    ...(state.firstPresentBoundaryMs === undefined
      ? {}
      : { firstPresentBoundaryMs: state.firstPresentBoundaryMs }),
  };
}

interface INativeMarkerState {
  readonly events: IPipelineCaptureEvent[];
  readonly seen: Map<number, string>;
  adapter?: Readonly<Record<string, unknown>>;
  build?: Readonly<Record<string, unknown>>;
  checkpoint?: INativeCheckpoint;
  clock?: Readonly<Record<string, unknown>>;
  eventsAfterCheckpoint: number;
  expectedEventCount?: number;
  firstPresentBoundaryMs?: number;
}

function consumeNativeMarker(state: INativeMarkerState, marker: NativeMarkerLine): void {
  if (marker.kind === "capture") {
    consumeNativeCaptureMetadata(state, marker.value);
    return;
  }
  if (marker.kind === "first-present") {
    consumeNativeFirstPresent(state, marker.value);
    return;
  }
  if (marker.kind === "complete") {
    consumeNativeCompletion(state, marker.value);
    return;
  }
  if (marker.kind === "checkpoint") {
    consumeNativeCheckpoint(state, marker.value);
    return;
  }
  consumeNativeEvent(state, marker.value);
}

function consumeNativeCaptureMetadata(state: INativeMarkerState, value: unknown): void {
  validateCaptureVersion(value, "native pipeline capture metadata");
  const metadata = nativeCaptureMetadata(value);
  if (state.build !== undefined || state.adapter !== undefined || state.clock !== undefined)
    throw malformed("native pipeline capture metadata appears more than once");
  state.build = metadata.build;
  state.adapter = metadata.adapter;
  state.clock = metadata.clock;
}

function consumeNativeFirstPresent(state: INativeMarkerState, value: unknown): void {
  validateCaptureVersion(value, "native first-present metadata");
  const metadata = asRecord(value);
  const boundaryMs = nonNegativeNumber(metadata?.boundaryMs, "native first-present boundaryMs");
  if (state.firstPresentBoundaryMs !== undefined && state.firstPresentBoundaryMs !== boundaryMs)
    throw malformed("native first-present metadata appears with conflicting boundaries");
  state.firstPresentBoundaryMs = boundaryMs;
}

function consumeNativeCompletion(state: INativeMarkerState, value: unknown): void {
  validateCaptureVersion(value, "native completion metadata");
  const metadata = asRecord(value);
  const eventCount = nonNegativeInteger(metadata?.eventCount, "native completion eventCount");
  if (state.expectedEventCount !== undefined && state.expectedEventCount !== eventCount)
    throw malformed("native completion metadata appears with conflicting event counts");
  state.expectedEventCount = eventCount;
}

/**
 * Keeps the last checkpoint, and only while the host's own counts hold together.
 *
 * The three numbers are maintained separately by the host — ids handed out, lines written,
 * compiles in flight — so `requested === emitted + outstanding` is a real check rather than a
 * restatement, and a host that has lost track of its own capture is malformed input, not a capture
 * to be read leniently. Checkpoints only ever move forward; one that walks back means two runs'
 * output landed in one log.
 *
 * The counts are also checked against where the checkpoint sits in the log. `emitted` is
 * incremented under the same lock that writes an event line, so every line it counts precedes it;
 * a checkpoint carrying fewer than the log has already shown is the same contradiction as one that
 * walks back. Carrying more is a log that was cut, which `nativeBoundaryReasons` reports as
 * incomplete rather than throwing.
 */
function consumeNativeCheckpoint(state: INativeMarkerState, value: unknown): void {
  validateCaptureVersion(value, "native pipeline checkpoint");
  const metadata = asRecord(value);
  const checkpoint: INativeCheckpoint = {
    emitted: nonNegativeInteger(metadata?.emitted, "native checkpoint emitted"),
    outstanding: nonNegativeInteger(metadata?.outstanding, "native checkpoint outstanding"),
    present: nonNegativeInteger(metadata?.present, "native checkpoint present"),
    requested: nonNegativeInteger(metadata?.requested, "native checkpoint requested"),
  };
  if (checkpoint.requested !== checkpoint.emitted + checkpoint.outstanding) {
    throw malformed(
      `native pipeline checkpoint counts do not reconcile: ${checkpoint.requested} requested against ${checkpoint.emitted} emitted and ${checkpoint.outstanding} outstanding`,
    );
  }
  const previous = state.checkpoint;
  if (
    previous !== undefined &&
    (checkpoint.present < previous.present ||
      checkpoint.requested < previous.requested ||
      checkpoint.emitted < previous.emitted)
  ) {
    throw malformed("a native pipeline checkpoint reports fewer than the one before it");
  }
  // Distinct events consumed so far, never the highest id seen: async compiles settle in whatever
  // order the pool finishes them, so ids arrive out of order and the last one is not a count.
  if (checkpoint.emitted < state.events.length) {
    throw malformed(
      `a native pipeline checkpoint counted ${checkpoint.emitted} event(s) after ${state.events.length} had already been written`,
    );
  }
  state.checkpoint = checkpoint;
  state.eventsAfterCheckpoint = 0;
}

function consumeNativeEvent(state: INativeMarkerState, value: unknown): void {
  validateCaptureVersion(value, "native pipeline event");
  const event = normaliseNativeEvent(value);
  const existing = state.seen.get(event.sequence);
  const serialised = JSON.stringify(value);
  if (existing !== undefined) {
    if (existing !== serialised) throw malformed(`event ${event.sequence} appears with conflicting payloads`);
    return;
  }
  state.seen.set(event.sequence, serialised);
  state.events.push(event);
  if (state.checkpoint !== undefined) state.eventsAfterCheckpoint += 1;
}

function parseNativeMarkerLine(line: string): NativeMarkerLine | undefined {
  const candidates: Array<{ readonly at: number; readonly kind: NativeMarkerLine["kind"]; readonly marker: string }> = [
    { at: line.indexOf(PIPELINE_CAPTURE_MARKER), kind: "capture", marker: PIPELINE_CAPTURE_MARKER },
    { at: line.indexOf(PIPELINE_CHECKPOINT_MARKER), kind: "checkpoint", marker: PIPELINE_CHECKPOINT_MARKER },
    { at: line.indexOf(PIPELINE_COMPLETE_MARKER), kind: "complete", marker: PIPELINE_COMPLETE_MARKER },
    { at: line.indexOf(PIPELINE_FIRST_PRESENT_MARKER), kind: "first-present", marker: PIPELINE_FIRST_PRESENT_MARKER },
    { at: line.indexOf(PIPELINE_EVENT_MARKER), kind: "event", marker: PIPELINE_EVENT_MARKER },
  ];
  const candidate = candidates
    .filter(({ at }) => at !== -1)
    .sort((left, right) => left.at - right.at)[0];
  if (candidate === undefined) return undefined;
  const payload = line.slice(candidate.at + candidate.marker.length).trim();
  try {
    return { kind: candidate.kind, value: JSON.parse(payload) as unknown };
  } catch (error) {
    throw malformed(`a ${candidate.marker.slice(0, -1)} line carries invalid JSON (${payload.slice(0, 100)}): ${errorMessage(error)}`);
  }
}

export function summarizePipelineCapture(capture: IPipelineCapture): IPipelineSummary {
  const passMap = new Map<string, { creations: number; failures: number; beforeFirstPresent: number; serviceMs: number; serviceSamples: number }>();
  const contributorMap = new Map<string, IPipelineContributorSummary>();
  const programMap = new Map<string, { creations: number; reasons: Set<string> }>();
  const sizeMap = new Map<string, { bytes: number; serviceMs: number; samples: number }>();
  let beforeFirstPresent = 0;
  let afterFirstPresent = 0;
  let afterWarmUpSettled = 0;
  let renderPipelineCreationsAfterWarmUpSettled = 0;
  let warmedNodeBuildsAfterWarmUpSettled = 0;
  let warmedRenderPipelineCreationsAfterWarmUpSettled = 0;
  const scopeMap = new Map<
    string,
    { nodeBuilds: number; renderPipelineCreations: number; observed?: boolean }
  >();
  const measuredScopeLabels = new Set<string>();
  for (const scope of capture.warmUpScopes ?? []) {
    const previous = scopeMap.get(scope.label);
    if (scope.firstDraw !== undefined) measuredScopeLabels.add(scope.label);
    scopeMap.set(scope.label, {
      nodeBuilds: Math.max(previous?.nodeBuilds ?? 0, scope.firstDraw?.nodeBuilds ?? 0),
      renderPipelineCreations: Math.max(
        previous?.renderPipelineCreations ?? 0,
        scope.firstDraw?.renderPipelineCreations ?? 0,
      ),
      ...(scope.firstDraw !== undefined && (previous === undefined || previous.observed === true)
        ? { observed: true }
        : {}),
    });
  }
  let unreported = 0;
  let sizeSamples = 0;
  const hasNodeBuildRecords = capture.nodeBuilds !== undefined;
  const warmedMaterialLabels =
    capture.warmUpSettled === undefined
      ? undefined
      : new Set<string>([
          capture.events
            .filter(({ beforeWarmUpSettled, provenance }) => beforeWarmUpSettled === true && provenance.material !== undefined)
            .map(contributorLabel),
          ...(capture.nodeBuilds ?? [])
            .filter(({ beforeWarmUpSettled, provenance }) => beforeWarmUpSettled === true && provenance.material !== undefined)
            .map(({ provenance }) => contributorLabelOfProvenance(provenance)),
        ].flat());
  for (const event of capture.events) {
    const serviceMs = event.serviceMs;
    const previousPass = passMap.get(event.pass);
    passMap.set(event.pass, {
      creations: (previousPass?.creations ?? 0) + 1,
      failures: (previousPass?.failures ?? 0) + (event.status === "failed" ? 1 : 0),
      beforeFirstPresent: (previousPass?.beforeFirstPresent ?? 0) + (event.beforeFirstPresent === true ? 1 : 0),
      serviceMs: (previousPass?.serviceMs ?? 0) + (serviceMs ?? 0),
      serviceSamples: (previousPass?.serviceSamples ?? 0) + (serviceMs === undefined ? 0 : 1),
    });
    const label = contributorLabel(event);
    const previousContributor = contributorMap.get(label);
    contributorMap.set(label, {
      afterWarmUpSettledCreations:
        (previousContributor?.afterWarmUpSettledCreations ?? 0) +
        (event.beforeWarmUpSettled === false && event.status === "created" ? 1 : 0),
      afterWarmUpSettledNodeBuilds:
        (previousContributor?.afterWarmUpSettledNodeBuilds ?? 0) +
        (hasNodeBuildRecords || event.beforeWarmUpSettled !== false ? 0 : event.nodeBuilds ?? 0),
      label,
      creations: (previousContributor?.creations ?? 0) + 1,
      failures: (previousContributor?.failures ?? 0) + (event.status === "failed" ? 1 : 0),
      nodeBuilds: (previousContributor?.nodeBuilds ?? 0) +
        (hasNodeBuildRecords ? 0 : event.nodeBuilds ?? 0),
      sampleCount: (previousContributor?.sampleCount ?? 0) + (event.serviceMs === undefined ? 0 : 1),
      ...(serviceMs === undefined && previousContributor?.serviceMs === undefined
        ? {}
        : { serviceMs: (previousContributor?.serviceMs ?? 0) + (serviceMs ?? 0) }),
    });
    const previousProgram = programMap.get(event.programIdentity) ?? { creations: 0, reasons: new Set<string>() };
    previousProgram.creations += 1;
    for (const reason of event.reasons) previousProgram.reasons.add(reason);
    programMap.set(event.programIdentity, previousProgram);
    const bytes =
      event.kind === "render"
        ? event.vertex === undefined || event.fragment === undefined
          ? undefined
          : event.vertex.bytes + event.fragment.bytes
        : event.compute?.bytes;
    if (bytes !== undefined && event.serviceMs !== undefined) {
      sizeSamples += 1;
      const previousSize = sizeMap.get(event.pass) ?? { bytes: 0, serviceMs: 0, samples: 0 };
      previousSize.bytes += bytes;
      previousSize.serviceMs += event.serviceMs;
      previousSize.samples += 1;
      sizeMap.set(event.pass, previousSize);
    }
    if (event.beforeFirstPresent === true) beforeFirstPresent += 1;
    else if (event.beforeFirstPresent === false) afterFirstPresent += 1;
    else unreported += 1;
    if (event.beforeWarmUpSettled === false) {
      afterWarmUpSettled += 1;
      if (event.kind === "render" && event.status === "created")
        renderPipelineCreationsAfterWarmUpSettled += 1;
      if (warmedMaterialLabels?.has(label) === true) {
        if (!hasNodeBuildRecords) warmedNodeBuildsAfterWarmUpSettled += event.nodeBuilds ?? 0;
        if (event.kind === "render" && event.status === "created")
          warmedRenderPipelineCreationsAfterWarmUpSettled += 1;
      }
    }
    if (event.afterWarmUpScope !== undefined) {
      const scope = scopeMap.get(event.afterWarmUpScope) ?? {
        nodeBuilds: 0,
        renderPipelineCreations: 0,
      };
      if (!measuredScopeLabels.has(event.afterWarmUpScope)) {
        if (!hasNodeBuildRecords) scope.nodeBuilds += event.nodeBuilds ?? 0;
        if (event.kind === "render" && event.status === "created")
          scope.renderPipelineCreations += 1;
      }
      scopeMap.set(event.afterWarmUpScope, scope);
    }
  }
  for (const nodeBuild of capture.nodeBuilds ?? []) {
    const label = contributorLabelOfProvenance(nodeBuild.provenance);
    const previousContributor = contributorMap.get(label);
    contributorMap.set(label, {
      afterWarmUpSettledCreations: previousContributor?.afterWarmUpSettledCreations ?? 0,
      afterWarmUpSettledNodeBuilds:
        (previousContributor?.afterWarmUpSettledNodeBuilds ?? 0) +
        (nodeBuild.beforeWarmUpSettled === false ? 1 : 0),
      label,
      creations: previousContributor?.creations ?? 0,
      failures: previousContributor?.failures ?? 0,
      nodeBuilds: (previousContributor?.nodeBuilds ?? 0) + 1,
      sampleCount: previousContributor?.sampleCount ?? 0,
      ...(previousContributor?.serviceMs === undefined
        ? {}
        : { serviceMs: previousContributor.serviceMs }),
    });
    if (nodeBuild.beforeWarmUpSettled === false && warmedMaterialLabels?.has(label) === true)
      warmedNodeBuildsAfterWarmUpSettled += 1;
    if (nodeBuild.afterWarmUpScope !== undefined) {
      const scope = scopeMap.get(nodeBuild.afterWarmUpScope) ?? {
        nodeBuilds: 0,
        renderPipelineCreations: 0,
      };
      if (!measuredScopeLabels.has(nodeBuild.afterWarmUpScope)) scope.nodeBuilds += 1;
      scopeMap.set(nodeBuild.afterWarmUpScope, scope);
    }
  }
  const source = capture.source;
  const nodeBuildsAfterWarmUpSettled =
    capture.warmUpSettled === undefined || capture.counts.nodeBuilds === undefined
      ? undefined
      : capture.counts.nodeBuilds - capture.warmUpSettled.nodeBuilds;
  return {
    adapter: capture.adapter,
    ...(capture.boundary === undefined ? {} : { boundary: capture.boundary }),
    build: capture.build,
    complete: capture.complete,
    counts: capture.counts,
    contributors: [...contributorMap.values()].sort(compareContributor),
    incompleteReasons: capture.incompleteReasons,
    passTotals: [...passMap.entries()]
      .map(([pass, value]) => ({
        pass,
        creations: value.creations,
        failures: value.failures,
        beforeFirstPresent: value.beforeFirstPresent,
        serviceSamples: value.serviceSamples,
        ...(value.serviceSamples === 0 ? {} : { serviceMs: value.serviceMs }),
      }))
      .sort((left, right) => (right.serviceMs ?? -1) - (left.serviceMs ?? -1) || left.pass.localeCompare(right.pass)),
    programReasons: [...programMap.entries()]
      .map(([programIdentity, value]) => ({ programIdentity, creations: value.creations, reasons: [...value.reasons].sort() }))
      .sort((left, right) => right.creations - left.creations || left.programIdentity.localeCompare(right.programIdentity)),
    sizeTime: {
      byPass: [...sizeMap.entries()]
        .map(([pass, value]) => ({
          pass,
          samples: value.samples,
          meanBytes: value.bytes / value.samples,
          meanServiceMs: value.serviceMs / value.samples,
        }))
        .sort((left, right) => right.meanServiceMs - left.meanServiceMs || left.pass.localeCompare(right.pass)),
      samples: sizeSamples,
      statement: "Descriptive samples only; shader size and compile time are correlated here, not causal.",
    },
    source,
    warmup: {
      total: capture.events.length,
      beforeFirstPresent,
      afterFirstPresent,
      afterWarmUpSettled,
      unreported,
      ...(capture.firstPresent === undefined ? {} : { eventsSettledAtFirstPresent: capture.firstPresent.eventsSettled }),
      ...(capture.warmUpSettled === undefined
        ? {}
        : {
            eventsSettledAtWarmUpSettled: capture.warmUpSettled.eventsSettled,
            renderPipelineCreationsAfterWarmUpSettled,
          }),
      ...(nodeBuildsAfterWarmUpSettled === undefined ? {} : { nodeBuildsAfterWarmUpSettled }),
      ...(warmedMaterialLabels === undefined || warmedMaterialLabels.size === 0
        ? {}
        : {
            warmedNodeBuildsAfterWarmUpSettled,
            warmedRenderPipelineCreationsAfterWarmUpSettled,
          }),
      scopes: [...scopeMap.entries()]
        .map(([label, value]) => ({ label, ...value }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    },
  };
}

export function formatPipelineSummary(summary: IPipelineSummary): string {
  const lines = [`pipeline census — ${summary.complete ? "complete" : "INCOMPLETE"} (${summary.source})`];
  const counts = summary.counts;
  lines.push(
    `counts: ${counts.creations} creations, ${counts.uniquePrograms} unique program(s), ` +
      `${counts.uniquePipelines} unique pipeline(s), ${counts.failures} failure(s), ` +
      `${counts.pending} pending, ${counts.lookups} lookup(s)`,
  );
  // Say which kind of ending this is, so a live snapshot is never read as a finished run.
  if (summary.boundary?.kind === "finalized")
    lines.push(`boundary: process finalized after ${summary.boundary.events} event(s)`);
  else if (summary.boundary !== undefined)
    lines.push(
      `boundary: live checkpoint at present ${summary.boundary.present}, ` +
        `${summary.boundary.events} event(s), ${summary.boundary.outstanding} still compiling ` +
        "(nothing is claimed about the run after it)",
    );
  if (summary.passTotals.length > 0) {
    lines.push("passes:");
    for (const pass of summary.passTotals) {
      lines.push(`  ${pass.pass.padEnd(16)} ${pass.creations} creation(s), ${formatService(pass.serviceMs)} service (${pass.serviceSamples} sample(s)), ${pass.beforeFirstPresent} before first present`);
    }
  }
  if (summary.contributors.length > 0) {
    lines.push("top material/object contributors:");
    for (const contributor of summary.contributors.slice(0, 5)) {
      lines.push(
        `  ${contributor.label.padEnd(28)} ${contributor.creations} creation(s), ` +
          `${contributor.nodeBuilds} node build(s), ${formatService(contributor.serviceMs)} service`,
      );
    }
  }
  if (summary.programReasons.length > 0) {
    lines.push("distinct programs and observed structural reasons:");
    for (const program of summary.programReasons.slice(0, 5)) {
      lines.push(`  ${program.programIdentity} — ${program.creations} creation(s): ${program.reasons.join(", ")}`);
    }
  }
  lines.push(
    `warm-up: ${summary.warmup.beforeFirstPresent} before first present, ` +
      `${summary.warmup.afterFirstPresent} after, ${summary.warmup.unreported} unreported`,
  );
  if (summary.warmup.eventsSettledAtWarmUpSettled !== undefined) {
    lines.push(
      `warm-up settled: ${summary.warmup.afterWarmUpSettled} event(s) after, ` +
        `${summary.warmup.nodeBuildsAfterWarmUpSettled ?? "unreported"} node build(s), ` +
        `${summary.warmup.renderPipelineCreationsAfterWarmUpSettled} render pipeline creation(s)`,
    );
    if (summary.warmup.warmedNodeBuildsAfterWarmUpSettled !== undefined)
      lines.push(
        `warmed materials after warm-up: ${summary.warmup.warmedNodeBuildsAfterWarmUpSettled} node build(s), ` +
          `${summary.warmup.warmedRenderPipelineCreationsAfterWarmUpSettled} render pipeline creation(s)`,
      );
  }
  if (summary.sizeTime.byPass.length > 0) {
    lines.push("shader size/time by pass:");
    for (const pass of summary.sizeTime.byPass) {
      lines.push(
        `  ${pass.pass.padEnd(16)} mean ${pass.meanBytes.toFixed(1)} bytes, ` +
          `${pass.meanServiceMs.toFixed(3)} ms service (${pass.samples} sample(s))`,
      );
    }
  }
  lines.push(`shader size/time samples: ${summary.sizeTime.samples}; ${summary.sizeTime.statement}`);
  for (const reason of summary.incompleteReasons) lines.push(`FAIL TN_PIPELINE_CAPTURE_INCOMPLETE: ${reason}`);
  return `${lines.join("\n")}\n`;
}

function parseBrowserCapture(value: JsonRecord): IPipelineCapture {
  const eventsValue = value.events;
  if (!Array.isArray(eventsValue)) throw malformed("browser capture is missing an events array");
  const events = eventsValue.map((event, index) => normaliseBrowserEvent(event, index));
  const nodeBuilds = parseNodeBuilds(value.nodeBuilds);
  validateEventSequence(events, "browser capture", true);
  const declaredCounts = parseCounts(value.counts);
  const reasons: string[] = [];
  for (const event of events) {
    if (event.kind === "render" && event.vertex === undefined)
      reasons.push("a render pipeline is missing its vertex shader observation");
    if (event.kind === "compute" && event.compute === undefined)
      reasons.push("a compute pipeline is missing its shader observation");
  }
  if (typeof value.complete !== "boolean") throw malformed("browser capture complete must be boolean");
  if (value.complete !== true) reasons.push("capture declares itself incomplete");
  if (value.overflowed !== undefined && typeof value.overflowed !== "boolean")
    throw malformed("browser capture overflowed must be boolean");
  if (value.overflowed === true) reasons.push("bounded event buffer overflowed");
  if (value.unsupported !== undefined && typeof value.unsupported !== "boolean")
    throw malformed("browser capture unsupported must be boolean");
  if (value.unsupported === true) reasons.push("pipeline census is unsupported");
  const clock = parseClock(value.clock, reasons);
  const backend = parseBackend(value.backend, reasons);
  const build = parseBuild(value.build, reasons);
  const adapter = parseAdapter(value.adapter, reasons);
  const declaredReasons = stringArray(value.incompleteReasons);
  reasons.push(...declaredReasons.filter((reason) => !reasons.includes(reason)));
  const derivedFailures = events.filter(({ status }) => status === "failed").length;
  const derivedPending = events.filter(({ status }) => status === "pending").length;
  if (declaredCounts.pending !== derivedPending) reasons.push("pending count does not match event statuses");
  if (declaredCounts.failures !== derivedFailures) reasons.push("failure count does not match event statuses");
  if (declaredCounts.pending > 0) reasons.push(`${declaredCounts.pending} pipeline event(s) are pending`);
  if (declaredCounts.failures > 0) reasons.push(`${declaredCounts.failures} pipeline creation(s) failed`);
  if (declaredCounts.recordedEvents !== events.length) reasons.push("recorded event count does not match the events array");
  if (declaredCounts.uniquePrograms !== new Set(events.map(({ programIdentity }) => programIdentity)).size)
    reasons.push("unique program count does not match the events array");
  if (declaredCounts.uniquePipelines !== new Set(events.map(({ pipelineIdentity }) => pipelineIdentity)).size)
    reasons.push("unique pipeline count does not match the events array");
  if (declaredCounts.creations !== events.length + declaredCounts.droppedEvents)
    reasons.push("creation count does not reconcile with recorded and dropped events");
  if (declaredCounts.droppedEvents > 0)
    reasons.push(`${declaredCounts.droppedEvents} pipeline event(s) were dropped from the bounded capture`);
  const sequenceGaps = sequenceGapCount(events);
  if (sequenceGaps > declaredCounts.droppedEvents)
    reasons.push("event sequence gaps exceed the declared dropped event count");
  if (events[0]?.sequence !== undefined && events[0].sequence !== 1)
    reasons.push(`browser event sequence starts at ${events[0].sequence}, expected 1`);
  if (declaredCounts.creations === 0) reasons.push("no pipeline creations observed");
  const firstPresent = parseFirstPresent(value.firstPresent);
  if (firstPresent === undefined) reasons.push("capture is missing its first-present boundary");
  if (firstPresent !== undefined) {
    const settledAtFirstPresent = events.filter(
      ({ settledMs }) => settledMs !== undefined && settledMs <= firstPresent.boundaryMs,
    ).length;
    if (firstPresent.eventsSettled !== settledAtFirstPresent)
      reasons.push("first-present settled count does not match event timings");
    for (const event of events) {
      if (event.beforeFirstPresent === true && event.settledMs !== undefined && event.settledMs > firstPresent.boundaryMs)
        reasons.push("an event is marked before first present but settled after its boundary");
      if (event.beforeFirstPresent === false && event.settledMs !== undefined && event.settledMs <= firstPresent.boundaryMs)
        reasons.push("an event is marked after first present but settled before its boundary");
    }
  }
  const warmUpSettled = parseWarmUpSettled(value.warmUpSettled);
  const warmUpScopes = parseWarmUpScopes(value.warmUpScopes);
  if (warmUpSettled !== undefined) {
    const settledAtWarmUp = events.filter(
      ({ settledMs }) => settledMs !== undefined && settledMs <= warmUpSettled.boundaryMs,
    ).length;
    if (warmUpSettled.eventsSettled !== settledAtWarmUp)
      reasons.push("warm-up settled event count does not match event timings");
    const renderCreationsAtWarmUp = events.filter(
      ({ kind, status, settledMs }) =>
        kind === "render" &&
        status === "created" &&
        settledMs !== undefined &&
        settledMs <= warmUpSettled.boundaryMs,
    ).length;
    if (warmUpSettled.renderPipelineCreations !== renderCreationsAtWarmUp)
      reasons.push("warm-up settled render creation count does not match event timings");
    for (const event of events) {
      if (event.beforeWarmUpSettled === true && event.settledMs !== undefined && event.settledMs > warmUpSettled.boundaryMs)
        reasons.push("an event is marked before warm-up settled but settled after its boundary");
      if (event.beforeWarmUpSettled === false && event.settledMs !== undefined && event.settledMs <= warmUpSettled.boundaryMs)
        reasons.push("an event is marked after warm-up settled but settled before its boundary");
      if (event.beforeWarmUpSettled === undefined)
        reasons.push("an event is missing its warm-up settled boundary tag");
      if (event.beforeWarmUpSettled === false && event.nodeBuilds === undefined)
        reasons.push("an event after warm-up settled is missing its node-build count");
    }
    if (declaredCounts.nodeBuilds !== undefined && declaredCounts.nodeBuilds < warmUpSettled.nodeBuilds)
      reasons.push("warm-up settled node-build count exceeds the total node-build count");
    for (const [index, nodeBuild] of (nodeBuilds ?? []).entries()) {
      if (nodeBuild.beforeWarmUpSettled === undefined)
        reasons.push(`node build ${index + 1} is missing its warm-up settled boundary tag`);
      else if (
        (nodeBuild.beforeWarmUpSettled && nodeBuild.startedMs > warmUpSettled.boundaryMs) ||
        (!nodeBuild.beforeWarmUpSettled && nodeBuild.startedMs <= warmUpSettled.boundaryMs)
      )
        reasons.push(`node build ${index + 1} has an invalid warm-up settled boundary tag`);
    }
  }
  if (warmUpScopes !== undefined) {
    const labels = new Set(warmUpScopes.map(({ label }) => label));
    for (const event of events) {
      if (event.afterWarmUpScope !== undefined && !labels.has(event.afterWarmUpScope))
        reasons.push(`event ${event.sequence} names an unknown warm-up scope`);
    }
    for (const scope of warmUpScopes) {
      const settled = events.filter(
        ({ settledMs }) => settledMs !== undefined && settledMs <= scope.boundaryMs,
      ).length;
      if (settled !== scope.eventsSettled)
        reasons.push(`warm-up scope '${scope.label}' event count does not match event timings`);
      const creations = events.filter(
        ({ kind, status, settledMs }) =>
          kind === "render" && status === "created" && settledMs !== undefined && settledMs <= scope.boundaryMs,
      ).length;
      if (creations !== scope.renderPipelineCreations)
        reasons.push(`warm-up scope '${scope.label}' render creation count does not match event timings`);
    }
    for (const [index, nodeBuild] of (nodeBuilds ?? []).entries()) {
      if (nodeBuild.afterWarmUpScope !== undefined && !labels.has(nodeBuild.afterWarmUpScope))
        reasons.push(`node build ${index + 1} names an unknown warm-up scope`);
    }
  }
  if (nodeBuilds !== undefined && declaredCounts.nodeBuilds !== undefined && nodeBuilds.length !== declaredCounts.nodeBuilds)
    reasons.push("node-build count does not match the nodeBuilds array");
  return {
    version: PIPELINE_CAPTURE_VERSION,
    source: "browser",
    complete: reasons.length === 0,
    overflowed: value.overflowed === true,
    ...(backend === undefined ? {} : { backend }),
    ...(clock === undefined ? {} : { clock }),
    ...(build === undefined ? {} : { build }),
    ...(adapter === undefined ? {} : { adapter }),
    ...(firstPresent === undefined ? {} : { firstPresent }),
    ...(warmUpSettled === undefined ? {} : { warmUpSettled }),
    ...(warmUpScopes === undefined ? {} : { warmUpScopes }),
    counts: declaredCounts,
    events,
    ...(nodeBuilds === undefined ? {} : { nodeBuilds }),
    incompleteReasons: reasons,
  };
}

function nativeCaptureMetadata(value: unknown): {
  readonly adapter: Readonly<Record<string, unknown>>;
  readonly build: Readonly<Record<string, unknown>>;
  readonly clock: Readonly<Record<string, unknown>>;
} {
  const source = asRecord(value);
  if (source === undefined) throw malformed("native pipeline capture metadata is not an object");
  const reasons: string[] = [];
  const build = parseBuild(source.build, reasons);
  const adapter = parseAdapter(source.adapter, reasons);
  const clock = parseClock(source.clock, reasons);
  if (reasons.length > 0) throw malformed(`native pipeline capture metadata is incomplete: ${reasons.join("; ")}`);
  if (build === undefined || adapter === undefined || clock === undefined)
    throw malformed("native pipeline capture metadata is incomplete");
  return { adapter, build, clock };
}

function nativeCapture(metadata: INativeMarkerCapture): IPipelineCapture {
  const firstPresent = nativeFirstPresent(metadata.events, metadata.firstPresentBoundaryMs);
  const events = nativeEventsWithBoundary(metadata.events, firstPresent);
  validateEventSequence(events, "native capture", true);
  const sequence = nativeSequenceSummary(events, declaredEventCount(metadata));
  const reasons = nativeCaptureReasons(
    metadata,
    events,
    firstPresent,
    sequence.droppedEvents,
  );
  const failures = events.filter(({ status }) => status === "failed").length;
  const boundary = nativeBoundary(metadata);
  // A live checkpoint counts compiles the pool started and has not settled. They have no event
  // line yet — nothing here knows their shader identity or what they will cost, and no event is
  // invented for them — but they are the host's own observation that work is still in flight, and
  // reporting `pending: 0` beside a boundary saying otherwise is one capture telling two stories.
  // A finalized run drained the pool, so there its statuses are the whole account.
  const pending =
    events.filter(({ status }) => status === "pending").length +
    (boundary?.kind === "checkpoint" ? boundary.outstanding ?? 0 : 0);
  const counts = {
    lookups: 0,
    creations: events.length + sequence.droppedEvents,
    failures,
    pending,
    uniquePrograms: new Set(events.map(({ programIdentity }) => programIdentity)).size,
    uniquePipelines: new Set(events.map(({ pipelineIdentity }) => pipelineIdentity)).size,
    recordedEvents: events.length,
    droppedEvents: sequence.droppedEvents,
  };
  if (failures > 0) reasons.push(`${failures} pipeline creation(s) failed`);
  return {
    version: PIPELINE_CAPTURE_VERSION,
    source: "native",
    ...(boundary === undefined ? {} : { boundary }),
    complete: reasons.length === 0,
    overflowed: false,
    ...(metadata.clock === undefined ? {} : { clock: metadata.clock }),
    ...(metadata.build === undefined ? {} : { build: metadata.build }),
    ...(metadata.adapter === undefined ? {} : { adapter: metadata.adapter }),
    ...(firstPresent === undefined ? {} : { firstPresent }),
    counts,
    events,
    incompleteReasons: reasons,
  };
}

function nativeFirstPresent(
  events: readonly IPipelineCaptureEvent[],
  boundaryMs: number | undefined,
): IPipelineCapture["firstPresent"] | undefined {
  if (boundaryMs === undefined) return undefined;
  return {
    boundaryMs,
    eventsSettled: events.filter(
      ({ settledMs }) => settledMs !== undefined && settledMs <= boundaryMs,
    ).length,
  };
}

function nativeEventsWithBoundary(
  events: readonly IPipelineCaptureEvent[],
  firstPresent: IPipelineCapture["firstPresent"] | undefined,
): readonly IPipelineCaptureEvent[] {
  if (firstPresent === undefined) return events;
  return events.map((event) =>
    event.settledMs === undefined
      ? event
      : { ...event, beforeFirstPresent: event.settledMs <= firstPresent.boundaryMs },
  );
}

function nativeSequenceSummary(
  events: readonly IPipelineCaptureEvent[],
  expectedEventCount: number | undefined,
): {
  readonly firstId: number | undefined;
  readonly droppedEvents: number;
} {
  const firstId = events[0]?.sequence;
  const lastId = events.at(-1)?.sequence;
  const declaredCount = expectedEventCount ?? lastId;
  return {
    firstId,
    droppedEvents:
      declaredCount === undefined ? 0 : Math.max(0, declaredCount - events.length),
  };
}

function nativeCaptureReasons(
  metadata: INativeMarkerCapture,
  events: readonly IPipelineCaptureEvent[],
  firstPresent: IPipelineCapture["firstPresent"] | undefined,
  droppedEvents: number,
): string[] {
  const reasons = nativeEventReasons(events);
  const firstId = events[0]?.sequence;
  if (firstId !== 1) reasons.push(`native event sequence starts at ${firstId ?? "missing"}, expected 1`);
  if (droppedEvents > 0) reasons.push(`${droppedEvents} native pipeline event(s) are missing from the sequence`);
  reasons.push(...nativeBoundaryReasons(metadata, events));
  if (events.length === 0) reasons.push("no native pipeline events observed");
  reasons.push(...nativeMetadataReasons(metadata, firstPresent));
  return reasons;
}

/** The count a boundary declares, whichever kind of boundary the run managed to print. */
function declaredEventCount(metadata: INativeMarkerCapture): number | undefined {
  return metadata.expectedEventCount ?? metadata.checkpoint?.emitted;
}

/** The boundary the run printed, reported whether or not the capture reaching it was whole. */
function nativeBoundary(metadata: INativeMarkerCapture): IPipelineCaptureBoundary | undefined {
  if (metadata.expectedEventCount !== undefined)
    return { kind: "finalized", events: metadata.expectedEventCount };
  const checkpoint = metadata.checkpoint;
  if (checkpoint === undefined) return undefined;
  return {
    kind: "checkpoint",
    events: checkpoint.emitted,
    outstanding: checkpoint.outstanding,
    present: checkpoint.present,
  };
}

/**
 * What it takes for a capture to be whole, by the boundary the run actually printed.
 *
 * A finalized run says how many requests it handed out and is authoritative. A force-stopped run
 * has only its last checkpoint, which bounds the capture at a present: it must account for every
 * event line in the log and leave nothing compiling. That is deliberately stricter than "the last
 * event looks fine" — an event after the final checkpoint, or fewer lines than it counted, is a
 * log the kill or the log buffer cut, and a total read off it would be wrong rather than partial.
 *
 * The event-after-the-boundary case is counted where the log is read, not inferred from the
 * totals: a checkpoint that counted two events with only one written before it agrees with the
 * final tally once the second arrives, and read on totals alone that log looks whole.
 */
function nativeBoundaryReasons(
  metadata: INativeMarkerCapture,
  events: readonly IPipelineCaptureEvent[],
): string[] {
  const lastSequence = events.at(-1)?.sequence ?? 0;
  if (metadata.expectedEventCount !== undefined) {
    return metadata.expectedEventCount !== events.length || metadata.expectedEventCount !== lastSequence
      ? ["native pipeline event count does not match the completion marker"]
      : [];
  }
  const checkpoint = metadata.checkpoint;
  if (checkpoint === undefined) return ["native marker capture is missing its completion marker"];
  const reasons: string[] = [];
  if (checkpoint.outstanding > 0)
    reasons.push(`native pipeline checkpoint reports ${checkpoint.outstanding} compile(s) still outstanding`);
  if (checkpoint.emitted !== events.length || checkpoint.emitted !== lastSequence)
    reasons.push("native pipeline event count does not match the checkpoint");
  if (metadata.eventsAfterCheckpoint > 0)
    reasons.push(
      `${metadata.eventsAfterCheckpoint} native pipeline event(s) were written after the checkpoint that bounds the capture`,
    );
  return reasons;
}

function nativeEventReasons(events: readonly IPipelineCaptureEvent[]): string[] {
  const reasons: string[] = [];
  for (const event of events) {
    if (event.kind === "render" && event.vertex === undefined)
      reasons.push("a render pipeline is missing its vertex shader observation");
    if (event.kind === "compute" && event.compute === undefined)
      reasons.push("a compute pipeline is missing its shader observation");
  }
  return reasons;
}

function nativeMetadataReasons(
  metadata: INativeMarkerCapture,
  firstPresent: IPipelineCapture["firstPresent"] | undefined,
): string[] {
  const reasons: string[] = [];
  if (metadata.build === undefined) reasons.push("native marker capture is missing its build identity");
  if (metadata.adapter === undefined) reasons.push("native marker capture is missing its adapter identity");
  else if (metadata.adapter.thermal === undefined) reasons.push("native marker capture is missing its thermal identity");
  if (metadata.clock === undefined) reasons.push("native marker capture is missing its clock origin");
  if (firstPresent === undefined) reasons.push("native marker capture is missing its first-present boundary");
  return reasons;
}

function unsupportedCapture(version: number, value: JsonRecord): IPipelineCapture {
  return {
    version,
    source: "browser",
    complete: false,
    overflowed: value.overflowed === true,
    counts: emptyCounts(),
    events: [],
    incompleteReasons: [`unsupported pipeline capture version ${version}`],
  };
}

function normaliseBrowserEvent(value: unknown, index: number): IPipelineCaptureEvent {
  const event = asRecord(value);
  if (event === undefined) throw malformed(`browser event ${index + 1} is not an object`);
  const kind = enumValue(event.kind, ["compute", "render"] as const, `event ${index + 1} kind`);
  const mode = enumValue(event.mode, ["sync", "async"] as const, `event ${index + 1} mode`);
  const status = enumValue(event.status, ["created", "failed", "pending"] as const, `event ${index + 1} status`);
  const sequence = positiveInteger(event.sequence, `event ${index + 1} sequence`);
  const programIdentity = stringValue(event.programIdentity, `event ${index + 1} programIdentity`);
  const pipelineIdentity = stringValue(event.pipelineIdentity, `event ${index + 1} pipelineIdentity`);
  const provenance = normaliseProvenance(event.provenance, `event ${index + 1}`);
  const reasons = stringArray(event.reasons);
  if (reasons.length === 0) throw malformed(`event ${index + 1} has no structural reasons`);
  const result: IPipelineCaptureEvent = {
    sequence,
    programIdentity,
    pipelineIdentity,
    kind,
    pass: stringValue(event.pass, `event ${index + 1} pass`),
    mode,
    status,
    provenance,
    reasons,
    startedMs: nonNegativeNumber(event.startedMs, `event ${index + 1} startedMs`),
    ...optionalShader(event.vertex, `event ${index + 1} vertex`),
    ...optionalShader(event.fragment, `event ${index + 1} fragment`),
    ...optionalShader(event.compute, `event ${index + 1} compute`),
    ...optionalNumber(event.settledMs, "settledMs", index),
    ...optionalNumber(event.serviceMs, "serviceMs", index),
    ...optionalNumber(event.promiseMs, "promiseMs", index),
    ...optionalNumber(event.queueMs, "queueMs", index),
    ...optionalNumber(event.wallMs, "wallMs", index),
    ...(event.error === undefined ? {} : { error: stringValue(event.error, `event ${index + 1} error`) }),
    ...(event.nodeBuilds === undefined ? {} : { nodeBuilds: nonNegativeInteger(event.nodeBuilds, `event ${index + 1} nodeBuilds`) }),
    ...(event.beforeFirstPresent === undefined ? {} : { beforeFirstPresent: booleanValue(event.beforeFirstPresent, `event ${index + 1} beforeFirstPresent`) }),
    ...(event.beforeWarmUpSettled === undefined ? {} : { beforeWarmUpSettled: booleanValue(event.beforeWarmUpSettled, `event ${index + 1} beforeWarmUpSettled`) }),
    ...(event.afterWarmUpScope === undefined ? {} : { afterWarmUpScope: stringValue(event.afterWarmUpScope, `event ${index + 1} afterWarmUpScope`) }),
  };
  validateEventTiming(result, `event ${index + 1}`);
  if (status === "failed" && result.error === undefined)
    throw malformed(`event ${index + 1} failed without an error`);
  if (status === "created" && result.error !== undefined)
    throw malformed(`event ${index + 1} is created but carries an error`);
  return result;
}

function normaliseNativeEvent(value: unknown): IPipelineCaptureEvent {
  const event = asRecord(value);
  if (event === undefined) throw malformed("native pipeline event is not an object");
  const kind = enumValue(event.kind, ["compute", "render"] as const, "native event kind");
  const status = enumValue(event.status, ["created", "failed", "pending"] as const, "native event status");
  const mode = enumValue(event.mode, ["sync", "async"] as const, "native event mode");
  const sequence = positiveInteger(event.eventId, "native event eventId");
  const queueMs = nonNegativeNumber(event.queueMs, "native event queueMs");
  const serviceMs = nonNegativeNumber(event.serviceMs, "native event serviceMs");
  const wallMs = nonNegativeNumber(event.wallMs, "native event wallMs");
  const provenance = normaliseProvenance(event.provenance, "native event");
  const reasons = stringArray(event.reasons);
  const shaderField = kind === "compute" ? "compute" : "vertex";
  const shader = optionalShader(event[shaderField], `native event ${shaderField}`)[shaderField];
  const startedMs = event.startedMs === undefined ? 0 : nonNegativeNumber(event.startedMs, "native event startedMs");
  const settledMs = event.settledMs === undefined ? startedMs + wallMs : nonNegativeNumber(event.settledMs, "native event settledMs");
  const result: IPipelineCaptureEvent = {
    sequence,
    programIdentity: stringValue(event.programIdentity, "native event programIdentity"),
    pipelineIdentity: stringValue(event.pipelineIdentity, "native event pipelineIdentity"),
    kind,
    pass: nativePass(stringValue(event.pass, "native event pass"), event.label),
    mode,
    status,
    ...(kind === "compute" ? { compute: shader } : { vertex: shader }),
    ...optionalShader(event.fragment, "native event fragment"),
    provenance,
    reasons: reasons.length === 0 ? ["unknown-structural-difference"] : reasons,
    startedMs,
    settledMs,
    queueMs,
    serviceMs,
    wallMs,
    ...(event.label === undefined ? {} : { label: stringValue(event.label, "native event label") }),
    ...(event.error === undefined ? {} : { error: stringValue(event.error, "native event error") }),
  };
  validateEventTiming(result, "native event");
  if (wallMs + 0.000001 < queueMs + serviceMs)
    throw malformed("native event wallMs is shorter than queueMs plus serviceMs");
  if (status === "failed" && result.error === undefined)
    throw malformed("native event failed without an error");
  if (status === "created" && result.error !== undefined)
    throw malformed("native event is created but carries an error");
  return result;
}

function parseCounts(value: unknown): IPipelineCaptureCounts {
  const source = asRecord(value);
  if (source === undefined) throw malformed("browser capture is missing counts");
  const fields = [
    "lookups",
    "creations",
    "failures",
    "pending",
    "uniquePrograms",
    "uniquePipelines",
    "recordedEvents",
    "droppedEvents",
  ] as const;
  for (const field of fields) {
    if (!Object.hasOwn(source, field)) throw malformed(`counts is missing ${field}`);
  }
  return {
    lookups: nonNegativeInteger(source.lookups, "counts lookups"),
    creations: nonNegativeInteger(source.creations, "counts creations"),
    failures: nonNegativeInteger(source.failures, "counts failures"),
    pending: nonNegativeInteger(source.pending, "counts pending"),
    uniquePrograms: nonNegativeInteger(source.uniquePrograms, "counts uniquePrograms"),
    uniquePipelines: nonNegativeInteger(source.uniquePipelines, "counts uniquePipelines"),
    recordedEvents: nonNegativeInteger(source.recordedEvents, "counts recordedEvents"),
    droppedEvents: nonNegativeInteger(source.droppedEvents, "counts droppedEvents"),
    ...(source.nodeBuilds === undefined ? {} : { nodeBuilds: nonNegativeInteger(source.nodeBuilds, "counts nodeBuilds") }),
  };
}

function optionalShader(value: unknown, label: string): Partial<Record<"vertex" | "fragment" | "compute", IPipelineCaptureShader>> {
  if (value === undefined) return {};
  const shader = asRecord(value);
  if (shader === undefined) throw malformed(`${label} is not an object`);
  return { [label.split(" ").at(-1) as "vertex" | "fragment" | "compute"]: {
    hash: stringValue(shader.hash, `${label} hash`),
    bytes: nonNegativeInteger(shader.bytes, `${label} bytes`),
  } };
}

function normaliseProvenance(value: unknown, label: string): IPipelineCaptureProvenance {
  const source = asRecord(value);
  if (source === undefined) throw malformed(`${label} provenance is missing`);
  const material = optionalLabel(source.material, `${label} material`);
  const object = optionalLabel(source.object, `${label} object`);
  if (typeof source.unknown !== "boolean") throw malformed(`${label} provenance unknown must be boolean`);
  if (source.unknown === true && (material !== undefined || object !== undefined))
    throw malformed(`${label} unknown provenance cannot include material or object`);
  if (source.unknown === false && material === undefined && object === undefined)
    throw malformed(`${label} provenance is not unknown but has no material or object`);
  return { ...(material === undefined ? {} : { material }), ...(object === undefined ? {} : { object }), unknown: source.unknown };
}

function optionalLabel(value: unknown, label: string): { id?: number; name?: string; type?: string; uuid?: string } | undefined {
  if (value === undefined) return undefined;
  const source = asRecord(value);
  if (source === undefined) throw malformed(`${label} is not an object`);
  const result = {
    ...(source.id === undefined ? {} : { id: finiteNumber(source.id, `${label} id`) }),
    ...(source.name === undefined ? {} : { name: stringValue(source.name, `${label} name`) }),
    ...(source.type === undefined ? {} : { type: stringValue(source.type, `${label} type`) }),
    ...(source.uuid === undefined ? {} : { uuid: stringValue(source.uuid, `${label} uuid`) }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function parseFirstPresent(value: unknown): IPipelineCapture["firstPresent"] {
  if (value === undefined) return undefined;
  const source = asRecord(value);
  if (source === undefined) throw malformed("firstPresent is not an object");
  return {
    boundaryMs: nonNegativeNumber(source.boundaryMs, "firstPresent boundaryMs"),
    eventsSettled: nonNegativeInteger(source.eventsSettled, "firstPresent eventsSettled"),
  };
}

function parseWarmUpSettled(value: unknown): IPipelineCapture["warmUpSettled"] {
  if (value === undefined) return undefined;
  const source = asRecord(value);
  if (source === undefined) throw malformed("warmUpSettled is not an object");
  return {
    boundaryMs: nonNegativeNumber(source.boundaryMs, "warmUpSettled boundaryMs"),
    eventsSettled: nonNegativeInteger(source.eventsSettled, "warmUpSettled eventsSettled"),
    nodeBuilds: nonNegativeInteger(source.nodeBuilds, "warmUpSettled nodeBuilds"),
    renderPipelineCreations: nonNegativeInteger(
      source.renderPipelineCreations,
      "warmUpSettled renderPipelineCreations",
    ),
  };
}

function parseWarmUpScopes(value: unknown): IPipelineCapture["warmUpScopes"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw malformed("warmUpScopes is not an array");
  return value.map((entry, index) => {
    const source = asRecord(entry);
    if (source === undefined) throw malformed(`warmUpScopes[${index}] is not an object`);
    const label = stringValue(source.label, `warmUpScopes[${index}] label`);
    if (label.trim() === "") throw malformed(`warmUpScopes[${index}] label is empty`);
    const firstDraw = source.firstDraw === undefined
      ? undefined
      : (() => {
          const draw = asRecord(source.firstDraw);
          if (draw === undefined) throw malformed(`warmUpScopes[${index}] firstDraw is not an object`);
          return {
            nodeBuilds: nonNegativeInteger(draw.nodeBuilds, `warmUpScopes[${index}] firstDraw nodeBuilds`),
            renderPipelineCreations: nonNegativeInteger(
              draw.renderPipelineCreations,
              `warmUpScopes[${index}] firstDraw renderPipelineCreations`,
            ),
          };
        })();
    return {
      label,
      boundaryMs: nonNegativeNumber(source.boundaryMs, `warmUpScopes[${index}] boundaryMs`),
      eventsSettled: nonNegativeInteger(source.eventsSettled, `warmUpScopes[${index}] eventsSettled`),
      nodeBuilds: nonNegativeInteger(source.nodeBuilds, `warmUpScopes[${index}] nodeBuilds`),
      renderPipelineCreations: nonNegativeInteger(
        source.renderPipelineCreations,
        `warmUpScopes[${index}] renderPipelineCreations`,
      ),
      ...(firstDraw === undefined ? {} : { firstDraw }),
    };
  });
}

function parseNodeBuilds(value: unknown): IPipelineCapture["nodeBuilds"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw malformed("nodeBuilds is not an array");
  return value.map((entry, index) => {
    const source = asRecord(entry);
    if (source === undefined) throw malformed(`nodeBuilds[${index}] is not an object`);
    return {
      provenance: normaliseProvenance(source.provenance, `nodeBuilds[${index}]`),
      startedMs: nonNegativeNumber(source.startedMs, `nodeBuilds[${index}] startedMs`),
      ...(source.beforeFirstPresent === undefined
        ? {}
        : { beforeFirstPresent: booleanValue(source.beforeFirstPresent, `nodeBuilds[${index}] beforeFirstPresent`) }),
      ...(source.beforeWarmUpSettled === undefined
        ? {}
        : { beforeWarmUpSettled: booleanValue(source.beforeWarmUpSettled, `nodeBuilds[${index}] beforeWarmUpSettled`) }),
      ...(source.afterWarmUpScope === undefined
        ? {}
        : { afterWarmUpScope: stringValue(source.afterWarmUpScope, `nodeBuilds[${index}] afterWarmUpScope`) }),
    };
  });
}

function validateCaptureVersion(value: unknown, label: string): void {
  const event = asRecord(value);
  if (event === undefined) throw malformed(`${label} is not an object`);
  if (event.version === undefined) throw malformed(`${label} is missing its version`);
  if (typeof event.version !== "number" || !Number.isInteger(event.version))
    throw malformed(`${label} version must be an integer`);
  if (event.version !== PIPELINE_CAPTURE_VERSION)
    throw malformed(`${label} has unsupported version ${event.version}`);
}

function validateEventSequence(
  events: readonly IPipelineCaptureEvent[],
  label: string,
  allowMissing = false,
): void {
  let previous = 0;
  for (const event of events) {
    if (event.sequence <= previous)
      throw malformed(`${label} event sequence is not strictly increasing`);
    if (!allowMissing && event.sequence !== previous + 1 && previous !== 0)
      throw malformed(`${label} event sequence has a gap before ${event.sequence}`);
    previous = event.sequence;
  }
}

function sequenceGapCount(events: readonly IPipelineCaptureEvent[]): number {
  if (events.length === 0) return 0;
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined) return 0;
  return last.sequence - first.sequence + 1 - events.length;
}

function validateEventTiming(event: IPipelineCaptureEvent, label: string): void {
  if (event.settledMs !== undefined && event.settledMs < event.startedMs)
    throw malformed(`${label} settledMs precedes startedMs`);
  if (event.serviceMs !== undefined && event.serviceMs < 0)
    throw malformed(`${label} serviceMs must be non-negative`);
  if (event.promiseMs !== undefined && event.promiseMs < 0)
    throw malformed(`${label} promiseMs must be non-negative`);
  if (
    event.queueMs !== undefined &&
    event.serviceMs !== undefined &&
    event.wallMs !== undefined &&
    event.wallMs + 0.000001 < event.queueMs + event.serviceMs
  )
    throw malformed(`${label} wallMs is shorter than queueMs plus serviceMs`);
}

function nativePass(pass: string, labelValue: unknown): string {
  if (pass !== "unknown" || typeof labelValue !== "string") return pass;
  const materialMatch = /^renderPipeline_(.+)_\d+$/iu.exec(labelValue);
  const materialLabel = materialMatch?.[1] ?? labelValue;
  const label = materialLabel.toLowerCase();
  if (label.includes("shadow")) return "shadow";
  if (label.includes("pmrem")) return "pmrem";
  if (label === "outputcolortransform" || label === "renderpipeline") return "output";
  if (materialMatch !== null) return "main";
  return pass;
}

function contributorLabel(event: IPipelineCaptureEvent): string {
  return contributorLabelOfProvenance(event.provenance);
}

function contributorLabelOfProvenance(provenance: IPipelineCaptureProvenance): string {
  const material = provenance.material;
  if (material?.name !== undefined) return `material:${material.name}`;
  if (material?.id !== undefined) return `material#${material.id}`;
  if (material?.type !== undefined) return `material:${material.type}`;
  const object = provenance.object;
  if (object?.name !== undefined) return `object:${object.name}`;
  if (object?.id !== undefined) return `object#${object.id}`;
  return "unknown provenance";
}

function compareContributor(left: IPipelineContributorSummary, right: IPipelineContributorSummary): number {
  return (right.serviceMs ?? -1) - (left.serviceMs ?? -1) || right.creations - left.creations || left.label.localeCompare(right.label);
}

function firstDefinedRecord(...values: unknown[]): JsonRecord | undefined {
  for (const value of values) {
    if (value === undefined) continue;
    const record = asRecord(value);
    if (record === undefined) throw malformed("pipeline capture wrapper must be an object");
    return record;
  }
  return undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function recordOrUndefined(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return asRecord(value);
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw malformed("expected an array of strings");
  return [...value];
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw malformed(`${label} is invalid`);
  return value as T;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw malformed(`${label} must be a non-empty string`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw malformed(`${label} must be finite`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result < 0) throw malformed(`${label} must be non-negative`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) throw malformed(`${label} must be positive`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw malformed(`${label} must be a non-negative integer`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw malformed(`${label} must be boolean`);
  return value;
}

function optionalNumber(value: unknown, field: string, index: number): Partial<Record<"settledMs" | "serviceMs" | "promiseMs" | "queueMs" | "wallMs", number>> {
  if (value === undefined) return {};
  return { [field]: nonNegativeNumber(value, `event ${index + 1} ${field}`) } as Partial<Record<"settledMs" | "serviceMs" | "promiseMs" | "queueMs" | "wallMs", number>>;
}

function formatService(serviceMs: number | undefined): string {
  return serviceMs === undefined ? "unavailable" : `${serviceMs.toFixed(3)} ms`;
}

function emptyCounts(): IPipelineCaptureCounts {
  return { lookups: 0, creations: 0, failures: 0, pending: 0, uniquePrograms: 0, uniquePipelines: 0, recordedEvents: 0, droppedEvents: 0 };
}

function parseClock(
  value: unknown,
  reasons: string[],
): Readonly<Record<string, unknown>> | undefined {
  const source = recordOrUndefined(value);
  if (source === undefined) {
    reasons.push("capture is missing its clock origin");
    return undefined;
  }
  if (source.source !== "performance" && source.source !== "date" && source.source !== "steady")
    reasons.push("capture clock source is invalid");
  if (typeof source.originMs !== "number" || !Number.isFinite(source.originMs) || source.originMs < 0)
    reasons.push("capture clock origin is invalid");
  return source;
}

function parseBackend(
  value: unknown,
  reasons: string[],
): Readonly<Record<string, unknown>> | undefined {
  const source = recordOrUndefined(value);
  if (source === undefined) {
    reasons.push("capture is missing its backend identity");
    return undefined;
  }
  if (source.kind !== "webgpu" && source.kind !== "webgl2")
    reasons.push("capture backend kind is invalid");
  if (typeof source.identity !== "string" || source.identity.length === 0)
    reasons.push("capture backend identity is invalid");
  return source;
}

function parseBuild(
  value: unknown,
  reasons: string[],
): Readonly<Record<string, unknown>> | undefined {
  const source = recordOrUndefined(value);
  if (source === undefined) {
    reasons.push("capture is missing its build identity");
    return undefined;
  }
  if (typeof source.identity !== "string" || source.identity.length === 0)
    reasons.push("capture build identity is invalid");
  return source;
}

function parseAdapter(
  value: unknown,
  reasons: string[],
): Readonly<Record<string, unknown>> | undefined {
  const source = recordOrUndefined(value);
  if (source === undefined) {
    reasons.push("capture is missing its adapter identity", "capture is missing its thermal identity");
    return undefined;
  }
  if (typeof source.identity !== "string" || source.identity.length === 0)
    reasons.push("capture adapter identity is invalid");
  if (typeof source.thermal !== "string" || source.thermal.length === 0)
    reasons.push("capture thermal identity is invalid");
  return source;
}

function malformed(detail: string): Error {
  return new Error(`TN_PIPELINE_CAPTURE_MALFORMED: ${detail}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
