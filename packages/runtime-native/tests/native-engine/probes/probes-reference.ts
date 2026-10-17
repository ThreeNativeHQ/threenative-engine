/**
 * Records `ProbeVolume`'s CPU decisions for a set of volume descriptions as a C++ table the native
 * test rebuilds (PRD-525). It drives the REAL module in packages/core (the same fake renderer the
 * unit spec uses) and records, per volume:
 *
 *   - placement: the probe grid resolution, the padded atlas geometry and every probe world position;
 *   - slots: the atlas slice each probe's z index occupies in each of the seven packed sub-volumes;
 *   - the schedule: the flat list of work items the bounded bake ran over 60 frames, and the number
 *     of items per frame. A mid-run `requestBake` records that the reference coalesces it.
 *
 * The per-work-item costs the fake renderer injects are recorded too, because the reference's time
 * budget is measured against the wall clock. The native port takes those costs as data instead of
 * reading a clock, so both sides can be compared exactly. Every double is recorded as its binary64
 * bit pattern, so the comparison is bit for bit except that any two NaNs are equal.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/probes/probes-reference.ts
 *   ... -- --check   (fails when the committed table is not what the core module produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Box3, Scene, Vector3, WebGPUCoordinateSystem } from "three";

import { ATLAS_PADDING, ProbeVolume } from "../../../../core/src/render/probe-volume.js";
import type { IRendererLike } from "../../../../core/src/renderer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "probes_reference.inc");

const FRAME_COUNT = 60;
const REQUEST_FRAME = 2;
const RENDER_COST = 1;
const COPY_COST = 0.25;

const f64 = (x: number) => {
  const words = new Uint32Array(new Float64Array([x]).buffer);
  return (BigInt(words[1] as number) << 32n) | BigInt(words[0] as number);
};
const bits = (x: number) => `0x${f64(x).toString(16).padStart(16, "0")}ull`;

type Density = number | readonly [number, number, number] | { x: number; y: number; z: number };

/** Every accepted density shape as the three per-axis values the volume normalizes to. */
function densityTuple(density: Density): [number, number, number] {
  if (typeof density === "number") return [density, density, density];
  if (Array.isArray(density))
    return [density[0] as number, density[1] as number, density[2] as number];
  const object = density as { x: number; y: number; z: number };
  return [object.x, object.y, object.z];
}

interface ISpec {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  density: Density;
  budget: number;
  maxItems: number;
  bounces: number;
  minPixelsLimit?: number;
}

interface IWork {
  kind: number; // 0 capture, 1 project, 2 copy, 3 repack
  pass: number;
  probe: number;
  face: number;
  repack: number;
}

interface IRecord {
  spec: ISpec;
  resolution: [number, number, number];
  paddedSlices: number;
  atlasDepth: number;
  probeCount: number;
  atlasBytes: number;
  boundsMin: [number, number, number];
  boundsSize: [number, number, number];
  positions: number[];
  slots: number[];
  work: IWork[];
  frameCounts: number[];
  coalesced: boolean;
}

/** The fake renderer records which work item ran from the calls `ProbeVolume` makes. */
function fakeRenderer(
  bakeScene: Scene,
  boundsMin: readonly number[],
  boundsSize: readonly number[],
  resolution: readonly number[],
) {
  const log: Omit<IWork, "pass">[] = [];
  let pending: { target: unknown; face: number } | null = null;
  let lastProbe = 0;

  const positionToProbe = (x: number, y: number, z: number): number => {
    const index = (axis: number, value: number): number => {
      const size = boundsSize[axis] as number;
      const res = resolution[axis] as number;
      // resolution >= 2, size > 0, so the reference's placement formula inverts exactly here.
      return Math.round(((value - (boundsMin[axis] as number)) * (res - 1)) / size);
    };
    const ix = index(0, x);
    const iy = index(1, y);
    const iz = index(2, z);
    return (
      ix +
      iy * (resolution[0] as number) +
      iz * (resolution[0] as number) * (resolution[1] as number)
    );
  };

  const raw = {
    coordinateSystem: WebGPUCoordinateSystem,
    copyTextureToTexture: (
      _source: unknown,
      _destination: unknown,
      _region: unknown,
      destinationPosition: { x: number; y: number },
    ) => {
      log.push({ kind: 2, probe: destinationPosition.y, face: 0, repack: 0 });
    },
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getRenderTarget: () => null,
    isWebGLRenderer: false,
    render: (
      scene: Scene,
      camera: { parent?: { position: { x: number; y: number; z: number } } },
    ) => {
      if (scene === bakeScene) {
        const position = camera.parent?.position;
        if (position === undefined)
          throw new Error("probe reference: capture render has no cube camera parent");
        lastProbe = positionToProbe(position.x, position.y, position.z);
        log.push({ kind: 0, probe: lastProbe, face: pending?.face ?? 0, repack: 0 });
      } else if (pending !== null && isRenderTarget3D(pending.target)) {
        log.push({ kind: 3, probe: 0, face: 0, repack: pending.face });
      } else {
        log.push({ kind: 1, probe: lastProbe, face: 0, repack: 0 });
      }
      pending = null;
    },
    reversedDepthBuffer: false,
    setRenderTarget: (target: unknown, face = 0) => {
      pending = { target, face };
    },
    xr: { enabled: false },
  };
  return { log, renderer: { kind: "webgpu" as const, raw } } as unknown as {
    log: Omit<IWork, "pass">[];
    renderer: IRendererLike;
  };
}

