import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliDecompressSync } from "node:zlib";
import { Texture } from "three";
import { vec3 } from "three/tsl";
import { PMREMGenerator, PMREMNode } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

// @ts-expect-error -- the postinstall helper is plain ESM with no type declarations.
import { applyThreePatch } from "../scripts/apply-three-patch.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));

// A frozen, test-only copy of the legacy unified migration and the exact files the previous
// release shipped. Production no longer carries this format, so the fixture is the only stable
// reference for the migration the reader must still recognise.
const FIXTURE = JSON.parse(
  brotliDecompressSync(
    readFileSync(join(testDir, "fixtures", "legacy-three-patch.json.br")),
  ).toString("utf8"),
) as {
  originalBasePatch: string;
  originalUpgradePatch: string;
  targetTexts: Record<string, string>;
};

const RESOURCE_LIFETIME_PREDECESSORS = JSON.parse(
  brotliDecompressSync(
    readFileSync(join(testDir, "fixtures", "resource-lifetime-predecessors.json.br")),
  ).toString("utf8"),
) as Record<string, string>;

const GENERATED_UPGRADE = JSON.parse(
  readFileSync(
    join(resolve("packages/core"), "patches", "three@0.185.1-prd269-upgrade.patch"),
    "utf8",
  ),
) as {
  generatedFinalHashes: Record<string, string>;
  bundleBrotliBase64: string;
};
const GENERATED_FINAL_HASHES = GENERATED_UPGRADE.generatedFinalHashes;
const GENERATED_TARGET_TEXTS = JSON.parse(
  brotliDecompressSync(Buffer.from(GENERATED_UPGRADE.bundleBrotliBase64, "base64")).toString(
    "utf8",
  ),
) as Record<string, string>;
const GENERATED_BASE_PATCH = readFileSync(
  join(resolve("packages/core"), "patches", "three@0.185.1.patch"),
  "utf8",
);

const roots: string[] = [];

// three's declarations omit the members packages/core/patches/three@0.185.1.patch adds to PMREMNode.
const PatchedPMREMNode = PMREMNode as typeof PMREMNode & {
  prepareTextureAsync(renderer: unknown, texture: Texture): Promise<boolean>;
};
type PatchedPMREMNodeInstance = PMREMNode & { updateFromTexture(texture: Texture): void };

it("preserves the async PMREM API's synchronous fallback on non-WebGPU backends", async () => {
  const syncTarget = {};
  const generator = Object.create(PMREMGenerator.prototype) as {
    _renderer: { backend: { isWebGPUBackend?: boolean }; init: () => Promise<void> };
    _fromTexture: (...args: unknown[]) => unknown;
    _fromTextureAsync: (...args: unknown[]) => Promise<unknown>;
    fromEquirectangularAsync: (...args: unknown[]) => Promise<unknown>;
    fromCubemapAsync: (...args: unknown[]) => Promise<unknown>;
  };
  generator._renderer = {
    backend: { isWebGLBackend: true } as never,
    init: vi.fn(async () => undefined),
  };
  generator._fromTexture = vi.fn(() => syncTarget);
  generator._fromTextureAsync = vi.fn(async () => {
    throw new Error("WebGPU-only async path must not run on WebGL");
  });

  await expect(generator.fromEquirectangularAsync({} as never)).resolves.toBe(syncTarget);
  await expect(generator.fromCubemapAsync({} as never)).resolves.toBe(syncTarget);
  expect(generator._renderer.init).toHaveBeenCalledTimes(2);
  expect(generator._fromTexture).toHaveBeenCalledTimes(2);
  expect(generator._fromTextureAsync).not.toHaveBeenCalled();
});

// Removing the copied three trees took over 10 s on a loaded CI runner (run 39217177505).
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
}, 60_000);

async function tempRoot(): Promise<string> {
  const root = await makeTempDir("threenative-three-patch-");
  roots.push(root);
  return root;
}

const THREE_VERSION = "0.185.1";
const STOCK = [
  "const alpha = 1;",
  "const beta = 2;",
  "const gamma = 3;",
  "const delta = 4;",
  "const epsilon = 5;",
  "",
];

/** What the previous release's patch left behind: hunk one applied, hunk two not yet written. */
const PATCHED_BY_THE_PREVIOUS_RELEASE = [
  "const alpha = 1; // threenative: one",
  "const beta = 2;",
  "const gamma = 3;",
  "const delta = 4;",
  "const epsilon = 5;",
  "",
];

const FULLY_PATCHED = [
  "const alpha = 1; // threenative: one",
  "const beta = 2;",
  "const gamma = 3; // threenative: two",
  "const delta = 4;",
  "const epsilon = 5;",
  "",
];

