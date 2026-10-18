import { describe, expect, it } from "vitest";

import {
  formatPipelineSummary,
  parsePipelineCapture,
  summarizePipelineCapture,
} from "../src/runner/pipeline-summary.js";

function marker(
  eventId: number,
  queueMs: number,
  serviceMs: number,
  wallMs: number,
  overrides: Record<string, unknown> = {},
): string {
  return `TN_PIPELINE_EVENT:${JSON.stringify({
    version: 1,
    eventId,
    pipelineIdentity: `backend-${eventId}`,
    programIdentity: `program-${eventId}`,
    kind: "render",
    pass: eventId === 1 ? "main" : "shadow",
    mode: "async",
    status: "created",
    startedMs: queueMs,
    settledMs: queueMs + serviceMs,
    queueMs,
    serviceMs,
    wallMs,
    provenance: { unknown: true },
    vertex: { hash: `vertex-${eventId}`, bytes: 100 + eventId },
    fragment: { hash: `fragment-${eventId}`, bytes: 200 + eventId },
    ...overrides,
  })}`;
}

function browserEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sequence: 1,
    programIdentity: "shader-pair",
    pipelineIdentity: "backend-pipeline-1",
    kind: "render",
    pass: "main",
    mode: "sync",
    status: "created",
    vertex: { hash: "v", bytes: 42 },
    fragment: { hash: "f", bytes: 21 },
    provenance: { material: { name: "brick" }, unknown: false },
    reasons: ["map"],
    startedMs: 0,
    settledMs: 3,
    serviceMs: 3,
    beforeFirstPresent: true,
    ...overrides,
  };
}

function browserCapture(
  events: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
  lookups = events.length,
): Record<string, unknown> {
  return {
    version: 1,
    complete: true,
    overflowed: false,
    backend: { kind: "webgpu", identity: "webgpu:test" },
    clock: { source: "performance", originMs: 10 },
    build: { identity: "build:test" },
    adapter: { identity: "adapter:test", thermal: "unavailable" },
    firstPresent: { boundaryMs: 4, eventsSettled: events.filter((event) => event.settledMs !== undefined && Number(event.settledMs) <= 4).length },
    counts: {
      lookups,
      creations: events.length,
      failures: events.filter((event) => event.status === "failed").length,
      pending: events.filter((event) => event.status === "pending").length,
      uniquePrograms: new Set(events.map((event) => event.programIdentity)).size,
      uniquePipelines: new Set(events.map((event) => event.pipelineIdentity)).size,
      recordedEvents: events.length,
      droppedEvents: 0,
    },
    events,
    incompleteReasons: [],
    ...overrides,
  };
}

function nativeMetadata(boundaryMs = 5): string {
  return [
    'TN_PIPELINE_CAPTURE:{"version":1,"build":{"identity":"native:0.3.0"},"adapter":{"identity":"vendor/device","thermal":"unavailable"},"clock":{"source":"steady","originMs":0}}',
    `TN_PIPELINE_FIRST_PRESENT:{"version":1,"boundaryMs":${boundaryMs}}`,
  ].join("\n");
}

function nativeCompletion(eventCount: number): string {
  return `TN_PIPELINE_COMPLETE:{"version":1,"eventCount":${eventCount}}`;
}

function nativeCheckpoint(
  present: number,
  requested: number,
  emitted: number,
  outstanding = requested - emitted,
): string {
  return `TN_PIPELINE_CHECKPOINT:${JSON.stringify({ version: 1, present, requested, emitted, outstanding })}`;
}

function pairedCapture(lookups = 1) {
  const event = browserEvent({ pipelineIdentity: "native-render-7" });
  return {
    version: 1,
    // A one-tuple, so the cases below can reach the single event without a strict-mode guard on
    // an index the helper guarantees.
    census: { ...browserCapture([event], {}, lookups), events: [event] as [Record<string, unknown>] },
    nativeLog: [nativeMetadata(15), marker(1, 2, 10, 12, {
      pipelineIdentity: "native-render-7", programIdentity: "shader-pair", mode: "sync",
      pass: "unknown", vertex: event.vertex, fragment: event.fragment,
    }), nativeCompletion(1)].join("\n"),
  };
}