function isRenderTarget3D(target: unknown): boolean {
  return (
    typeof target === "object" &&
    target !== null &&
    (target as { isRenderTarget3D?: boolean }).isRenderTarget3D === true
  );
}

function record(spec: ISpec): IRecord {
  let nowMs = 0;
  const scene = new Scene();
  const subject = new ProbeVolume({
    bounds: new Box3(new Vector3(...spec.min), new Vector3(...spec.max)),
    density: spec.density,
    ...(spec.minPixelsLimit === undefined ? {} : { maxTextureDimension3D: spec.minPixelsLimit }),
    bakeBudgetMs: spec.budget,
    maxWorkItemsPerFrame: spec.maxItems,
    bounces: spec.bounces,
    now: () => nowMs,
    report: () => undefined,
  });
  const boundsMin: [number, number, number] = [
    subject.boundingBox.min.x,
    subject.boundingBox.min.y,
    subject.boundingBox.min.z,
  ];
  const resolution: [number, number, number] = [
    subject.resolution.x,
    subject.resolution.y,
    subject.resolution.z,
  ];
  const boundsSize: [number, number, number] = [
    subject.boundingBox.max.x - boundsMin[0],
    subject.boundingBox.max.y - boundsMin[1],
    subject.boundingBox.max.z - boundsMin[2],
  ];
  const fake = fakeRenderer(scene, boundsMin, boundsSize, resolution);
  // The fake renderer advances the injected clock on every call, exactly as the spec's budget tests do.
  const rawCalls = (
    fake.renderer as unknown as {
      raw: {
        render: (...args: unknown[]) => void;
        copyTextureToTexture: (...args: unknown[]) => void;
      };
    }
  ).raw;
  const render = rawCalls.render;
  const copy = rawCalls.copyTextureToTexture;
  rawCalls.render = (...args: unknown[]) => {
    nowMs += RENDER_COST;
    render(...args);
  };
  rawCalls.copyTextureToTexture = (...args: unknown[]) => {
    nowMs += COPY_COST;
    copy(...args);
  };

  subject.attachRenderer(fake.renderer);
  const firstPromise = subject.requestBake(scene);

  const positions: number[] = [];
  for (let iz = 0; iz < resolution[2]; iz += 1) {
    for (let iy = 0; iy < resolution[1]; iy += 1) {
      for (let ix = 0; ix < resolution[0]; ix += 1) {
        const position = subject.probePosition(ix, iy, iz);
        positions.push(position.x, position.y, position.z);
      }
    }
  }
  const slots: number[] = [];
  for (let subVolume = 0; subVolume < 7; subVolume += 1) {
    for (let iz = 0; iz < resolution[2]; iz += 1) {
      slots.push(subVolume * subject.paddedSlices + ATLAS_PADDING + iz);
    }
  }

  const workPerPass = subject.probeCount * 8 + 7 * subject.paddedSlices;
  const work: IWork[] = [];
  const frameCounts: number[] = [];
  let coalesced = false;
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    if (frame === REQUEST_FRAME) {
      coalesced = subject.requestBake(scene) === firstPromise;
    }
    fake.log.length = 0;
    subject.process(fake.renderer);
    for (const item of fake.log) {
      work.push({ ...item, pass: Math.floor(work.length / workPerPass) });
    }
    frameCounts.push(fake.log.length);
  }

  return {
    spec,
    resolution,
    paddedSlices: subject.paddedSlices,
    atlasDepth: subject.atlasDepth,
    probeCount: subject.probeCount,
    atlasBytes: subject.atlasBytes,
    boundsMin,
    boundsSize,
    positions,
    slots,
    work,
    frameCounts,
    coalesced,
  };
}

/* ---- the volumes ---- */