it("fences each PMREM cube face and restores renderer MRT and draw state before awaiting", async () => {
  const events: string[] = [];
  const originalTarget = {};
  const originalMRT = {};
  const interveningTarget = {};
  const interveningMRT = {};
  const pmremTarget = {};
  let currentTarget: unknown = originalTarget;
  let currentMRT: unknown = originalMRT;
  let draws = 0;
  const renderer = {
    autoClear: true,
    backend: {
      device: {
        queue: {
          onSubmittedWorkDone: vi.fn(async () => {
            events.push("fence");
            if (draws === 1) {
              currentTarget = interveningTarget;
              currentMRT = interveningMRT;
              renderer.autoClear = false;
            }
          }),
        },
      },
    },
    getRenderTarget: () => currentTarget,
    getActiveCubeFace: () => 2,
    getActiveMipmapLevel: () => 3,
    getMRT: () => currentMRT,
    setMRT: (value: unknown) => {
      currentMRT = value;
    },
    setRenderTarget: (value: unknown) => {
      currentTarget = value;
    },
    render: (mesh: { geometry: { drawRange: { start: number; count: number } } }) => {
      events.push(
        `draw:${mesh.geometry.drawRange.start}:${mesh.geometry.drawRange.count}:${renderer.autoClear}:${currentMRT === null}:${currentTarget === pmremTarget}`,
      );
      draws += 1;
    },
  };
  const geometry = {
    drawRange: { start: 0, count: 36 },
    setDrawRange(start: number, count: number) {
      this.drawRange = { start, count };
    },
  };
  const generator = Object.create(PMREMGenerator.prototype) as {
    _renderer: typeof renderer;
    _setViewport: () => void;
    _renderFacesAsync: (...args: unknown[]) => Promise<void>;
  };
  generator._renderer = renderer;
  generator._setViewport = () => undefined;

  await generator._renderFacesAsync({ geometry }, pmremTarget, 0, 0, 32, 32);

  expect(events).toEqual(
    Array.from({ length: 6 }, (_unused, face) => [
      `draw:${face * 6}:6:${face === 0}:true:true`,
      "fence",
    ]).flat(),
  );
  expect(geometry.drawRange).toEqual({ start: 0, count: 36 });
  expect(renderer.autoClear).toBe(false);
  expect(currentMRT).toBe(interveningMRT);
  expect(currentTarget).toBe(interveningTarget);
});

it("restores renderer state when a PMREM face fence rejects", async () => {
  const originalTarget = {};
  const originalMRT = {};
  let currentTarget: unknown = originalTarget;
  let currentMRT: unknown = originalMRT;
  const renderer = {
    autoClear: true,
    backend: {
      device: {
        queue: { onSubmittedWorkDone: vi.fn().mockRejectedValue(new Error("fence failed")) },
      },
    },
    getRenderTarget: () => currentTarget,
    getActiveCubeFace: () => 2,
    getActiveMipmapLevel: () => 3,
    getMRT: () => currentMRT,
    setMRT: (value: unknown) => {
      currentMRT = value;
    },
    setRenderTarget: (value: unknown) => {
      currentTarget = value;
    },
    render: vi.fn(),
  };
  const geometry = {
    drawRange: { start: 4, count: 12 },
    setDrawRange(start: number, count: number) {
      this.drawRange = { start, count };
    },
  };
  const generator = Object.create(PMREMGenerator.prototype) as {
    _renderer: typeof renderer;
    _setViewport: () => void;
    _renderFacesAsync: (...args: unknown[]) => Promise<void>;
  };
  generator._renderer = renderer;
  generator._setViewport = () => undefined;

  await expect(generator._renderFacesAsync({ geometry }, {}, 0, 0, 16, 16)).rejects.toThrow(
    "fence failed",
  );
  expect(renderer.render).toHaveBeenCalledOnce();
  expect(renderer.autoClear).toBe(true);
  expect(currentMRT).toBe(originalMRT);
  expect(currentTarget).toBe(originalTarget);
  expect(geometry.drawRange).toEqual({ start: 4, count: 12 });
});

it("fences groups of PMREM faces by GPU cost and fences once more before publishing", async () => {
  const events: string[] = [];
  const renderer = {
    autoClear: true,
    backend: {
      device: { queue: { onSubmittedWorkDone: vi.fn(async () => void events.push("fence")) } },
    },
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getMRT: () => null,
    setMRT: () => undefined,
    setRenderTarget: () => undefined,
    render: vi.fn(() => void events.push("draw")),
  };
  const generator = new PMREMGenerator(renderer as never);
  const source = new Texture({ height: 8, width: 8 } as never);
  Object.assign(source, { image: { height: 2048, width: 4096 }, mapping: 303 });

  const target = (await (
    generator as unknown as {
      _fromTextureAsync: (texture: Texture, target: null) => Promise<{ dispose: () => void }>;
    }
  )._fromTextureAsync(source, null)) as { dispose: () => void };

  const draws = events.filter((event) => event === "draw").length;
  const fences = events.filter((event) => event === "fence").length;
  // A 4096-wide equirect bakes 150 faces; one fence per face used to cost 150 queue round trips.
  expect(draws).toBe(150);
  expect(fences).toBe(10);
  // The first GGX filter pass is the heaviest face: its six faces cannot share a fence.
  expect(fences).toBeGreaterThanOrEqual(6);
  expect(events.at(-1)).toBe("fence");
  target.dispose();
  source.dispose();
});