// Metadata and the first two event lines exactly as a desktop host printed them, from
// docs/verification/startup-measure-reduce-2026-09-09/desktop-baseline-audio/native.log, so the
// ordering cases run on field shapes a real capture carries rather than on rounded stand-ins.
const desktopMetadata = [
  'TN_PIPELINE_CAPTURE:{"version":1,"build":{"identity":"mystral-native@0.3.1"},"adapter":{"identity":"native:vulkan/nvidia/NVIDIA GeForce RTX 2080/turing/NVIDIA: 610.57.04 610.57.4.0","thermal":"unavailable"},"clock":{"source":"steady","originMs":0}}',
  'TN_PIPELINE_FIRST_PRESENT:{"version":1,"boundaryMs":32.836804000000001}',
].join("\n");

const desktopEvents = [
  'TN_PIPELINE_EVENT:{"version":1,"eventId":1,"pipelineIdentity":"native-render-1","programIdentity":"00fc0a8ad03630cc/458120a84b226496","kind":"render","pass":"unknown","mode":"sync","status":"created","startedMs":4.0000000000000003e-05,"settledMs":3.3803109999999998,"queueMs":0,"serviceMs":3.380271,"wallMs":3.380271,"provenance":{"unknown":true},"vertex":{"hash":"00fc0a8ad03630cc","bytes":1299},"fragment":{"hash":"458120a84b226496","bytes":1595},"label":"renderPipeline_outputColorTransform_16"}',
  'TN_PIPELINE_EVENT:{"version":1,"eventId":2,"pipelineIdentity":"native-render-2","programIdentity":"ecaec2fbce7bdaad/ecaec2fbce7bdaad","kind":"render","pass":"unknown","mode":"sync","status":"created","startedMs":1172.2477919999999,"settledMs":1175.100306,"queueMs":0,"serviceMs":2.8525140000001556,"wallMs":2.8525140000001556,"provenance":{"unknown":true},"vertex":{"hash":"ecaec2fbce7bdaad","bytes":1827},"fragment":{"hash":"ecaec2fbce7bdaad","bytes":1827},"label":"mipmap-rgba8unorm-srgb-2d-array"}',
] as [string, string];