const specs: ISpec[] = [
  {
    min: [0, 0, 0],
    max: [2, 2, 2],
    density: 1,
    budget: 3,
    maxItems: 1000,
    bounces: 0,
    minPixelsLimit: 64,
  },
  {
    min: [-1, -1, -1],
    max: [1, 1, 1],
    density: [0.5, 1, 1.5],
    budget: 4,
    maxItems: 2,
    bounces: 0,
    minPixelsLimit: 64,
  },
  {
    min: [10, 0, -5],
    max: [12, 2, -3],
    density: 2,
    budget: 5,
    maxItems: 3,
    bounces: 0,
    minPixelsLimit: 64,
  },
  {
    min: [0, 0, 0],
    max: [1, 1, 1],
    density: 1,
    budget: 20,
    maxItems: 1000,
    bounces: 1,
    minPixelsLimit: 64,
  },
  {
    min: [-3, 2, -1],
    max: [-1, 4, 1],
    density: { x: 1.5, y: 1.5, z: 1.5 },
    budget: 2,
    maxItems: 1000,
    bounces: 0,
    minPixelsLimit: 64,
  },
];

const recorded = specs.map((spec) => record(spec));

/* ---- refusals: the module throws, the native side returns a named code ---- */

interface IRefusalSpec {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  density: Density;
  budget: number;
  maxItems: number;
  bounces: number;
  minPixelsLimit?: number;
  stage: 0 | 1; // 0 = placement, 1 = schedule options
  code: string;
}

const refusals: IRefusalSpec[] = [
  {
    min: [0, 0, 0],
    max: [0, 2, 2],
    density: 1,
    budget: 2,
    maxItems: 1,
    bounces: 0,
    stage: 0,
    code: "TN_PROBES_BOUNDS",
  },
  {
    min: [0, 0, 0],
    max: [2, 2, Number.POSITIVE_INFINITY],
    density: 1,
    budget: 2,
    maxItems: 1,
    bounces: 0,
    stage: 0,
    code: "TN_PROBES_BOUNDS",
  },
  {
    min: [0, 0, 0],
    max: [2, 2, 2],
    density: 0,
    budget: 2,
    maxItems: 1,
    bounces: 0,
    stage: 0,
    code: "TN_PROBES_DENSITY",
  },
  {
    min: [0, 0, 0],
    max: [2, 2, 2],
    density: [1, -1, 1],
    budget: 2,
    maxItems: 1,
    bounces: 0,
    stage: 0,
    code: "TN_PROBES_DENSITY",
  },
  {
    min: [0, 0, 0],
    max: [2, 2, 2],
    density: 1,
    budget: 2,
    maxItems: 1,
    bounces: 0,
    minPixelsLimit: 1,
    stage: 0,
    code: "TN_PROBES_TEXTURE_LIMIT",
  },
  {
    min: [0, 0, 0],
    max: [2, 2, 2],
    density: 1,
    budget: 0,
    maxItems: 1,
    bounces: 0,
    stage: 1,
    code: "TN_PROBES_OPTIONS",
  },
  {
    min: [0, 0, 0],
    max: [2, 2, 2],
    density: 1,
    budget: 2,
    maxItems: 0,
    bounces: 0,
    stage: 1,
    code: "TN_PROBES_OPTIONS",
  },
];
for (const refusal of refusals) {
  // Confirm the real module refuses each of these, so the table is not asserting dead behaviour.
  let threw = false;
  try {
    new ProbeVolume({
      bounds: new Box3(new Vector3(...refusal.min), new Vector3(...refusal.max)),
      density: refusal.density,
      ...(refusal.minPixelsLimit === undefined
        ? {}
        : { maxTextureDimension3D: refusal.minPixelsLimit }),
      report: () => undefined,
    });
  } catch {
    threw = true;
  }
  if (refusal.stage === 0 && !threw)
    throw new Error(`probe reference: expected a refusal for ${refusal.code}`);
}

/* ---- emit ---- */

const lines = [
  "// Generated by packages/runtime-native/tests/native-engine/probes/probes-reference.ts",
  "// from packages/core/src/render/probe-volume.ts. Do not edit: rerun the generator. Doubles are",
  "// binary64 bit patterns; counts are decimal integers.",
  "",
  "struct RefProbeWork {",
  "    uint32_t kind;",
  "    uint32_t pass;",
  "    uint32_t probe;",
  "    uint32_t face;",
  "    uint32_t repack;",
  "};",
  "",
];