const fencedRenderer = () => ({
  backend: { device: { queue: { onSubmittedWorkDone: vi.fn(async () => undefined) } } },
});

it("never bakes a ready equirect synchronously on a queue-fenced backend", async () => {
  const renderer = fencedRenderer();
  const source = new Texture({ height: 8 } as never);
  const generatedTexture = new Texture({ height: 16 } as never);
  const target = { texture: generatedTexture, dispose: vi.fn() };
  let releasePreparation: ((target: never) => void) | undefined;
  const generateAsync = vi
    .spyOn(PMREMGenerator.prototype, "fromEquirectangularAsync")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePreparation = resolve;
        }),
    );
  const generateSync = vi.spyOn(PMREMGenerator.prototype, "fromEquirectangular");
  const prepare = vi.spyOn(PatchedPMREMNode, "prepareTextureAsync");
  const node = new PMREMNode(source) as PatchedPMREMNodeInstance;
  const update = vi.spyOn(node, "updateFromTexture");

  try {
    node.setup({ renderer, context: { getUV: () => vec3(0, 1, 0) } } as never);
    for (let frame = 0; frame < 5; frame += 1) node.updateBefore({ renderer } as never);

    expect(generateSync).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(generateAsync).toHaveBeenCalledOnce());
    expect(update).not.toHaveBeenCalled();

    releasePreparation?.(target as never);
    await vi.waitFor(() => expect(prepare.mock.results[0]?.value).toBeInstanceOf(Promise));
    await prepare.mock.results[0]?.value;
    node.updateBefore({ renderer } as never);

    expect(update).toHaveBeenCalledWith(generatedTexture);
    expect(generateSync).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
  } finally {
    generateAsync.mockRestore();
    generateSync.mockRestore();
    prepare.mockRestore();
  }
});

it("logs a rejected fenced preparation once per texture version and retries on a new version", async () => {
  const renderer = fencedRenderer();
  const source = new Texture({ height: 8 } as never);
  const failure = new Error("bake failed");
  const generateAsync = vi
    .spyOn(PMREMGenerator.prototype, "fromEquirectangularAsync")
    .mockRejectedValue(failure);
  const generateSync = vi.spyOn(PMREMGenerator.prototype, "fromEquirectangular");
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const node = new PMREMNode(source) as PatchedPMREMNodeInstance;

  try {
    node.setup({ renderer, context: { getUV: () => vec3(0, 1, 0) } } as never);
    node.updateBefore({ renderer } as never);
    await vi.waitFor(() => expect(logged).toHaveBeenCalledOnce());
    for (let frame = 0; frame < 5; frame += 1) {
      node.updateBefore({ renderer } as never);
      await Promise.resolve();
    }

    expect(logged).toHaveBeenCalledWith(failure);
    expect(generateAsync).toHaveBeenCalledOnce();
    expect(generateSync).not.toHaveBeenCalled();

    source.pmremVersion += 1;
    node.updateBefore({ renderer } as never);
    await vi.waitFor(() => expect(logged).toHaveBeenCalledTimes(2));
    expect(generateAsync).toHaveBeenCalledTimes(2);
  } finally {
    generateAsync.mockRestore();
    generateSync.mockRestore();
    logged.mockRestore();
  }
});

it("reuses an asynchronously prepared PMREM from the same renderer cache", async () => {
  const renderer = {};
  const source = new Texture({ height: 8 } as never);
  const generatedTexture = new Texture({ height: 16 } as never);
  const target = { texture: generatedTexture, dispose: vi.fn() };
  let releasePreparation: ((target: never) => void) | undefined;
  const generateAsync = vi
    .spyOn(PMREMGenerator.prototype, "fromEquirectangularAsync")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePreparation = resolve;
        }),
    );
  const generateSync = vi.spyOn(PMREMGenerator.prototype, "fromEquirectangular");
  const node = new PMREMNode(source) as PatchedPMREMNodeInstance;
  const update = vi.spyOn(node, "updateFromTexture");

  try {
    const preparation = PatchedPMREMNode.prepareTextureAsync(renderer, source);
    await vi.waitFor(() => expect(generateAsync).toHaveBeenCalledOnce());
    expect(() =>
      node.setup({ renderer, context: { getUV: () => vec3(0, 1, 0) } } as never),
    ).not.toThrow();
    releasePreparation?.(target as never);
    await expect(preparation).resolves.toBe(true);
    node.updateBefore({ renderer } as never);

    expect(generateAsync).toHaveBeenCalledOnce();
    expect(generateSync).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(generatedTexture);
    source.dispose();
    expect(target.dispose).toHaveBeenCalledOnce();
  } finally {
    generateAsync.mockRestore();
    generateSync.mockRestore();
  }
});