describe("pipeline timing capture", () => {
  // The Android runner ends a run with `am force-stop`, so a device capture never reaches the
  // finalizer that prints TN_PIPELINE_COMPLETE. A checkpoint bounds the same capture from a
  // present, and is only allowed to do so while its own counts account for every line in the log.
  it("bounds a force-stopped native capture at its last live checkpoint", () => {
    const capture = parsePipelineCapture(
      [nativeMetadata(15), marker(1, 2, 10, 12), marker(2, 1, 4, 5), nativeCheckpoint(9, 2, 2, 0)].join("\n"),
    );
    expect(capture.complete).toBe(true);
    expect(capture.incompleteReasons).toEqual([]);
    expect(capture.boundary).toEqual({ kind: "checkpoint", events: 2, outstanding: 0, present: 9 });
    expect(capture.counts.creations).toBe(2);
    expect(formatPipelineSummary(summarizePipelineCapture(capture))).toContain(
      "boundary: live checkpoint at present 9",
    );
  });

  it("refuses a checkpoint whose compiles have not settled", () => {
    const capture = parsePipelineCapture(
      [nativeMetadata(15), marker(1, 2, 10, 12), nativeCheckpoint(9, 3, 1, 2)].join("\n"),
    );
    expect(capture.complete).toBe(false);
    expect(capture.incompleteReasons).toContain(
      "native pipeline checkpoint reports 2 compile(s) still outstanding",
    );
  });

  // The host's own count of compiles it has started and not settled is the only pending evidence a
  // live checkpoint carries; there are no event lines for them yet. Reporting `pending: 0` next to
  // a boundary saying one compile is in flight is the same capture telling two stories.
  it("counts the host's outstanding compiles as pending without inventing events", () => {
    const capture = parsePipelineCapture(
      [desktopMetadata, desktopEvents[0], nativeCheckpoint(10, 2, 1, 1)].join("\n"),
    );

    expect(capture.complete).toBe(false);
    expect(capture.boundary).toEqual({ kind: "checkpoint", events: 1, outstanding: 1, present: 10 });
    expect(capture.counts.pending).toBe(1);
    expect(capture.counts.creations).toBe(1);
    expect(capture.events).toHaveLength(1);
    expect(formatPipelineSummary(summarizePipelineCapture(capture))).toContain("1 pending");
  });

  it("keeps pending on the event statuses once the finalizer has spoken", () => {
    const capture = parsePipelineCapture(
      [desktopMetadata, desktopEvents[0], nativeCheckpoint(10, 1, 1, 0), nativeCompletion(1)].join("\n"),
    );

    expect(capture.complete).toBe(true);
    expect(capture.boundary).toEqual({ kind: "finalized", events: 1 });
    expect(capture.counts.pending).toBe(0);
  });

  it("refuses a capture whose trailing events arrived after its last checkpoint", () => {
    const capture = parsePipelineCapture(
      [nativeMetadata(15), marker(1, 2, 10, 12), nativeCheckpoint(9, 1, 1, 0), marker(2, 1, 4, 5)].join("\n"),
    );
    expect(capture.complete).toBe(false);
    expect(capture.incompleteReasons).toContain(
      "native pipeline event count does not match the checkpoint",
    );
  });

  // The counts and the log are one stream: a checkpoint printed under the same lock as the event
  // lines can only ever have counted lines that already precede it. A checkpoint that counts an
  // event still to come is either two runs' output in one log or a reader reading a total off a
  // capture that was cut, and both are wrong to report as whole.
  it("refuses a checkpoint that counted an event the log had not yet written", () => {
    const capture = parsePipelineCapture(
      [desktopMetadata, desktopEvents[0], nativeCheckpoint(10, 2, 2, 0), desktopEvents[1]].join("\n"),
    );

    expect(capture.complete).toBe(false);
    expect(capture.incompleteReasons).toContain(
      "1 native pipeline event(s) were written after the checkpoint that bounds the capture",
    );
    expect(capture.boundary).toEqual({ kind: "checkpoint", events: 2, outstanding: 0, present: 10 });
  });

  it("refuses a checkpoint counting fewer events than the log already carried", () => {
    expect(() =>
      parsePipelineCapture(
        [desktopMetadata, desktopEvents[0], desktopEvents[1], nativeCheckpoint(10, 1, 1, 0)].join("\n"),
      ),
    ).toThrow(/checkpoint counted 1 event\(s\) after 2/u);
  });

  // Async compiles settle in whatever order the pool finishes them, so ids arrive out of order and
  // the last id is not the count. The checkpoint is reconciled against the lines consumed before
  // it, which is what the host counted.
  it("accepts a checkpoint whose events arrived out of id order", () => {
    const capture = parsePipelineCapture(
      [desktopMetadata, desktopEvents[1], desktopEvents[0], nativeCheckpoint(10, 2, 2, 0)].join("\n"),
    );

    expect(capture.complete).toBe(true);
    expect(capture.incompleteReasons).toEqual([]);
    expect(capture.events.map(({ sequence }) => sequence)).toEqual([1, 2]);
  });

  it("refuses a capture truncated between its events and its checkpoint", () => {
    const capture = parsePipelineCapture(
      [nativeMetadata(15), marker(1, 2, 10, 12), nativeCheckpoint(9, 4, 4, 0)].join("\n"),
    );
    expect(capture.complete).toBe(false);
    expect(capture.counts.droppedEvents).toBe(3);
    expect(capture.incompleteReasons).toContain(
      "3 native pipeline event(s) are missing from the sequence",
    );
  });

  it("keeps the finalizer authoritative and rejects a checkpoint that outruns it", () => {
    const finalized = parsePipelineCapture(
      [nativeMetadata(15), marker(1, 2, 10, 12), nativeCheckpoint(9, 1, 1, 0), marker(2, 1, 4, 5), nativeCompletion(2)].join("\n"),
    );
    expect(finalized.complete).toBe(true);
    expect(finalized.boundary).toEqual({ kind: "finalized", events: 2 });
    expect(() =>
      parsePipelineCapture(
        [nativeMetadata(15), marker(1, 2, 10, 12), nativeCheckpoint(9, 4, 1, 3), nativeCompletion(1)].join("\n"),
      ),
    ).toThrow(/checkpoint/u);
  });

  it("refuses checkpoints that disagree with themselves or walk backwards", () => {
    const inconsistent = [nativeMetadata(15), marker(1, 2, 10, 12), nativeCheckpoint(9, 5, 1, 1)].join("\n");
    expect(() => parsePipelineCapture(inconsistent)).toThrow(/checkpoint counts/u);
    const backwards = [
      nativeMetadata(15), marker(1, 2, 10, 12), nativeCheckpoint(9, 2, 2, 0), nativeCheckpoint(10, 1, 1, 0),
    ].join("\n");
    expect(() => parsePipelineCapture(backwards)).toThrow(/checkpoint/u);
  });

  it("joins native service time to renderer provenance by exact pipeline handle", () => {
    const input = pairedCapture();
    const capture = parsePipelineCapture(input);
    expect(capture.complete).toBe(true);
    expect(capture.source).toBe("native");
    expect(capture.events[0]).toMatchObject({
      pipelineIdentity: "native-render-7", pass: "main", serviceMs: 10, queueMs: 2,
      startedMs: 2, settledMs: 12, provenance: { material: { name: "brick" }, unknown: false },
    });
    expect(capture.clock).toEqual({ source: "steady", originMs: 0 });
    expect(summarizePipelineCapture(capture).contributors[0]).toMatchObject({
      label: "material:brick", serviceMs: 10,
    });
  });

  it("preserves observed renderer lookups when native events only count creations", () => {
    const input = pairedCapture(7);

    const summary = summarizePipelineCapture(parsePipelineCapture(JSON.stringify(input)));

    expect(summary.counts.lookups).toBe(7);
    expect(summary.counts.creations).toBe(1);
  });

  // `doctor --capture` hands the parser file bytes, never a parsed object. A paired file carries
  // its native log as one escaped JSON string, so the markers inside it are not marker lines and
  // reading them as such throws on the escaping before the file is parsed as what it is.
  it("reads a paired capture from its file bytes, not only as an object", () => {
    const input = pairedCapture();

    const capture = parsePipelineCapture(JSON.stringify(input));

    expect(capture).toEqual(parsePipelineCapture(input));
    expect(capture.complete).toBe(true);
    expect(capture.source).toBe("native");
    expect(capture.events[0]).toMatchObject({
      pipelineIdentity: "native-render-7", pass: "main", serviceMs: 10,
      provenance: { material: { name: "brick" }, unknown: false },
    });
  });

  it("fails closed on file bytes that are neither valid JSON nor a readable native log", () => {
    const brokenMarker = pairedCapture();
    brokenMarker.nativeLog = brokenMarker.nativeLog.replace('"eventId":1,', '"eventId":,');
    expect(() => parsePipelineCapture(JSON.stringify(brokenMarker))).toThrow(/carries invalid JSON/u);
    expect(() => parsePipelineCapture('{"version":1,"census":')).toThrow(/neither JSON nor a native event log/u);
    expect(() => parsePipelineCapture(JSON.stringify({ ...pairedCapture(), version: 2 }))).toThrow(
      /paired capture requires version 1/u,
    );
  });

  it("refuses mismatched shader content and missing pipeline joins", () => {
    const input = pairedCapture();
    input.census.events[0].fragment = { hash: "different", bytes: 21 };
    expect(() => parsePipelineCapture(input)).toThrow(/shader.*mismatch/u);
    const missing = pairedCapture();
    missing.census.events[0].pipelineIdentity = "native-render-8";
    expect(() => parsePipelineCapture(missing)).toThrow(/unmatched.*pipeline/u);
  });

  it("preserves incomplete native evidence when renderer attribution is complete", () => {
    const input = pairedCapture();
    input.nativeLog = input.nativeLog.replace(nativeCompletion(1), "");
    const capture = parsePipelineCapture(input);
    expect(capture.complete).toBe(false);
    expect(capture.incompleteReasons).toContain("native marker capture is missing its completion marker");
  });

  it("compares shader stages rather than absent-stage program labels", () => {
    const input = pairedCapture();
    delete input.census.events[0].fragment;
    input.census.events[0].programIdentity = "v/unknown";
    input.nativeLog = [nativeMetadata(15), marker(1, 2, 10, 12, {
      pipelineIdentity: "native-render-7", programIdentity: "v/", mode: "sync",
      vertex: input.census.events[0].vertex, fragment: undefined,
    }), nativeCompletion(1)].join("\n");
    expect(() => parsePipelineCapture(input)).not.toThrow();
    expect(parsePipelineCapture(input).complete).toBe(true);
  });

  it("retains native utility pipelines with explicitly unknown renderer provenance", () => {
    const input = pairedCapture();
    input.nativeLog = input.nativeLog.replace(nativeCompletion(1), [marker(2, 0, 2, 2, {
      pipelineIdentity: "native-render-8", pass: "unknown", label: "mipmap-rgba8unorm",
    }), nativeCompletion(2)].join("\n"));
    const capture = parsePipelineCapture(input);
    expect(capture.complete).toBe(true);
    expect(capture.counts.creations).toBe(2);
    expect(capture.events[1]).toMatchObject({
      pipelineIdentity: "native-render-8", pass: "unknown", provenance: { unknown: true }, serviceMs: 2,
    });
  });

  it("separates queue delay from service time when asynchronous jobs overlap", () => {
    const capture = parsePipelineCapture([marker(1, 5, 10, 15), marker(2, 1, 10, 11)].join("\n"));
    const summary = summarizePipelineCapture(capture);

    expect(capture.complete).toBe(false);
    expect(capture.counts).toMatchObject({ creations: 2, recordedEvents: 2, droppedEvents: 0 });
    expect(summary.passTotals.map(({ pass }) => pass)).toEqual(["main", "shadow"]);
    expect(summary.sizeTime.samples).toBe(2);
    expect(summary.warmup.unreported).toBe(2);
    expect(formatPipelineSummary(summary)).toContain("service");
  });

  it("requires launch metadata before a browser capture can be complete", () => {
    const input = browserCapture([browserEvent()]);
    input.build = undefined;
    input.adapter = undefined;
    input.firstPresent = undefined;

    const capture = parsePipelineCapture(input);

    expect(capture.complete).toBe(false);
    expect(capture.incompleteReasons).toEqual(expect.arrayContaining([
      "capture is missing its build identity",
      "capture is missing its adapter identity",
      "capture is missing its thermal identity",
      "capture is missing its first-present boundary",
    ]));
  });

  it("requires both shader stages for render size and service correlation", () => {
    const summary = summarizePipelineCapture(parsePipelineCapture(marker(1, 0, 4, 4)));

    expect(summary.sizeTime.byPass[0]).toMatchObject({ meanBytes: 302, samples: 1 });
    expect(formatPipelineSummary(summary)).toContain("mean 302.0 bytes");
  });

  it("rejects provenance that is both unknown and attributed", () => {
    expect(() => parsePipelineCapture(browserCapture([
      browserEvent({ provenance: { material: { name: "brick" }, unknown: true } }),
    ]))).toThrow(/unknown provenance cannot include material or object/u);
  });

  it("fails closed when one native event is missing from the sequence", () => {
    const capture = parsePipelineCapture([marker(1, 0, 4, 4), marker(3, 0, 6, 6)].join("\n"));

    expect(capture.complete).toBe(false);
    expect(capture.counts.droppedEvents).toBe(1);
    expect(capture.incompleteReasons.join(" ")).toMatch(/missing/u);
  });

  it("fails closed when the final native event is missing from an otherwise contiguous capture", () => {
    const capture = parsePipelineCapture([
      nativeMetadata(),
      nativeCompletion(2),
      marker(1, 0, 4, 4),
    ].join("\n"));

    expect(capture.complete).toBe(false);
    expect(capture.incompleteReasons).toContain("native pipeline event count does not match the completion marker");
  });

  it("accepts a native marker capture with launch metadata and first-present evidence", () => {
    const capture = parsePipelineCapture([
      nativeMetadata(),
      nativeCompletion(1),
      marker(1, 0, 4, 4),
    ].join("\n"));

    expect(capture.complete).toBe(true);
    expect(capture.build).toMatchObject({ identity: "native:0.3.0" });
    expect(capture.adapter).toMatchObject({ identity: "vendor/device", thermal: "unavailable" });
    expect(capture.firstPresent).toEqual({ boundaryMs: 5, eventsSettled: 1 });
    expect(capture.events[0]?.beforeFirstPresent).toBe(true);
  });

  it("accepts a browser census and keeps material attribution separate from program identity", () => {
    const capture = parsePipelineCapture(browserCapture([browserEvent()], {
      firstPresent: { boundaryMs: 4, eventsSettled: 1 },
    }));
    const summary = summarizePipelineCapture(capture);

    expect(summary.complete).toBe(true);
    expect(summary.contributors[0]).toMatchObject({ label: "material:brick", creations: 1 });
    expect(summary.programReasons[0]).toMatchObject({ programIdentity: "shader-pair", reasons: ["map"] });
    expect(summary.warmup.beforeFirstPresent).toBe(1);
  });

  it("reports node builds and render creations after the warm-up boundary", () => {
    const events = [
      browserEvent({ nodeBuilds: 3, beforeWarmUpSettled: true }),
      browserEvent({
        beforeFirstPresent: false,
        beforeWarmUpSettled: false,
        pipelineIdentity: "backend-pipeline-2",
        sequence: 2,
        settledMs: 5,
        nodeBuilds: 1,
      }),
      browserEvent({
        beforeFirstPresent: false,
        beforeWarmUpSettled: false,
        provenance: { material: { name: "bloom" }, unknown: false },
        pipelineIdentity: "backend-pipeline-3",
        sequence: 3,
        settledMs: 6,
      }),
    ];
    const capture = parsePipelineCapture(browserCapture(events, {
      counts: {
        lookups: 3,
        creations: 3,
        failures: 0,
        pending: 0,
        uniquePrograms: 1,
        uniquePipelines: 3,
        recordedEvents: 3,
        droppedEvents: 0,
        nodeBuilds: 4,
      },
      firstPresent: { boundaryMs: 4, eventsSettled: 1 },
      warmUpSettled: {
        boundaryMs: 4,
        eventsSettled: 1,
        nodeBuilds: 3,
        renderPipelineCreations: 1,
      },
    }));
    const summary = summarizePipelineCapture(capture);

    expect(summary.warmup).toMatchObject({
      afterWarmUpSettled: 2,
      nodeBuildsAfterWarmUpSettled: 1,
      renderPipelineCreationsAfterWarmUpSettled: 2,
      warmedNodeBuildsAfterWarmUpSettled: 1,
      warmedRenderPipelineCreationsAfterWarmUpSettled: 1,
    });
  });

  it("summarizes repeatable streamed warm-up scopes", () => {
    const capture = parsePipelineCapture(browserCapture([
      browserEvent({ nodeBuilds: 1, beforeWarmUpSettled: true }),
      browserEvent({
        beforeFirstPresent: false,
        beforeWarmUpSettled: false,
        afterWarmUpScope: "chunk:0",
        sequence: 2,
        settledMs: 5,
        nodeBuilds: 0,
      }),
    ], {
      counts: {
        lookups: 2,
        creations: 2,
        failures: 0,
        pending: 0,
        uniquePrograms: 1,
        uniquePipelines: 2,
        recordedEvents: 2,
        droppedEvents: 0,
        nodeBuilds: 1,
      },
      firstPresent: { boundaryMs: 4, eventsSettled: 1 },
      warmUpSettled: { boundaryMs: 1, eventsSettled: 1, nodeBuilds: 1, renderPipelineCreations: 1 },
      warmUpScopes: [{ label: "chunk:0", boundaryMs: 4, eventsSettled: 1, nodeBuilds: 1, renderPipelineCreations: 1 }],
    }));
    expect(summarizePipelineCapture(capture).warmup.scopes).toEqual([
      { label: "chunk:0", nodeBuilds: 0, renderPipelineCreations: 1 },
    ]);
  });

  it.each([
    ["keeps the maximum for each metric", [
      { nodeBuilds: 2, renderPipelineCreations: 0 },
      { nodeBuilds: 0, renderPipelineCreations: 3 },
      { nodeBuilds: 0, renderPipelineCreations: 0 },
    ], { nodeBuilds: 2, renderPipelineCreations: 3, observed: true }],
    ["does not hide a missing later draw", [
      { nodeBuilds: 2, renderPipelineCreations: 1 }, undefined,
    ], { nodeBuilds: 2, renderPipelineCreations: 1 }],
    ["does not hide a missing earlier draw", [
      undefined, { nodeBuilds: 2, renderPipelineCreations: 1 },
    ], { nodeBuilds: 2, renderPipelineCreations: 1 }],
  ])("repeated warm-up label %s", (_name, draws, expected) => {
    const capture = parsePipelineCapture(browserCapture([browserEvent()], {
      warmUpScopes: draws.map((firstDraw, index) => ({
        label: "chunk:0",
        boundaryMs: 4 + index,
        eventsSettled: 1,
        nodeBuilds: 0,
        renderPipelineCreations: 1,
        ...(firstDraw === undefined ? {} : { firstDraw }),
      })),
    }));
    expect(capture.complete).toBe(true);
    expect(summarizePipelineCapture(capture).warmup.scopes).toEqual([
      { label: "chunk:0", ...expected },
    ]);
  });

  it("attributes node-build records when the later render reuses its cached pipeline", () => {
    const capture = parsePipelineCapture(
      browserCapture(
        [
          browserEvent({
            beforeFirstPresent: false,
            beforeWarmUpSettled: false,
            afterWarmUpScope: "chunk:0",
            settledMs: 5,
            nodeBuilds: 0,
          }),
        ],
        {
          counts: {
            lookups: 1,
            creations: 1,
            failures: 0,
            pending: 0,
            uniquePrograms: 1,
            uniquePipelines: 1,
            recordedEvents: 1,
            droppedEvents: 0,
            nodeBuilds: 2,
          },
          warmUpSettled: {
            boundaryMs: 1,
            eventsSettled: 0,
            nodeBuilds: 1,
            renderPipelineCreations: 0,
          },
          warmUpScopes: [
            {
              label: "chunk:0",
              boundaryMs: 2,
              eventsSettled: 0,
              nodeBuilds: 1,
              renderPipelineCreations: 0,
              firstDraw: { nodeBuilds: 1, renderPipelineCreations: 0 },
            },
          ],
          nodeBuilds: [
            {
              provenance: { material: { name: "brick" }, unknown: false },
              startedMs: 0,
              beforeFirstPresent: true,
              beforeWarmUpSettled: true,
            },
            {
              provenance: { material: { name: "brick" }, unknown: false },
              startedMs: 2,
              beforeFirstPresent: true,
              beforeWarmUpSettled: false,
              afterWarmUpScope: "chunk:0",
            },
          ],
        },
      ),
    );
    const summary = summarizePipelineCapture(capture);
    expect(summary.warmup.warmedNodeBuildsAfterWarmUpSettled).toBe(1);
    expect(summary.warmup.scopes).toEqual([
      { label: "chunk:0", nodeBuilds: 1, renderPipelineCreations: 0, observed: true },
    ]);
    expect(summary.contributors.find(({ label }) => label === "material:brick")).toMatchObject({
      nodeBuilds: 2,
    });
  });

  it("requires a version before treating an events object as a browser capture", () => {
    expect(() => parsePipelineCapture({ events: [browserEvent()] })).toThrow(/missing its version/u);
  });

  it("marks status/count disagreement incomplete instead of trusting declared counts", () => {
    const event = browserEvent({ error: "compile failed", status: "failed" });
    const input = browserCapture([event], {
      counts: {
        lookups: 1,
        creations: 1,
        failures: 0,
        pending: 0,
        uniquePrograms: 1,
        uniquePipelines: 1,
        recordedEvents: 1,
        droppedEvents: 0,
      },
    });
    const summary = summarizePipelineCapture(parsePipelineCapture(input));

    expect(summary.complete).toBe(false);
    expect(summary.incompleteReasons).toContain("failure count does not match event statuses");
  });

  it("rejects negative or out-of-order browser timing data", () => {
    expect(() => parsePipelineCapture(browserCapture([browserEvent({ startedMs: -1 })]))).toThrow(/non-negative/u);
    expect(() => parsePipelineCapture(browserCapture([browserEvent({ settledMs: 2, startedMs: 3 })]))).toThrow(/precedes/u);
    expect(() => parsePipelineCapture(browserCapture([
      browserEvent({ sequence: 2 }),
      browserEvent({ pipelineIdentity: "backend-pipeline-2" }),
    ]))).toThrow(/strictly increasing/u);
  });

  it("requires the native marker version and keeps service time unavailable distinct", () => {
    expect(() => parsePipelineCapture(marker(1, 0, 4, 4).replace('"version":1,', ""))).toThrow(/version/u);
    const event = browserEvent({ mode: "async", promiseMs: 8, serviceMs: undefined });
    const summary = summarizePipelineCapture(parsePipelineCapture(browserCapture([event])));

    expect(summary.passTotals[0]?.serviceMs).toBeUndefined();
    expect(formatPipelineSummary(summary)).toContain("unavailable service");
  });

  it("classifies native Three labels without treating them as stable provenance", () => {
    const capture = parsePipelineCapture(marker(1, 0, 4, 4, {
      pass: "unknown",
      label: "renderPipeline_PMREM_Background_12",
      provenance: { unknown: true },
    }));

    expect(capture.events[0]).toMatchObject({ pass: "pmrem", label: "renderPipeline_PMREM_Background_12" });
    expect(capture.events[0]?.provenance.unknown).toBe(true);
  });

  it("accepts the engine capture nested in a playtest observation report", () => {
    const capture = parsePipelineCapture({ observations: { pipelineCensus: browserCapture([browserEvent()]) } });

    expect(capture.source).toBe("browser");
    expect(capture.counts.creations).toBe(1);
  });

  // PRD-368. The host prints what its device pipeline cache did, and stamps each event with the
  // cache mode in force. Neither is something this reader consumes yet, and neither may make it
  // refuse a capture: a log that a native run really produces has to parse, or the pipeline census
  // goes dark on exactly the runs the cache work is measured on.
  it("reads a capture carrying the host's pipeline cache lines", () => {
    const cacheLines = [
      'TN_PIPELINE_CACHE:{"version":1,"phase":"device","mode":"attached","featureGranted":true,"renderAttached":0,"computeAttached":0,"emptyBytes":100,"serializedBytes":100}',
      'TN_PIPELINE_CACHE:{"version":1,"phase":"shutdown","mode":"attached","featureGranted":true,"renderAttached":2,"computeAttached":2,"emptyBytes":100,"serializedBytes":32515}',
    ];
    const cachedEvent = desktopEvents[0].replace('"provenance":{"unknown":true}', '"provenance":{"unknown":true},"cache":"attached"');
    const capture = parsePipelineCapture(
      [cacheLines[0], desktopMetadata, cachedEvent, cacheLines[1], nativeCompletion(1)].join("\n"),
    );

    expect(capture.source).toBe("native");
    expect(capture.complete).toBe(true);
    expect(capture.incompleteReasons).toEqual([]);
    expect(capture.counts.creations).toBe(1);
  });
});
