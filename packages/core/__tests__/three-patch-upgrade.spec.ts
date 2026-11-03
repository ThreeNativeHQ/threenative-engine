import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Texture, WebGPUCoordinateSystem } from "three";
import { float, vec3 } from "three/tsl";
import { PMREMGenerator, PMREMNode } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

// @ts-expect-error -- the postinstall helper is plain ESM with no type declarations.
import { applyThreePatch } from "../scripts/apply-three-patch.mjs";

const roots: string[] = [];

// three's declarations omit the members packages/core/patches/three@0.187.0.patch adds to PMREMNode.
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

const THREE_VERSION = "0.187.0";
const STOCK = [
  "const alpha = 1;",
  "const beta = 2;",
  "const gamma = 3;",
  "const delta = 4;",
  "const epsilon = 5;",
  "",
];

/** An interrupted patch: hunk one applied, hunk two not yet written. */
const PARTIALLY_PATCHED = [
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

/**
 * A texture shaped like a generated PMREM. r187 samples the cubemap directly, so
 * `PMREMNode.updateFromTexture` reads `mipmaps.length - 1` and `mipmaps[ 0 ].width` where 0.185.1
 * read the CubeUV image height.
 */
function pmremTexture(size = 16): Texture {
  const texture = new Texture({ height: size, width: size } as never);
  texture.mipmaps.push({ height: size, width: size } as never);
  return texture;
}

/** The two builder hooks `PMREMNode.setup()` reads when the node declares neither of its own. */
const pmremContext = () => ({ getTextureLevel: () => float(0), getUV: () => vec3(0, 1, 0) });

it("fences each PMREM cube face and restores target, MRT and mipmap state before awaiting", async () => {
  const events: string[] = [];
  const originalTarget = {};
  const originalMRT = {};
  const interveningTarget = {};
  const interveningMRT = {};
  const pmremTarget = { texture: { mipmapsAutoUpdate: true }, width: 32 };
  const state = {
    cubeFace: -1,
    draws: 0,
    mipLevel: -1,
    mrt: originalMRT as unknown,
    target: originalTarget as unknown,
  };
  const renderer = {
    autoClear: true,
    coordinateSystem: WebGPUCoordinateSystem,
    isWebGLRenderer: false,
    reversedDepthBuffer: false,
    xr: { enabled: true },
    backend: {
      device: {
        queue: {
          onSubmittedWorkDone: vi.fn(async () => {
            events.push("fence");
            // `_renderCubeAsync` must hand the caller's target and MRT back *before* it awaits, so
            // a restore that ran after the await would overwrite this and fail the asserts below.
            if (state.draws === 1) {
              state.mrt = interveningMRT;
              state.target = interveningTarget;
            }
          }),
        },
      },
    },
    getActiveCubeFace: () => state.cubeFace,
    getActiveMipmapLevel: () => state.mipLevel,
    getMRT: () => state.mrt,
    getRenderTarget: () => state.target,
    render: () => undefined,
    setMRT: (value: unknown) => {
      state.mrt = value;
    },
    setRenderTarget: (value: unknown, cubeFace: number, mipLevel: number) => {
      state.cubeFace = cubeFace;
      state.mipLevel = mipLevel;
      state.target = value;
    },
  };
  renderer.render = () => {
    events.push(
      `draw:${state.cubeFace}:${state.mipLevel}:${pmremTarget.texture.mipmapsAutoUpdate}:${state.mrt === null}:${state.target === pmremTarget}:${renderer.xr.enabled}`,
    );
    state.draws += 1;
  };
  const generator = Object.create(PMREMGenerator.prototype) as {
    _boxMesh: { material: unknown };
    _cubeCamera: unknown;
    _fenceBudget: number;
    _fencePending: number;
    _renderCubeAsync(target: unknown, lod: number, material: unknown): Promise<void>;
    _renderer: unknown;
  };
  generator._renderer = renderer;
  generator._boxMesh = { material: null };
  generator._cubeCamera = {
    children: Array.from({ length: 6 }, (_unused, face) => ({ face })),
    coordinateSystem: renderer.coordinateSystem,
    parent: {},
  };
  // A face costs `size² · samples`; a budget of one sample means every face earns its own fence.
  generator._fenceBudget = 1;
  generator._fencePending = 0;
  const material = {};

  await generator._renderCubeAsync(pmremTarget, 0, material);

  // Mipmaps are generated during the last face's draw, as in `CubeCamera.update()`.
  expect(events).toEqual(
    Array.from({ length: 6 }, (_unused, face) => [
      `draw:${face}:0:${face === 5}:true:true:false`,
      "fence",
    ]).flat(),
  );
  expect(generator._boxMesh.material).toBe(material);
  expect(pmremTarget.texture).toEqual({ mipmapsAutoUpdate: true, needsPMREMUpdate: true });
  expect(renderer.xr.enabled).toBe(true);
  expect(state.mrt).toBe(interveningMRT);
  expect(state.target).toBe(interveningTarget);
});

it("restores renderer state when a PMREM face fence rejects", async () => {
  const originalTarget = {};
  const originalMRT = {};
  const pmremTarget = { texture: { mipmapsAutoUpdate: true }, width: 16 };
  const state = {
    cubeFace: -1,
    mipLevel: -1,
    mrt: originalMRT as unknown,
    target: originalTarget as unknown,
  };
  const render = vi.fn();
  const renderer = {
    autoClear: true,
    coordinateSystem: WebGPUCoordinateSystem,
    isWebGLRenderer: false,
    reversedDepthBuffer: false,
    xr: { enabled: true },
    backend: {
      device: {
        queue: { onSubmittedWorkDone: vi.fn().mockRejectedValue(new Error("fence failed")) },
      },
    },
    getActiveCubeFace: () => state.cubeFace,
    getActiveMipmapLevel: () => state.mipLevel,
    getMRT: () => state.mrt,
    getRenderTarget: () => state.target,
    render,
    setMRT: (value: unknown) => {
      state.mrt = value;
    },
    setRenderTarget: (value: unknown, cubeFace: number, mipLevel: number) => {
      state.cubeFace = cubeFace;
      state.mipLevel = mipLevel;
      state.target = value;
    },
  };
  const generator = Object.create(PMREMGenerator.prototype) as {
    _boxMesh: { material: unknown };
    _cubeCamera: unknown;
    _fenceBudget: number;
    _fencePending: number;
    _renderCubeAsync(target: unknown, lod: number, material: unknown): Promise<void>;
    _renderer: unknown;
  };
  generator._renderer = renderer;
  generator._boxMesh = { material: null };
  generator._cubeCamera = {
    children: Array.from({ length: 6 }, (_unused, face) => ({ face })),
    coordinateSystem: renderer.coordinateSystem,
    parent: {},
  };
  generator._fenceBudget = 1;
  generator._fencePending = 0;

  await expect(generator._renderCubeAsync(pmremTarget, 0, {})).rejects.toThrow("fence failed");

  expect(render).toHaveBeenCalledOnce();
  expect(renderer.xr.enabled).toBe(true);
  expect(state.mrt).toBe(originalMRT);
  expect(state.target).toBe(originalTarget);
  // A face that failed is not a face that was published, so the PMREM is not flagged for upload.
  expect(pmremTarget.texture).toEqual({ mipmapsAutoUpdate: true });
});

it("fences groups of PMREM faces by GPU cost and fences once more before publishing", async () => {
  const events: string[] = [];
  const renderer = {
    autoClear: true,
    coordinateSystem: WebGPUCoordinateSystem,
    isWebGLRenderer: false,
    reversedDepthBuffer: false,
    xr: { enabled: false },
    backend: {
      device: { queue: { onSubmittedWorkDone: vi.fn(async () => void events.push("fence")) } },
    },
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getMRT: () => null,
    getRenderTarget: () => null,
    render: vi.fn(() => void events.push("draw")),
    setMRT: () => undefined,
    setRenderTarget: () => undefined,
  };
  const generator = new PMREMGenerator(renderer as never);
  const source = new Texture({ height: 2048, width: 4096 } as never);
  Object.assign(source, { image: { height: 2048, width: 4096 }, mapping: 303 });

  const target = (await (
    generator as unknown as {
      _fromTextureAsync: (texture: Texture, target: null) => Promise<{ dispose: () => void }>;
    }
  )._fromTextureAsync(source, null)) as { dispose: () => void };

  const draws = events.filter((event) => event === "draw").length;
  const fences = events.filter((event) => event === "fence").length;
  // r187 renders six cube faces per mip level: a 4096-wide equirect is a 1024 face with eight
  // levels, so the source cubemap plus the prefiltered levels are 54 draws.
  expect(draws).toBe(54);
  // One fence per face used to cost 54 queue round trips; the GPU-cost budget groups the cheap
  // levels, and only the two heaviest GGX levels cannot share one.
  expect(fences).toBe(15);
  expect(fences).toBeLessThanOrEqual(draws);
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
  const generatedTexture = pmremTexture();
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
    node.setup({ renderer, context: pmremContext() } as never);
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
    node.setup({ renderer, context: pmremContext() } as never);
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
  const generatedTexture = pmremTexture();
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
    expect(() => node.setup({ renderer, context: pmremContext() } as never)).not.toThrow();
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
  const staleTarget = { texture: pmremTexture(), dispose: vi.fn() };
  const currentTarget = { texture: pmremTexture(), dispose: vi.fn() };
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
  const syncTarget = { texture: pmremTexture(), dispose: vi.fn() };
  const generateSync = vi
    .spyOn(PMREMGenerator.prototype, "fromEquirectangular")
    .mockReturnValue(syncTarget as never);

  try {
    await expect(PatchedPMREMNode.prepareTextureAsync(renderer, source)).rejects.toThrow(
      "queue fence failed",
    );

    const node = new PMREMNode(source);
    node.setup({ renderer, context: pmremContext() } as never);
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
  const pendingTarget = { texture: pmremTexture(), dispose: vi.fn() };
  let releasePreparation: ((target: never) => void) | undefined;
  const generateAsync = vi
    .spyOn(PMREMGenerator.prototype, "fromEquirectangularAsync")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePreparation = resolve;
        }),
    );
  const syncTarget = { texture: pmremTexture(), dispose: vi.fn() };
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
    node.setup({ renderer, context: pmremContext() } as never);
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

describe("the Three.js patch on stock three", () => {
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
    const tampered = [...PARTIALLY_PATCHED];
    tampered[0] = "const alpha = 1; // edited by hand";
    const { packageRoot, target, threeRoot } = await fixture(tampered);

    await expect(applyThreePatch({ packageRoot, threeRoot })).rejects.toThrow(
      /TN_THREE_PATCH_PARTIAL/u,
    );
    // Refused means refused: the recognisable hunks are not written either.
    await expect(readFile(target, "utf8")).resolves.toBe(tampered.join("\n"));
  });
});

function blobHash(contents: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(contents)}\0`)
    .update(contents)
    .digest("hex");
}

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
  const migration = join(packageRoot, "patches/three@0.187.0-prd269-upgrade.patch");
  await writeFile(
    migration,
    transition(STOCK, PARTIALLY_PATCHED) + transition(PARTIALLY_PATCHED, FULLY_PATCHED),
  );
  await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("patched");
  expect(await readFile(target, "utf8")).toBe(FULLY_PATCHED.join("\n"));
  await writeFile(target, STOCK.join("\n"));
  await writeFile(
    migration,
    transition(STOCK, PARTIALLY_PATCHED) + transition(PARTIALLY_PATCHED, STOCK),
  );
  await expect(applyThreePatch({ packageRoot, threeRoot })).rejects.toThrow("cyclic known upgrade");
  expect(await readFile(target, "utf8")).toBe(STOCK.join("\n"));
});