it("restarts an in-flight PMREM preparation when its source version changes", async () => {
  const renderer = {};
  const source = new Texture({ height: 8 } as never);
  const staleTarget = { texture: new Texture({ height: 16 } as never), dispose: vi.fn() };
  const currentTarget = { texture: new Texture({ height: 16 } as never), dispose: vi.fn() };
  let releaseStale: ((target: never) => void) | undefined;
  const generateAsync = vi
    .spyOn(PMREMGenerator.prototype, "fromEquirectangularAsync")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStale = resolve;
        }),
    )
    .mockResolvedValueOnce(currentTarget as never);

  try {
    const stale = PatchedPMREMNode.prepareTextureAsync(renderer, source);
    await vi.waitFor(() => expect(generateAsync).toHaveBeenCalledOnce());
    source.pmremVersion += 1;
    const current = PatchedPMREMNode.prepareTextureAsync(renderer, source);
    releaseStale?.(staleTarget as never);

    await expect(stale).resolves.toBe(false);
    await expect(current).resolves.toBe(true);
    expect(generateAsync).toHaveBeenCalledTimes(2);
    expect(staleTarget.dispose).toHaveBeenCalledOnce();

    const node = new PMREMNode(source) as PatchedPMREMNodeInstance;
    const update = vi.spyOn(node, "updateFromTexture");
    node.updateBefore({ renderer } as never);
    expect(update).toHaveBeenCalledWith(currentTarget.texture);
  } finally {
    generateAsync.mockRestore();
  }
});

it("does not cache a PMREM when its queue-fenced preparation fails", async () => {
  const renderer = {};
  const source = new Texture({ height: 8 } as never);
  const generateAsync = vi
    .spyOn(PMREMGenerator.prototype, "fromEquirectangularAsync")
    .mockRejectedValue(new Error("queue fence failed"));
  const generatedTexture = new Texture({ height: 16 } as never);
  const syncTarget = { texture: generatedTexture, dispose: vi.fn() };
  const generateSync = vi
    .spyOn(PMREMGenerator.prototype, "fromEquirectangular")
    .mockReturnValue(syncTarget as never);

  try {
    await expect(PatchedPMREMNode.prepareTextureAsync(renderer, source)).rejects.toThrow(
      "queue fence failed",
    );

    const node = new PMREMNode(source);
    node.setup({ renderer, context: { getUV: () => vec3(0, 1, 0) } } as never);
    node.updateBefore({ renderer } as never);

    expect(generateSync).toHaveBeenCalledOnce();
    expect(generateAsync).toHaveBeenCalledOnce();
  } finally {
    generateAsync.mockRestore();
    generateSync.mockRestore();
  }
});

it("disposes a PMREM generated after its source is disposed and does not cache it", async () => {
  const renderer = {};
  const source = new Texture({ height: 8 } as never);
  const generatedTexture = new Texture({ height: 16 } as never);
  const pendingTarget = { texture: generatedTexture, dispose: vi.fn() };
  let releasePreparation: ((target: never) => void) | undefined;
  const generateAsync = vi
    .spyOn(PMREMGenerator.prototype, "fromEquirectangularAsync")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePreparation = resolve;
        }),
    );
  const syncTarget = { texture: new Texture({ height: 16 } as never), dispose: vi.fn() };
  const generateSync = vi
    .spyOn(PMREMGenerator.prototype, "fromEquirectangular")
    .mockReturnValue(syncTarget as never);

  try {
    const preparation = PatchedPMREMNode.prepareTextureAsync(renderer, source);
    await vi.waitFor(() => expect(generateAsync).toHaveBeenCalledOnce());
    source.dispose();
    releasePreparation?.(pendingTarget as never);

    await expect(preparation).resolves.toBe(false);
    expect(pendingTarget.dispose).toHaveBeenCalledOnce();

    const node = new PMREMNode(source);
    node.setup({ renderer, context: { getUV: () => vec3(0, 1, 0) } } as never);
    node.updateBefore({ renderer } as never);
    expect(generateSync).toHaveBeenCalledOnce();
  } finally {
    generateAsync.mockRestore();
    generateSync.mockRestore();
  }
});

/** The candidate release's patch: the previous hunk plus one this release adds. */
const CANDIDATE_PATCH = `diff --git a/src/thing.js b/src/thing.js
--- a/src/thing.js
+++ b/src/thing.js
@@ -1,1 +1,1 @@
-const alpha = 1;
+const alpha = 1; // threenative: one
@@ -3,1 +3,1 @@
-const gamma = 3;
+const gamma = 3; // threenative: two
`;