for (const [index, entry] of recorded.entries()) {
  lines.push(
    `// volume ${index}: ${entry.resolution.join("x")} probes, atlasDepth ${entry.atlasDepth}, budget ${entry.spec.budget}ms, maxItems ${entry.spec.maxItems}, bounces ${entry.spec.bounces}`,
  );
  lines.push(`static const uint64_t kProbePositions${index}[] = {`);
  const positionLines: string[] = [];
  for (let probe = 0; probe < entry.probeCount; probe += 1) {
    positionLines.push(
      `    ${bits(entry.positions[probe * 3] as number)}, ${bits(entry.positions[probe * 3 + 1] as number)}, ${bits(entry.positions[probe * 3 + 2] as number)},`,
    );
  }
  lines.push(...positionLines, "};", "");
  lines.push(`static const uint32_t kProbeSlots${index}[] = {`);
  lines.push(`    ${entry.slots.join(", ")},`);
  lines.push("};", "");
  lines.push(`static const RefProbeWork kProbeWork${index}[] = {`);
  for (const item of entry.work) {
    lines.push(`    {${item.kind}, ${item.pass}, ${item.probe}, ${item.face}, ${item.repack}},`);
  }
  lines.push("};", "");
  lines.push(`static const uint32_t kProbeFrameCounts${index}[] = {`);
  lines.push(`    ${entry.frameCounts.join(", ")},`);
  lines.push("};", "");
}

lines.push("static const RefProbeVolume kProbeVolumes[] = {");
for (const [index, entry] of recorded.entries()) {
  const spec = entry.spec;
  const density = densityTuple(spec.density);
  lines.push(
    `    {{${bits(spec.min[0])}, ${bits(spec.min[1])}, ${bits(spec.min[2])}}, ` +
      `{${bits(spec.max[0])}, ${bits(spec.max[1])}, ${bits(spec.max[2])}}, ` +
      `{${bits(density[0])}, ${bits(density[1])}, ${bits(density[2])}}, ` +
      `${spec.minPixelsLimit === undefined ? "false" : "true"}, ${bits(spec.minPixelsLimit ?? 0)}, ` +
      `${bits(spec.budget)}, ${spec.maxItems}u, ${spec.bounces}u, ` +
      `{${bits(RENDER_COST)}, ${bits(RENDER_COST)}, ${bits(COPY_COST)}, ${bits(RENDER_COST)}}, ` +
      `{{${entry.resolution[0]}u, ${entry.resolution[1]}u, ${entry.resolution[2]}u}, ${entry.paddedSlices}u, ${entry.atlasDepth}u, ` +
      `${entry.probeCount}ull, ${entry.atlasBytes}ull}, ` +
      `{${bits(entry.boundsMin[0])}, ${bits(entry.boundsMin[1])}, ${bits(entry.boundsMin[2])}}, ` +
      `{${bits(entry.boundsSize[0])}, ${bits(entry.boundsSize[1])}, ${bits(entry.boundsSize[2])}}, ` +
      `kProbePositions${index}, kProbeSlots${index}, ` +
      `kProbeWork${index}, std::size(kProbeWork${index}), kProbeFrameCounts${index}, std::size(kProbeFrameCounts${index}), ` +
      `${REQUEST_FRAME}u, ${String(entry.coalesced)}},`,
  );
}
lines.push("};", "");

lines.push("enum RefProbeRefusalStage { RefProbeRefusePlace = 0, RefProbeRefuseOptions = 1 };");
lines.push("struct RefProbeRefusal {");
lines.push("    uint64_t min[3];");
lines.push("    uint64_t max[3];");
lines.push("    uint64_t density[3];");
lines.push("    bool hasLimit;");
lines.push("    uint64_t limit;");
lines.push("    uint64_t budget;");
lines.push("    uint32_t maxItems;");
lines.push("    uint32_t bounces;");
lines.push("    uint32_t stage;");
lines.push("    const char* code;");
lines.push("};");
lines.push("");
lines.push("static const RefProbeRefusal kProbeRefusals[] = {");
for (const refusal of refusals) {
  const density = densityTuple(refusal.density);
  lines.push(
    `    {{${bits(refusal.min[0])}, ${bits(refusal.min[1])}, ${bits(refusal.min[2])}}, ` +
      `{${bits(refusal.max[0])}, ${bits(refusal.max[1])}, ${bits(refusal.max[2])}}, ` +
      `{${bits(density[0])}, ${bits(density[1])}, ${bits(density[2])}}, ` +
      `${refusal.minPixelsLimit === undefined ? "false" : "true"}, ${bits(refusal.minPixelsLimit ?? 0)}, ` +
      `${bits(refusal.budget)}, ${refusal.maxItems}u, ${refusal.bounces}u, ${refusal.stage}u, ${JSON.stringify(refusal.code)}},`,
  );
}
lines.push("};", "");

const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error("TN_FIXTURE_STALE: probes_reference.inc is not what the core module produces");
    process.exit(1);
  }
  console.log("current: probes_reference.inc");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