async function fixture(lines: readonly string[]): Promise<{
  packageRoot: string;
  threeRoot: string;
  target: string;
}> {
  const root = await tempRoot();
  const packageRoot = join(root, "core");
  const threeRoot = join(root, "node_modules", "three");
  await mkdir(join(packageRoot, "patches"), { recursive: true });
  await mkdir(join(threeRoot, "src"), { recursive: true });
  await writeFile(
    join(packageRoot, "patches", `three@${THREE_VERSION}.patch`),
    CANDIDATE_PATCH,
    "utf8",
  );
  await writeFile(
    join(threeRoot, "package.json"),
    `${JSON.stringify({ name: "three", version: THREE_VERSION })}\n`,
    "utf8",
  );
  const target = join(threeRoot, "src", "thing.js");
  await writeFile(target, lines.join("\n"), "utf8");
  return { packageRoot, target, threeRoot };
}

describe("the Three.js patch on a project that upgrades from the previous release", () => {
  // A generated project declares the patch in its own manifest, so the package manager applies it
  // at install time. A project scaffolded from the previous `latest` therefore carries the previous
  // patch's text, and this release's postinstall finds its own first hunk already applied. That is
  // the state the PRD-446 upgrade proof installs into, and it used to refuse as "partial".
  it("adds the hunks this release adds and keeps the ones already there", async () => {
    const { packageRoot, target, threeRoot } = await fixture(PATCHED_BY_THE_PREVIOUS_RELEASE);

    await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("patched");
    await expect(readFile(target, "utf8")).resolves.toBe(FULLY_PATCHED.join("\n"));
  });

  it("is idempotent once the whole patch is on disk", async () => {
    const { packageRoot, target, threeRoot } = await fixture(FULLY_PATCHED);

    await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("unchanged");
    await expect(readFile(target, "utf8")).resolves.toBe(FULLY_PATCHED.join("\n"));
  });

  it("still patches untouched stock three", async () => {
    const { packageRoot, target, threeRoot } = await fixture(STOCK);

    await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("patched");
    await expect(readFile(target, "utf8")).resolves.toBe(FULLY_PATCHED.join("\n"));
  });

  it("refuses a hunk that is neither stock nor this patch's own text", async () => {
    const tampered = [...PATCHED_BY_THE_PREVIOUS_RELEASE];
    tampered[0] = "const alpha = 1; // edited by hand";
    const { packageRoot, target, threeRoot } = await fixture(tampered);

    await expect(applyThreePatch({ packageRoot, threeRoot })).rejects.toThrow(
      /TN_THREE_PATCH_PARTIAL/u,
    );
    // Refused means refused: the recognisable hunks are not written either.
    await expect(readFile(target, "utf8")).resolves.toBe(tampered.join("\n"));
  });
});

// These are the actual Git blobs after applying develop 416ffd7c's dcbc5131 patch to Three
// 0.185.1. The inverse migration materializes those exact bytes from the installed candidate.
const PRIOR_BLOBS = {
  "build/three.webgpu.js": "7aa62adb9e78ba8f0a67709d3141bf93c67419cc",
  "build/three.webgpu.nodes.js": "b8a7b2fd0a2e95911e7e12fd5674592107f012de",
  "src/nodes/accessors/Instance.js": "ed00e75ba4fd7b49343cfada26eacdef8940a4f4",
  "src/renderers/common/Renderer.js": "89b33efb80ca1dcb9db931071dfda62ffdba3526",
  "src/renderers/webgpu/utils/WebGPUAttributeUtils.js": "83bbe189915c8450c4e14108e6a3f4ed98c4b016",
};

// Exact blobs shipped by PR393 source 47e188e4 (patch 455ed1dd).
const PUBLISHED_BLOBS = {
  "build/three.webgpu.js": "bdffb9b4069f7beafa85913b155e92d3e83f12d0",
  "build/three.webgpu.nodes.js": "1245f0da9bb6a0f731b8c75a64490d7c91238700",
  "src/renderers/webgpu/utils/WebGPUAttributeUtils.js": "83bbe189915c8450c4e14108e6a3f4ed98c4b016",
};

// Exact source/bundle blobs shipped at PR393 source 085c977b (patch daef254c).
const RECOMPILE_BLOBS = {
  "src/nodes/accessors/Skinning.js": "aaeea633a8ece291be5faf868e312867ddad01b6",
  "build/three.webgpu.js": "148869ee7f18c62570ac1eafb7df5775e5a89581",
  "build/three.webgpu.nodes.js": "81c24b2e05e5047e1a02410a2056949d39b1a05c",
};

// Exact published PR398 b32342b9 (63aa4b9b) and develop 15adf350 (c2e051df) blobs.
const TEMPORAL_PUBLISHED_BLOBS = {
  "build/three.webgpu.js": "efd0e16719cc7bbef1fbc18c241948e25eb85881",
  "build/three.webgpu.nodes.js": "1b3a6e96291af0077f7f247040e657cf4aa0cb33",
  "src/renderers/webgpu/WebGPUBackend.js": "69b8b67fdeec5be24de34d8382beda9020642f77",
  "src/renderers/webgpu/utils/WebGPUTextureUtils.js": "ff8ee2dbace2816105aa7152891c04f2333f33e8",
};

const FLUID_DEVELOP_BLOBS = {
  "build/three.webgpu.js": "5c5ef3c06885c724c1c2288295e7e68483ee1f6e",
  "build/three.webgpu.nodes.js": "3d47c1151d563f1e0ae2bb4b92edd057fe0df2b3",
  "src/nodes/accessors/Instance.js": "ed00e75ba4fd7b49343cfada26eacdef8940a4f4",
  "src/nodes/accessors/Skinning.js": "aaeea633a8ece291be5faf868e312867ddad01b6",
  "src/renderers/common/Renderer.js": "89b33efb80ca1dcb9db931071dfda62ffdba3526",
  "src/renderers/webgpu/utils/WebGPUAttributeUtils.js": "83bbe189915c8450c4e14108e6a3f4ed98c4b016",
};

// Exact Three blobs consumed by published PR398 4e86 (patch7036a173).
const CURRENT_RECONSTRUCTION_BLOBS = {
  "build/three.webgpu.js": "9166d6f2dd1ac1505fa27b625f1976dff6b8ebc1",
  "build/three.webgpu.nodes.js": "9e7c7f74be1191b761711bd70ee59cc033e586cb",
  "src/nodes/display/PassNode.js": "cc827a55cb82a6325296dcc5c55a4246f4f70aed",
  "src/nodes/accessors/TextureNode.js": "f886ed21397ab39d6fdbc58e5ac57729f1871f8a",
  "src/nodes/accessors/TextureSizeNode.js": "d4668281657ef8b1acad761e0d86a0716909eee4",
  "src/renderers/webgpu/nodes/WGSLNodeBuilder.js": "2acc832a628f43adac49614dad8e593ef058c398",
  "src/renderers/webgpu/utils/WebGPUBindingUtils.js": "a5da7ca09f746c0b2859ef173df663ccdc851ebc",
};

// Exact PR486 candidate before the separate-encoder ordering correction.
// Exact source/bundle blobs at PR486 matrix-guard predecessor 4a7224834.
const ABORT_PREDECESSOR_BLOBS = {
  "build/three.webgpu.js": "7e34d05be672a7fa2e38b19c035f744a8b486446",
  "build/three.webgpu.nodes.js": "4b7a3baea4fc2a99f9453211d2807131f8a86dd4",
  "src/renderers/common/Renderer.js": "769c909b0a63708dea7d22efc5379c39bdf57d92",
  "src/renderers/webgpu/WebGPUBackend.js": "0fbcc307d39cbf6d74d9dbc5f199f2b0e4f58b33",
};

const INSTANCE_HISTORY_BLOBS = {
  "build/three.webgpu.js": "f9ea33ac39db20e96822fda6b90e2bed02817435",
  "build/three.webgpu.nodes.js": "93cedce745291edfbd333fb76d8154b8eff685bd",
  "src/nodes/accessors/Instance.js": "18e2b7943393fd07b7989b1e3a5231a61ca24187",
};

const MATRIX_GUARD_BLOBS = {
  "build/three.webgpu.js": "2a70eb319b4235c958c7b5b1ede148c808d0b4b2",
  "build/three.webgpu.nodes.js": "bfa242835dfef49019dd368e3593a62a221dda3d",
  "src/renderers/webgpu/WebGPUBackend.js": "5dbb9bf2ed43fa055c0f7dd2859c146485825817",
};

const QUEUE_ORDER_BLOBS = {
  "build/three.webgpu.js": "ee394e98d798be749776cce1fa3e043fb9951769",
  "build/three.webgpu.nodes.js": "a0fab1c7c37cfaf270d9ce36dd3d91453ae6a44c",
  "src/renderers/webgpu/WebGPUBackend.js": "94b48d64ed8f2e57f00cb5fd5bd0112da085aeae",
};

// Exact installed blobs before PRD618 shared-resource lifetime ownership.
const RESOURCE_LIFETIME_PREDECESSOR_BLOBS = {
  "build/three.webgpu.js": "1071a6d91ee953f1fcc6769d0b6ba5230b67bfa1",
  "build/three.webgpu.nodes.js": "f656265a47ffb6034da0c6ce768264762096b197",
  "src/nodes/accessors/Batch.js": "2cf4bb6039853d5c922e89041419250b243694ef",
  "src/renderers/common/Geometries.js": "979da2ffc4d0dcda6fdd72747a7e7125e3f8a3a3",
  "src/renderers/common/RenderObjects.js": "72569d0339314d26eb7a35ff2a8462a803c852a6",
};

function blobHash(contents: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(contents)}\0`)
    .update(contents)
    .digest("hex");
}

async function previousInstalledPackage(priorBlobs: Record<string, string>, crlf = false) {
  const root = await tempRoot();
  const threeRoot = join(root, "three");
  const packageRoot = resolve("packages/core");
  await mkdir(threeRoot, { recursive: true });
  await writeFile(
    join(threeRoot, "package.json"),
    `${JSON.stringify({ name: "three", version: THREE_VERSION })}\n`,
    "utf8",
  );
  // Start every registered target at the exact bytes the previous release shipped.
  for (const [file, contents] of Object.entries(FIXTURE.targetTexts)) {
    await mkdir(dirname(join(threeRoot, file)), { recursive: true });
    await writeFile(join(threeRoot, file), contents, "utf8");
  }
  // The frozen legacy fixture predates newly pinned source targets. Seed those targets at the
  // current generated bytes, then reverse their generated hunks to recreate the stock upstream
  // files. The frozen migration fixture remains unchanged; the current installer must patch these
  // newly tracked files from their real stock contents.
  const generatedSections = GENERATED_BASE_PATCH.split(/(?=^diff --git )/mu);
  for (const [file, contents] of Object.entries(GENERATED_TARGET_TEXTS)) {
    if (FIXTURE.targetTexts[file] !== undefined) continue;
    await mkdir(dirname(join(threeRoot, file)), { recursive: true });
    await writeFile(join(threeRoot, file), contents, "utf8");
    const section = generatedSections.find((candidate) =>
      candidate.startsWith(`diff --git a/${file} b/${file}\n`),
    );
    if (section === undefined) throw new Error(`Missing generated patch section for ${file}`);
    const inverse = join(root, `${file.replaceAll("/", "_")}.patch`);
    await writeFile(inverse, section, "utf8");
    await promisify(execFile)(
      "patch",
      ["--reverse", "--batch", "--fuzz=0", "--silent", "-p1", "-i", inverse],
      { cwd: threeRoot },
    );
  }
  if (
    Object.keys(priorBlobs).length > 0 &&
    Object.entries(priorBlobs).every(
      ([file, hash]) => blobHash(RESOURCE_LIFETIME_PREDECESSORS[file] ?? "") === hash,
    )
  ) {
    for (const [file, contents] of Object.entries(RESOURCE_LIFETIME_PREDECESSORS)) {
      await mkdir(dirname(join(threeRoot, file)), { recursive: true });
      await writeFile(join(threeRoot, file), contents, "utf8");
    }
    return { packageRoot, threeRoot };
  }
  // Invert the frozen legacy hunks to reach the older state this group represents.
  const migration = FIXTURE.originalUpgradePatch;
  const blocks = migration.split(/(?=^diff --git )/mu);
  const selected: string[] = [];
  for (const [file, initialHash] of Object.entries(priorBlobs)) {
    let hash = initialHash;
    const chain: string[] = [];
    for (;;) {
      const block = blocks.find(
        (candidate) =>
          candidate.startsWith(`diff --git a/${file} `) && candidate.includes(`index ${hash}..`),
      );
      if (!block) break;
      chain.unshift(block);
      hash = /^index [a-f0-9]{40}\.\.([a-f0-9]{40}) /mu.exec(block)?.[1] ?? "";
    }
    selected.push(...chain);
  }
  const inverse = join(root, "prior.patch");
  await writeFile(inverse, selected.join(""));
  await promisify(execFile)(
    "patch",
    ["--reverse", "--batch", "--fuzz=0", "--silent", "-p1", "-i", inverse],
    { cwd: threeRoot },
  );
  for (const [file, hash] of Object.entries(priorBlobs)) {
    const contents = await readFile(join(threeRoot, file), "utf8");
    expect(blobHash(contents)).toBe(hash);
    if (crlf) await writeFile(join(threeRoot, file), contents.replaceAll("\n", "\r\n"));
  }
  return { packageRoot, threeRoot };
}

describe.each([
  ["PRD618 resource-lifetime predecessor", RESOURCE_LIFETIME_PREDECESSOR_BLOBS],
  ["PRD618 instance-history predecessor", INSTANCE_HISTORY_BLOBS],
  ["PR486 matrix-guard predecessor", MATRIX_GUARD_BLOBS],
  ["PR486 abort predecessor", ABORT_PREDECESSOR_BLOBS],
  ["PR486 queue-order predecessor", QUEUE_ORDER_BLOBS],
  ["develop dcbc5131", PRIOR_BLOBS],
  ["published PR393 455ed1dd", PUBLISHED_BLOBS],
  ["published PR393 daef254c", RECOMPILE_BLOBS],
  ["published PR398 63aa4b9b", TEMPORAL_PUBLISHED_BLOBS],
  ["develop fluid c2e051df", FLUID_DEVELOP_BLOBS],
  ["published PR398 4e86 /7036a173", CURRENT_RECONSTRUCTION_BLOBS],
])("actual previously shipped Three files (%s)", (_name, priorBlobs) => {
  it.each([false, true])(
    "upgrades the exact prior patch and remains idempotent (CRLF=%s)",
    async (crlf) => {
      const { packageRoot, threeRoot } = await previousInstalledPackage(priorBlobs, crlf);
      await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("patched");
      for (const file of Object.keys(priorBlobs)) {
        expect(blobHash(await readFile(join(threeRoot, file), "utf8"))).toBe(
          GENERATED_FINAL_HASHES[file],
        );
      }
      await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("unchanged");
    },
  );

  it("refuses a one-byte custom edit before writing any recognised file", async () => {
    const { packageRoot, threeRoot } = await previousInstalledPackage(priorBlobs);
    const changed = join(threeRoot, Object.keys(priorBlobs)[0] ?? "missing");
    await writeFile(changed, `${await readFile(changed, "utf8")} `);
    const before = await Promise.all(
      Object.keys(priorBlobs).map((file) => readFile(join(threeRoot, file), "utf8")),
    );
    await expect(applyThreePatch({ packageRoot, threeRoot })).rejects.toThrow(
      /TN_THREE_PATCH_PARTIAL/,
    );
    const after = await Promise.all(
      Object.keys(priorBlobs).map((file) => readFile(join(threeRoot, file), "utf8")),
    );
    expect(after).toEqual(before);
  });
});

async function stockInstalledPackage() {
  const { packageRoot, threeRoot } = await previousInstalledPackage({});
  const inverse = join(await tempRoot(), "stock.patch");
  await writeFile(inverse, FIXTURE.originalBasePatch);
  await promisify(execFile)(
    "patch",
    ["--reverse", "--batch", "--fuzz=0", "--silent", "-p1", "-i", inverse],
    { cwd: threeRoot },
  );
  return { packageRoot, threeRoot };
}

describe("generated patch installer regressions", () => {
  it("upgrades the frozen Phase 1 generated patch to every current target hash", async () => {
    const { packageRoot, threeRoot } = await stockInstalledPackage();
    const oldPatch = brotliDecompressSync(
      readFileSync(join(testDir, "fixtures", "generated-three-patch.patch.br")),
    ).toString("utf8");
    const patchFile = join(await tempRoot(), "old.patch");
    await writeFile(patchFile, oldPatch);
    await promisify(execFile)(
      "patch",
      ["--batch", "--fuzz=0", "--silent", "-p1", "-i", patchFile],
      { cwd: threeRoot },
    );
    for (const block of oldPatch.split(/(?=^diff --git )/mu)) {
      const rel = /^diff --git a\/(\S+) /mu.exec(block)?.[1];
      const hash = /^index [a-f0-9]{40}\.\.([a-f0-9]{40}) /mu.exec(block)?.[1];
      if (rel !== undefined && hash !== undefined)
        expect(blobHash(await readFile(join(threeRoot, rel), "utf8")), rel).toBe(hash);
    }
    await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("patched");
    for (const [rel, hash] of Object.entries(GENERATED_FINAL_HASHES))
      expect(blobHash(await readFile(join(threeRoot, rel), "utf8")), rel).toBe(hash);
    await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("unchanged");
  });

  it("classifies stock Batch.js as stock despite its deletion-only trailing blank hunk", async () => {
    const { packageRoot, threeRoot } = await stockInstalledPackage();
    await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("patched");
    const rel = "src/nodes/accessors/Batch.js";
    expect(blobHash(await readFile(join(threeRoot, rel), "utf8"))).toBe(
      GENERATED_FINAL_HASHES[rel],
    );
  });
});

it("follows exact predecessor hashes and rejects a cyclic migration without writing", async () => {
  const { packageRoot, threeRoot, target } = await fixture(STOCK);
  const transition = (before: readonly string[], after: readonly string[]) =>
    `diff --git a/src/thing.js b/src/thing.js
index ${blobHash(before.join("\n"))}..${blobHash(after.join("\n"))} 100644
--- a/src/thing.js
+++ b/src/thing.js
@@ -1,5 +1,5 @@
${before
  .slice(0, 5)
  .map((line) => `-${line}`)
  .join("\n")}
${after
  .slice(0, 5)
  .map((line) => `+${line}`)
  .join("\n")}
`;
  const migration = join(packageRoot, "patches/three@0.185.1-prd269-upgrade.patch");
  await writeFile(
    migration,
    transition(STOCK, PATCHED_BY_THE_PREVIOUS_RELEASE) +
      transition(PATCHED_BY_THE_PREVIOUS_RELEASE, FULLY_PATCHED),
  );
  await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("patched");
  expect(await readFile(target, "utf8")).toBe(FULLY_PATCHED.join("\n"));
  await writeFile(target, STOCK.join("\n"));
  await writeFile(
    migration,
    transition(STOCK, PATCHED_BY_THE_PREVIOUS_RELEASE) +
      transition(PATCHED_BY_THE_PREVIOUS_RELEASE, STOCK),
  );
  await expect(applyThreePatch({ packageRoot, threeRoot })).rejects.toThrow("cyclic known upgrade");
  expect(await readFile(target, "utf8")).toBe(STOCK.join("\n"));
});
