import { readFileSync } from "node:fs";
import {
  CompressedArrayTexture,
  CompressedTexture,
  DataTexture,
  ExternalTexture,
  MirroredRepeatWrapping,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  RGBA_ASTC_5x4_Format,
  RGBA_BPTC_Format,
  RGBA_S3TC_DXT1_Format,
  RGBA_S3TC_DXT5_Format,
  SRGBColorSpace,
  Source,
  type Texture,
} from "three";
import { afterEach, expect, it, vi } from "vitest";
import { createRenderer } from "../src/renderer.js";
import { transcodeKtx2ToBc7 } from "./support/basis-transcode.js";

afterEach(() => vi.unstubAllGlobals());

function canvas(): HTMLCanvasElement {
  const value = new EventTarget();
  Object.defineProperties(value, {
    clientHeight: { value: 180 },
    clientWidth: { value: 320 },
  });
  return value as HTMLCanvasElement;
}

function compressed(): CompressedTexture {
  const value = new CompressedTexture(
    [{ data: new Uint8Array(16), width: 4, height: 4 }],
    4,
    4,
    RGBA_BPTC_Format,
  );
  value.needsUpdate = true;
  return value;
}

/** Transcodes the committed real KTX2 fixture to BC7 through the installed Basis transcoder. */
async function realCompressed(): Promise<{
  texture: CompressedTexture;
  mipmaps: { data: Uint8Array; width: number; height: number }[];
}> {
  const bytes = readFileSync(new URL("./fixtures/compressed-upload.ktx2", import.meta.url));
  const transcoded = await transcodeKtx2ToBc7(bytes);
  const texture = new CompressedTexture(
    transcoded.mipmaps.map((mip) => ({ data: mip.data, width: mip.width, height: mip.height })),
    transcoded.width,
    transcoded.height,
    RGBA_BPTC_Format,
  );
  texture.needsUpdate = true;
  return { texture, mipmaps: transcoded.mipmaps };
}

interface IWrite {
  bytes: number;
  destination: {
    texture?: unknown;
    mipLevel: number;
    origin: { x: number; y: number; z: number };
  };
  data: Uint8Array;
  layout?: { offset: number; bytesPerRow: number; rowsPerImage: number };
  extent?: { width: number; height: number; depthOrArrayLayers: number };
}

function mockDevice(options: { feature?: boolean } = {}) {
  const writes: IWrite[] = [];
  const created: { descriptor: object; destroy: () => void }[] = [];
  const destroy = vi.fn();
  const writeTexture = vi.fn(
    (
      destination: IWrite["destination"],
      data: Uint8Array,
      layout?: IWrite["layout"],
      extent?: IWrite["extent"],
    ) => {
      writes.push({ bytes: data.byteLength, destination, data: data.slice(), layout, extent });
    },
  );
  const createTexture = vi.fn((descriptor: object) => {
    const texture = { descriptor, destroy };
    created.push(texture);
    return texture;
  });
  const features = { has: vi.fn(() => options.feature ?? true) };
  const device = { queue: { writeTexture }, createTexture, features };
  return { createTexture, created, destroy, device, features, writeTexture, writes };
}

async function webgpuRenderer(extra: Record<string, unknown> = {}) {
  vi.stubGlobal("navigator", { gpu: {} });
  return createRenderer({
    canvas: canvas(),
    webgpuFactory: () => ({
      domElement: canvas(),
      render: () => {},
      setSize: () => {},
      ...extra,
    }),
  });
}

function reassemble(writes: IWrite[], mipLevel: number): Uint8Array {
  const parts = writes
    .filter((write) => write.destination.mipLevel === mipLevel)
    .map((w) => w.data);
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

it("prepares the real compressed fixture and republishes every transcoded mip byte-for-byte", async () => {
  const { device, writes, created } = mockDevice();
  const renderer = await webgpuRenderer({
    backend: { device },
  });
  try {
    const { texture, mipmaps } = await realCompressed();
    const originalSource = texture.source;
    const originalVersion = originalSource.version;
    texture.wrapS = MirroredRepeatWrapping;
    texture.magFilter = NearestFilter;
    texture.colorSpace = SRGBColorSpace;
    texture.offset.set(0.1, 0.2);
    texture.repeat.set(2, 3);
    texture.rotation = 0.3;
    texture.userData = { label: "borrowed source" };
    const ordinary = new DataTexture(new Uint8Array(4), 1, 1);
    const replacements = new Map<Texture, Texture>();
    const count = await renderer.prepareTextures?.(
      [texture, texture, ordinary],
      undefined,
      undefined,
      replacements,
    );
    expect(count).toBe(1);
    const prepared = replacements.get(texture) as ExternalTexture;
    expect(prepared).toBeInstanceOf(ExternalTexture);
    expect(prepared).not.toBe(texture);
    expect(texture.source).toBe(originalSource);
    expect(originalSource.version).toBe(originalVersion);
    expect(prepared.source).not.toBe(originalSource);
    expect(prepared.source.data).toBe(originalSource.data);
    expect(prepared.sourceTexture).toBe(created[0]);
    expect(prepared.wrapS).toBe(texture.wrapS);
    expect(prepared.magFilter).toBe(texture.magFilter);
    expect(prepared.colorSpace).toBe(texture.colorSpace);
    expect(prepared.offset.toArray()).toEqual([0.1, 0.2]);
    expect(prepared.repeat.toArray()).toEqual([2, 3]);
    expect(prepared.rotation).toBe(0.3);
    expect(prepared.userData).toEqual(texture.userData);
    expect(prepared.userData).not.toBe(texture.userData);
    expect(mipmaps.length).toBe(7);
    for (let mip = 0; mip < mipmaps.length; mip++)
      expect(reassemble(writes, mip)).toEqual(mipmaps[mip]?.data);
    expect(writes.every((write) => write.bytes <= 65_536)).toBe(true);
  } finally {
    renderer.dispose();
  }
});

it("keeps the numeric contract and leaves the caller map empty without a replacement sink", async () => {
  const { device } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    const count = await renderer.prepareTextures?.([compressed()]);
    expect(count).toBe(1);
  } finally {
    renderer.dispose();
  }
});

it("fails closed when no public GPU device is reachable", async () => {
  const renderer = await webgpuRenderer();
  try {
    await expect(renderer.prepareTextures?.([compressed()])).rejects.toThrow(
      /bounded|unsupported|preparation/i,
    );
  } finally {
    renderer.dispose();
  }
});

it("reports only completed unique preparation and leaves the map unpublished after a failure", async () => {
  const { device, writeTexture } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  const observations: number[] = [];
  const first = compressed();
  const second = compressed();
  try {
    writeTexture.mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    const replacements = new Map<Texture, Texture>();
    await expect(
      renderer.prepareTextures?.(
        [first, first, second],
        undefined,
        (completed) => observations.push(completed),
        replacements,
      ),
    ).rejects.toThrow("write failed");
    expect(observations).toEqual([]);
    expect(replacements.size).toBe(0);
  } finally {
    renderer.dispose();
  }
});

it("cancels in-flight preparation when the renderer is disposed", async () => {
  const { device } = mockDevice();
  Object.assign(device, {
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => new Promise(() => {})),
  });
  const renderer = await webgpuRenderer({ backend: { device } });
  const pending = renderer.prepareTextures?.([compressed()]);
  const rejected = expect(pending).rejects.toThrow(/disposed/i);
  await Promise.resolve();
  renderer.dispose();
  await rejected;
});

it("destroys a pending GPU allocation immediately when disposed before the write settles", async () => {
  let releaseValidation: (value: unknown) => void = () => {};
  const validation = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  const destroy = vi.fn();
  const device = {
    queue: { writeTexture: vi.fn() },
    features: { has: vi.fn(() => true) },
    createTexture: vi.fn(() => ({ destroy })),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => validation),
  };
  const renderer = await webgpuRenderer({ backend: { device } });
  const texture = compressed();
  const replacements = new Map<Texture, Texture>();
  const pending = renderer.prepareTextures?.([texture], undefined, undefined, replacements);
  const rejected = expect(pending).rejects.toThrow(/disposed/i);
  await Promise.resolve();
  // The GPU texture exists while the deferred write validation is still pending.
  expect(device.createTexture).toHaveBeenCalledTimes(1);
  expect(destroy).not.toHaveBeenCalled();
  renderer.dispose();
  // Dispose releases the still-pending allocation immediately, before the write settles.
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(replacements.size).toBe(0);
  releaseValidation(null);
  await rejected;
  // The late write settlement must not destroy the allocation a second time.
  expect(destroy).toHaveBeenCalledTimes(1);
});

it("releases a cold original's pending allocation when the original is disposed", async () => {
  let releaseValidation: (value: unknown) => void = () => {};
  const validation = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  const destroy = vi.fn();
  const device = {
    queue: { writeTexture: vi.fn() },
    features: { has: vi.fn(() => true) },
    createTexture: vi.fn(() => ({ destroy })),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => validation),
  };
  const renderer = await webgpuRenderer({ backend: { device } });
  const texture = compressed();
  const replacements = new Map<Texture, Texture>();
  const pending = renderer.prepareTextures?.([texture], undefined, undefined, replacements);
  try {
    await Promise.resolve();
    expect(device.createTexture).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    // The original disposes while its write validation is still pending.
    texture.dispose();
    // Disposal releases the pending allocation before the validation settles.
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(replacements.size).toBe(0);
    releaseValidation(null);
    await expect(pending).rejects.toThrow(/disposed/i);
    // The late validation settlement must not destroy the allocation a second time.
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(replacements.size).toBe(0);
  } finally {
    releaseValidation(null);
    renderer.dispose();
    await pending?.catch(() => undefined);
  }
});

it("publishes no replacement when onProgress disposes the renderer", async () => {
  const { device } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  const replacements = new Map<Texture, Texture>();
  try {
    await expect(
      renderer.prepareTextures?.([compressed()], undefined, () => renderer.dispose(), replacements),
    ).rejects.toThrow(/disposed/i);
    expect(replacements.size).toBe(0);
  } finally {
    renderer.dispose();
  }
});

it("rejects an unsupported format before allocating any GPU texture", async () => {
  const { device, createTexture } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    const texture = new CompressedTexture(
      [{ data: new Uint8Array(16), width: 4, height: 4 }],
      4,
      4,
      RGBAFormat as never,
    );
    texture.needsUpdate = true;
    await expect(renderer.prepareTextures?.([texture])).rejects.toThrow(/unsupported/i);
    expect(createTexture).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
});

it("rejects a format the device does not support before allocating", async () => {
  const { device, createTexture } = mockDevice({ feature: false });
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    await expect(renderer.prepareTextures?.([compressed()])).rejects.toThrow(
      /texture-compression-bc/,
    );
    expect(createTexture).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
});

it("returns the same owned replacement for a repeated call and keeps the old version valid on refresh", async () => {
  const { device, destroy } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    const { texture } = await realCompressed();
    const first = new Map<Texture, Texture>();
    await renderer.prepareTextures?.([texture], undefined, undefined, first);
    const prepared = first.get(texture) as ExternalTexture;
    // A repeated call that hands back the published replacement resolves to the same identity.
    const repeated = new Map<Texture, Texture>();
    await renderer.prepareTextures?.([prepared], undefined, undefined, repeated);
    expect(repeated.get(prepared)).toBe(prepared);
    // A version refresh publishes a new replacement and leaves the previous one valid.
    texture.version += 1;
    const refreshed = new Map<Texture, Texture>();
    await renderer.prepareTextures?.([texture], undefined, undefined, refreshed);
    expect(refreshed.get(texture)).not.toBe(prepared);
    expect(destroy).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
});

it("destroys an allocated replacement exactly once when invalidated before commit", async () => {
  const destroys: ReturnType<typeof vi.fn>[] = [];
  const device = {
    queue: { writeTexture: vi.fn() },
    features: { has: vi.fn(() => true) },
    createTexture: vi.fn(() => {
      const destroy = vi.fn();
      destroys.push(destroy);
      return { destroy };
    }),
  };
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    const { texture } = await realCompressed();
    const committed = new Map<Texture, Texture>();
    await renderer.prepareTextures?.([texture], undefined, undefined, committed);
    const prepared = committed.get(texture);
    expect(prepared).toBeInstanceOf(ExternalTexture);
    expect(destroys).toHaveLength(1);
    expect(destroys[0]).not.toHaveBeenCalled();

    // Invalidate during the write, after allocation and before publication.
    texture.version += 1;
    device.queue.writeTexture.mockImplementationOnce(() => {
      texture.version += 1;
    });
    const invalidated = new Map<Texture, Texture>();
    await expect(
      renderer.prepareTextures?.([texture], undefined, undefined, invalidated),
    ).rejects.toThrow(/invalidated/i);
    // The allocated-but-uncommitted replacement is destroyed exactly once.
    expect(destroys).toHaveLength(2);
    expect(destroys[1]).toHaveBeenCalledTimes(1);
    // The prior committed version is untouched and the caller map is unchanged.
    expect(destroys[0]).not.toHaveBeenCalled();
    expect(invalidated.size).toBe(0);
    expect(committed.get(texture)).toBe(prepared);
  } finally {
    renderer.dispose();
  }
});

it("releases the fresh allocation exactly once when a refreshed copy throws", async () => {
  const destroys: ReturnType<typeof vi.fn>[] = [];
  const device = {
    queue: { writeTexture: vi.fn() },
    features: { has: vi.fn(() => true) },
    createTexture: vi.fn(() => {
      const destroy = vi.fn();
      destroys.push(destroy);
      return { destroy };
    }),
  };
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    const { texture } = await realCompressed();
    const committed = new Map<Texture, Texture>();
    await renderer.prepareTextures?.([texture], undefined, undefined, committed);
    const prepared = committed.get(texture);
    expect(prepared).toBeInstanceOf(ExternalTexture);
    expect(destroys).toHaveLength(1);
    expect(destroys[0]).not.toHaveBeenCalled();

    // A circular `userData` makes `Texture.copy`'s JSON round-trip throw on the refreshed version.
    texture.userData.self = texture.userData;
    texture.version += 1;
    const refreshed = new Map<Texture, Texture>();
    await expect(
      renderer.prepareTextures?.([texture], undefined, undefined, refreshed),
    ).rejects.toThrow(/circular/i);
    // The freshly allocated GPU texture is destroyed exactly once; the committed version survives.
    expect(destroys).toHaveLength(2);
    expect(destroys[1]).toHaveBeenCalledTimes(1);
    expect(destroys[0]).not.toHaveBeenCalled();
    expect(refreshed.size).toBe(0);
    expect(committed.get(texture)).toBe(prepared);
  } finally {
    renderer.dispose();
  }
});

/** Waits one macrotask so queued microtasks, including the lane's first write, have run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A device whose write validation stays pending until `release`. Each allocation records its own
 * destroy mock, so a test can tell which GPU texture a rejection released.
 */
function heldDevice() {
  const destroys: ReturnType<typeof vi.fn>[] = [];
  let validation: Promise<unknown> = Promise.resolve(null);
  let settle: (value: unknown) => void = () => {};
  const device = {
    queue: { writeTexture: vi.fn() },
    features: { has: vi.fn(() => true) },
    createTexture: vi.fn(() => {
      const destroy = vi.fn();
      destroys.push(destroy);
      return { destroy };
    }),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => validation),
  };
  return {
    device,
    destroys,
    hold: () => {
      validation = new Promise((resolve) => {
        settle = resolve;
      });
    },
    release: () => settle(null),
  };
}

type IMip = CompressedTexture["mipmaps"][number];

/**
 * Source edits that leave `texture.version` unchanged. Each one must reject a refresh that is
 * still running and must replace a completed cached version.
 */
const SOURCE_CHANGES: ReadonlyArray<readonly [string, (texture: CompressedTexture) => void]> = [
  [
    "source.version",
    (texture) => {
      texture.source.version += 1;
    },
  ],
  [
    "image width",
    (texture) => {
      (texture.image as { width: number }).width = 8;
    },
  ],
  [
    "mip width",
    (texture) => {
      (texture.mipmaps[0] as { width: number }).width = 2;
    },
  ],
  [
    "image object",
    (texture) => {
      texture.image = { width: 4, height: 4 };
    },
  ],
  [
    "mip object",
    (texture) => {
      texture.mipmaps[0] = { ...(texture.mipmaps[0] as IMip) };
    },
  ],
  [
    "mip data",
    (texture) => {
      (texture.mipmaps[0] as IMip).data = new Uint8Array(16);
    },
  ],
  [
    "mip array",
    (texture) => {
      texture.mipmaps = [...texture.mipmaps];
    },
  ],
  [
    "source object",
    (texture) => {
      texture.source = new Source(texture.image);
    },
  ],
];

/** The UV and matrix state that `Texture.copy` carries into a replacement. */
function uvState(texture: Texture): number[] {
  return [
    texture.offset.x,
    texture.offset.y,
    texture.repeat.x,
    texture.repeat.y,
    texture.rotation,
    ...texture.matrix.elements,
  ];
}

/** UV and matrix edits. None of them sets `needsUpdate`, so the snapshot must detect each one. */
const UV_CHANGES: ReadonlyArray<readonly [string, (texture: CompressedTexture) => void]> = [
  [
    "offset",
    (texture) => {
      texture.offset.x = 0.25;
    },
  ],
  [
    "repeat",
    (texture) => {
      texture.repeat.set(2, 3);
    },
  ],
  [
    "rotation",
    (texture) => {
      texture.rotation = 0.5;
    },
  ],
  [
    "manual matrix",
    (texture) => {
      texture.matrixAutoUpdate = false;
      texture.matrix.elements[6] = 0.25;
    },
  ],
];

/** A readiness edit with no version bump. The snapshot must reject it during a refresh. */
const READY_CHANGES: ReadonlyArray<readonly [string, (texture: CompressedTexture) => void]> = [
  [
    "source.dataReady",
    (texture) => {
      texture.source.dataReady = false;
    },
  ],
];

it.each([...SOURCE_CHANGES, ...UV_CHANGES, ...READY_CHANGES])(
  "rejects a refresh whose %s changes while its write validation is deferred",
  async (_name, change) => {
    const held = heldDevice();
    const renderer = await webgpuRenderer({ backend: { device: held.device } });
    const texture = compressed();
    const committed = new Map<Texture, Texture>();
    let pending: Promise<number> | undefined;
    try {
      await renderer.prepareTextures?.([texture], undefined, undefined, committed);
      const cached = committed.get(texture);
      held.hold();
      texture.version += 1;
      const refreshed = new Map<Texture, Texture>();
      pending = renderer.prepareTextures?.([texture], undefined, undefined, refreshed);
      const rejected = expect(pending).rejects.toThrow(/invalidated/i);
      await flush();
      expect(held.destroys).toHaveLength(2);
      // The source changes without a version bump while the refresh waits on validation.
      change(texture);
      held.release();
      await rejected;
      expect(held.destroys[1]).toHaveBeenCalledTimes(1);
      expect(held.destroys[0]).not.toHaveBeenCalled();
      expect(refreshed.size).toBe(0);
      expect(committed.get(texture)).toBe(cached);
    } finally {
      held.release();
      renderer.dispose();
      await pending?.catch(() => undefined);
    }
  },
);

it.each(UV_CHANGES)(
  "publishes a fresh replacement after a cached %s edit without needsUpdate",
  async (_name, change) => {
    const { device, created } = mockDevice();
    const renderer = await webgpuRenderer({ backend: { device } });
    try {
      const texture = compressed();
      const first = new Map<Texture, Texture>();
      await renderer.prepareTextures?.([texture], undefined, undefined, first);
      const cached = first.get(texture) as Texture;
      const before = uvState(texture);
      change(texture);
      const refreshed = new Map<Texture, Texture>();
      await renderer.prepareTextures?.([texture], undefined, undefined, refreshed);
      expect(refreshed.get(texture)).not.toBe(cached);
      expect(uvState(refreshed.get(texture) as Texture)).toEqual(uvState(texture));
      // The replacement published before the edit keeps the value it was prepared with.
      expect(uvState(cached)).toEqual(before);
      expect(created).toHaveLength(2);
    } finally {
      renderer.dispose();
    }
  },
);

it("refreshes the GPU descriptor after cached colorSpace and format edits without needsUpdate", async () => {
  const { device, created } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    const texture = compressed();
    texture.colorSpace = SRGBColorSpace;
    await renderer.prepareTextures?.([texture]);
    texture.colorSpace = NoColorSpace;
    const linear = new Map<Texture, Texture>();
    await renderer.prepareTextures?.([texture], undefined, undefined, linear);
    texture.format = RGBA_S3TC_DXT5_Format;
    await renderer.prepareTextures?.([texture]);
    const formats = created.map((entry) => (entry.descriptor as { format: string }).format);
    expect(formats).toEqual(["bc7-rgba-unorm-srgb", "bc7-rgba-unorm", "bc3-rgba-unorm"]);
    expect((linear.get(texture) as Texture).colorSpace).toBe(NoColorSpace);
  } finally {
    renderer.dispose();
  }
});

it("drains every popped validation before a synchronous write failure rejects the refresh", async () => {
  // Each pop returns its own pending validation, so the test releases scopes one at a time.
  const scopes: ((value: unknown) => void)[] = [];
  const destroys: ReturnType<typeof vi.fn>[] = [];
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  let holding = false;
  let writes = 0;
  let failAt = 0;
  const device = {
    queue: {
      writeTexture: vi.fn(() => {
        writes += 1;
        // Each write spends the 2 ms budget, so every tile starts a new batch.
        clock += 3;
        if (writes === failAt) throw new Error("write rejected synchronously");
      }),
    },
    features: { has: vi.fn(() => true) },
    createTexture: vi.fn(() => {
      const destroy = vi.fn();
      destroys.push(destroy);
      return { destroy };
    }),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() =>
      holding
        ? new Promise((resolve) => {
            scopes.push(resolve);
          })
        : Promise.resolve(null),
    ),
  };
  const renderer = await webgpuRenderer({ backend: { device } });
  const { texture } = await realCompressed();
  const queued = compressed();
  const committed = new Map<Texture, Texture>();
  const refreshed = new Map<Texture, Texture>();
  const queuedMap = new Map<Texture, Texture>();
  const release = () => {
    holding = false;
    for (const settle of scopes.splice(0)) settle(null);
  };
  let pending: Promise<number> | undefined;
  let queuedPending: Promise<number> | undefined;
  try {
    await renderer.prepareTextures?.([texture], undefined, undefined, committed);
    const cached = committed.get(texture);
    holding = true;
    failAt = writes + 2;
    texture.version += 1;
    const outcome = vi.fn();
    pending = renderer.prepareTextures?.([texture], undefined, undefined, refreshed);
    pending?.then(
      () => outcome("resolved"),
      (error: unknown) => outcome("rejected", error),
    );
    queuedPending = renderer.prepareTextures?.([queued], undefined, undefined, queuedMap);
    await vi.waitFor(() => expect(writes).toBeGreaterThanOrEqual(failAt));
    await flush();
    // Two batches hold four scopes. The failing write must not release the lane early.
    expect(outcome).not.toHaveBeenCalled();
    expect(device.createTexture).toHaveBeenCalledTimes(2);
    scopes.shift()?.(null);
    await flush();
    expect(outcome).not.toHaveBeenCalled();
    expect(device.createTexture).toHaveBeenCalledTimes(2);
    release();
    await expect(pending).rejects.toThrow("write rejected synchronously");
    expect(refreshed.size).toBe(0);
    expect(destroys[1]).toHaveBeenCalledTimes(1);
    expect(destroys[0]).not.toHaveBeenCalled();
    expect(committed.get(texture)).toBe(cached);
    await queuedPending;
    expect(device.createTexture).toHaveBeenCalledTimes(3);
    expect(queuedMap.size).toBe(1);
  } finally {
    release();
    renderer.dispose();
    await Promise.allSettled([pending, queuedPending]);
    now.mockRestore();
  }
});

const INCONSISTENT_DIMENSIONS = new Set(["image width", "mip width"]);

it.each(SOURCE_CHANGES.filter(([name]) => !INCONSISTENT_DIMENSIONS.has(name)))(
  "replaces a completed cached texture when its %s changes without a version bump",
  async (_name, change) => {
    const held = heldDevice();
    const renderer = await webgpuRenderer({ backend: { device: held.device } });
    try {
      const texture = compressed();
      const first = new Map<Texture, Texture>();
      await renderer.prepareTextures?.([texture], undefined, undefined, first);
      const cached = first.get(texture);
      change(texture);
      const second = new Map<Texture, Texture>();
      await renderer.prepareTextures?.([texture], undefined, undefined, second);
      expect(second.get(texture)).toBeInstanceOf(ExternalTexture);
      expect(second.get(texture)).not.toBe(cached);
      // The completed version keeps its GPU texture; only the replacement is new.
      expect(held.destroys).toHaveLength(2);
      expect(held.destroys[0]).not.toHaveBeenCalled();
    } finally {
      renderer.dispose();
    }
  },
);

// A width that disagrees with the base mip is an inconsistent texture, not a new version.
it.each(SOURCE_CHANGES.filter(([name]) => INCONSISTENT_DIMENSIONS.has(name)))(
  "rejects a completed cached texture when its %s no longer matches its mip dimensions",
  async (_name, change) => {
    const held = heldDevice();
    const renderer = await webgpuRenderer({ backend: { device: held.device } });
    try {
      const texture = compressed();
      const first = new Map<Texture, Texture>();
      await renderer.prepareTextures?.([texture], undefined, undefined, first);
      change(texture);
      const second = new Map<Texture, Texture>();
      await expect(
        renderer.prepareTextures?.([texture], undefined, undefined, second),
      ).rejects.toThrow(/Invalid compressed texture dimensions/);
      // The mismatch fails before allocation, so the committed GPU texture stays the only one.
      expect(second.size).toBe(0);
      expect(held.destroys).toHaveLength(1);
      expect(held.destroys[0]).not.toHaveBeenCalled();
    } finally {
      renderer.dispose();
    }
  },
);

it("captures the snapshot at job start so a source change made while queued rejects its write", async () => {
  const held = heldDevice();
  const renderer = await webgpuRenderer({ backend: { device: held.device } });
  const blocker = compressed();
  const queued = compressed();
  const queuedMap = new Map<Texture, Texture>();
  let blocked: Promise<unknown> | undefined;
  let pending: Promise<number> | undefined;
  try {
    held.hold();
    blocked = renderer.prepareTextures?.([blocker]);
    await flush();
    pending = renderer.prepareTextures?.([queued], undefined, undefined, queuedMap);
    const rejected = expect(pending).rejects.toThrow(/invalidated/i);
    // The job already holds its snapshot; this edit lands before the queued write starts.
    queued.source.version += 1;
    held.release();
    await rejected;
    expect(held.destroys).toHaveLength(1);
    expect(queuedMap.size).toBe(0);
    await blocked;
  } finally {
    held.release();
    renderer.dispose();
    await Promise.allSettled([blocked, pending]);
  }
});

it("rejects a new-device request behind an old-device job and prepares on the new device after release", async () => {
  const oldDevice = heldDevice();
  const newDevice = heldDevice();
  const backend = { device: oldDevice.device };
  const renderer = await webgpuRenderer({ backend });
  const texture = compressed();
  const committed = new Map<Texture, Texture>();
  let refresh: Promise<unknown> | undefined;
  let replacement: Promise<unknown> | undefined;
  let replacementError: unknown;
  try {
    await renderer.prepareTextures?.([texture], undefined, undefined, committed);
    const cached = committed.get(texture);
    oldDevice.hold();
    texture.version += 1;
    const refreshed = new Map<Texture, Texture>();
    refresh = renderer.prepareTextures?.([texture], undefined, undefined, refreshed);
    const refreshRejected = expect(refresh).rejects.toThrow(/invalidated/i);
    await flush();
    expect(oldDevice.destroys).toHaveLength(2);

    // The device changes while the old job waits on validation.
    backend.device = newDevice.device;
    const replaced = new Map<Texture, Texture>();
    replacement = renderer
      .prepareTextures?.([texture], undefined, undefined, replaced)
      ?.catch((error: unknown) => {
        replacementError = error;
      });
    await flush();
    // The request fails at once. It neither joins the old job nor allocates on the new device.
    expect((replacementError as Error | undefined)?.message).toMatch(/another device/);
    expect(replaced.size).toBe(0);
    expect(newDevice.device.createTexture).not.toHaveBeenCalled();

    oldDevice.release();
    await refreshRejected;
    // The old job's fresh allocation is destroyed once. Its committed version stays alive.
    expect(oldDevice.destroys[1]).toHaveBeenCalledTimes(1);
    expect(oldDevice.destroys[0]).not.toHaveBeenCalled();
    expect(refreshed.size).toBe(0);
    expect(committed.get(texture)).toBe(cached);

    const next = new Map<Texture, Texture>();
    await renderer.prepareTextures?.([texture], undefined, undefined, next);
    const prepared = next.get(texture);
    expect(prepared).toBeInstanceOf(ExternalTexture);
    expect(newDevice.device.createTexture).toHaveBeenCalledTimes(1);
    // A repeated call on the new device reuses the version it just committed.
    const again = new Map<Texture, Texture>();
    await renderer.prepareTextures?.([texture], undefined, undefined, again);
    expect(again.get(texture)).toBe(prepared);
    expect(newDevice.device.createTexture).toHaveBeenCalledTimes(1);
  } finally {
    oldDevice.release();
    renderer.dispose();
    await Promise.allSettled([refresh, replacement]);
  }
});

it("rejects a pending reuse whose source changed without a version bump", async () => {
  const held = heldDevice();
  const renderer = await webgpuRenderer({ backend: { device: held.device } });
  const texture = compressed();
  let pending: Promise<unknown> | undefined;
  let reused: Promise<unknown> | undefined;
  let reusedError: unknown;
  try {
    held.hold();
    const first = new Map<Texture, Texture>();
    pending = renderer.prepareTextures?.([texture], undefined, undefined, first);
    const rejected = expect(pending).rejects.toThrow(/invalidated/i);
    await flush();
    expect(held.destroys).toHaveLength(1);
    // The source changes without a version bump while the first write waits on validation.
    texture.source.version += 1;
    const second = new Map<Texture, Texture>();
    reused = renderer
      .prepareTextures?.([texture], undefined, undefined, second)
      ?.catch((error: unknown) => {
        reusedError = error;
      });
    await flush();
    // The stale job is not reused, so the second request fails before validation releases.
    expect((reusedError as Error | undefined)?.message).toMatch(/changed during preparation/);
    expect(second.size).toBe(0);
    expect(held.destroys).toHaveLength(1);
    held.release();
    await rejected;
    expect(held.destroys[0]).toHaveBeenCalledTimes(1);
  } finally {
    held.release();
    renderer.dispose();
    await Promise.allSettled([pending, reused]);
  }
});

it("destroys a pending allocation at the first device loss and rejects later calls", async () => {
  const held = heldDevice();
  let lose: (info: unknown) => void = () => {};
  Object.assign(held.device, {
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
  });
  const renderer = await webgpuRenderer({ backend: { device: held.device } });
  const texture = compressed();
  let pending: Promise<unknown> | undefined;
  try {
    held.hold();
    const map = new Map<Texture, Texture>();
    pending = renderer.prepareTextures?.([texture], undefined, undefined, map);
    const rejected = expect(pending).rejects.toThrow(/Device lost during texture preparation/);
    await flush();
    expect(held.destroys).toHaveLength(1);
    lose({ reason: "unknown", message: "test device lost" });
    await flush();
    // The allocation is destroyed at loss, while validation is still held.
    expect(held.destroys[0]).toHaveBeenCalledTimes(1);
    held.release();
    await rejected;
    expect(held.destroys[0]).toHaveBeenCalledTimes(1);
    const later = new Map<Texture, Texture>();
    await expect(
      renderer.prepareTextures?.([compressed()], undefined, undefined, later),
    ).rejects.toThrow(/Device lost during texture preparation/);
    expect(later.size).toBe(0);
    expect(held.device.createTexture).toHaveBeenCalledTimes(1);
  } finally {
    held.release();
    renderer.dispose();
    await Promise.allSettled([pending]);
  }
});

it("invalidates the whole lane when a second observed device is lost", async () => {
  const first = heldDevice();
  const second = heldDevice();
  let loseSecond: (info: unknown) => void = () => {};
  Object.assign(first.device, { lost: new Promise(() => {}) });
  Object.assign(second.device, {
    lost: new Promise((resolve) => {
      loseSecond = resolve;
    }),
  });
  const backend = { device: first.device };
  const renderer = await webgpuRenderer({ backend });
  const texture = compressed();
  try {
    await renderer.prepareTextures?.([texture], undefined, undefined, new Map<Texture, Texture>());
    expect(first.destroys).toHaveLength(1);
    backend.device = second.device;
    await renderer.prepareTextures?.([texture], undefined, undefined, new Map<Texture, Texture>());
    expect(second.destroys).toHaveLength(1);
    loseSecond({ reason: "unknown", message: "second device lost" });
    await flush();
    // The lane owns one allocation per device. Each is destroyed exactly once.
    expect(first.destroys[0]).toHaveBeenCalledTimes(1);
    expect(second.destroys[0]).toHaveBeenCalledTimes(1);
    await expect(renderer.prepareTextures?.([compressed()])).rejects.toThrow(
      /Device lost during texture preparation/,
    );
  } finally {
    renderer.dispose();
  }
});

/** The legacy chain: 320x64 halving to 5x1. */
const LEGACY_CHAIN: ReadonlyArray<readonly [number, number]> = [
  [320, 64],
  [160, 32],
  [80, 16],
  [40, 8],
  [20, 4],
  [10, 2],
  [5, 1],
];

const LEGACY_FORMATS = [
  { name: "bc1-rgba-unorm", format: RGBA_S3TC_DXT1_Format, bw: 4, bh: 4, bb: 8 },
  { name: "bc7-rgba-unorm", format: RGBA_BPTC_Format, bw: 4, bh: 4, bb: 16 },
  { name: "astc-5x4-unorm", format: RGBA_ASTC_5x4_Format, bw: 5, bh: 4, bb: 16 },
];

it.each(LEGACY_FORMATS)(
  "preserves every block, mip tail and layer for $name through prepareTextures",
  async ({ name, format, bw, bh, bb }) => {
    const { device, writes, created } = mockDevice();
    const renderer = await webgpuRenderer({ backend: { device } });
    try {
      // The legacy chain: 320x64 halving to 5x1, three layers, each payload at a nonzero offset.
      const mips = LEGACY_CHAIN.map(([width, height]) => {
        const length = Math.ceil(width / bw) * Math.ceil(height / bh) * bb * 3;
        const backing = new Uint8Array(length + 11);
        const data = backing.subarray(11);
        for (let i = 0; i < data.length; i++) data[i] = (i * 37 + width) % 251;
        return { width, height, data };
      });
      const texture = new CompressedArrayTexture(mips, 320, 64, 3, format);
      texture.needsUpdate = true;
      const replacements = new Map<Texture, Texture>();
      await expect(
        renderer.prepareTextures?.([texture], undefined, undefined, replacements),
      ).resolves.toBe(1);
      expect(replacements.get(texture)).toBeInstanceOf(ExternalTexture);
      expect(created).toHaveLength(1);
      expect(created[0]?.descriptor).toMatchObject({
        size: { width: 320, height: 64, depthOrArrayLayers: 3 },
        format: name,
        mipLevelCount: 7,
      });

      const rebuilt = mips.map((mip) => new Uint8Array(mip.data.length));
      const coverage = mips.map((mip) => new Uint8Array(mip.data.length));
      for (const write of writes) {
        const { mipLevel, origin } = write.destination;
        const { layout, extent } = write;
        const mip = mips[mipLevel];
        const target = rebuilt[mipLevel];
        const covered = coverage[mipLevel];
        if (!mip || !target || !covered || !layout || !extent) throw new Error("Unexpected write");
        // Every write stays inside the byte budget and the block-rounded physical mip.
        expect(write.bytes).toBeLessThanOrEqual(65_536);
        expect(origin.x % bw).toBe(0);
        expect(origin.y % bh).toBe(0);
        expect(extent.width % bw).toBe(0);
        expect(extent.height % bh).toBe(0);
        expect(origin.x + extent.width).toBeLessThanOrEqual(Math.ceil(mip.width / bw) * bw);
        expect(origin.y + extent.height).toBeLessThanOrEqual(Math.ceil(mip.height / bh) * bh);
        expect(origin.z).toBeLessThan(3);
        expect(extent.depthOrArrayLayers).toBe(1);
        const stride = Math.ceil(mip.width / bw) * bb;
        const rows = Math.ceil(mip.height / bh);
        expect(layout.bytesPerRow).toBe(stride);
        expect(layout.rowsPerImage).toBe(rows);
        const widthBytes = (extent.width / bw) * bb;
        for (let row = 0; row < extent.height / bh; row++) {
          const offset =
            origin.z * stride * rows + (origin.y / bh + row) * stride + (origin.x / bw) * bb;
          target.set(write.data.subarray(row * stride, row * stride + widthBytes), offset);
          for (let i = offset; i < offset + widthBytes; i++) covered[i] = (covered[i] ?? 0) + 1;
        }
      }
      expect(rebuilt).toEqual(mips.map((mip) => mip.data));
      expect(coverage.every((mip) => mip.every((count) => count === 1))).toBe(true);
      expect(new Set(writes.map((write) => write.destination.texture)).size).toBe(1);
    } finally {
      renderer.dispose();
    }
  },
);

it("rejects a mip whose size is not the halved base before any GPU allocation", async () => {
  const { device, createTexture } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    // Mip 1 must be 4x4 for an 8x8 base. This mip repeats the base size.
    const texture = new CompressedTexture(
      [
        { data: new Uint8Array(64), width: 8, height: 8 },
        { data: new Uint8Array(64), width: 8, height: 8 },
      ],
      8,
      8,
      RGBA_BPTC_Format,
    );
    texture.needsUpdate = true;
    await expect(renderer.prepareTextures?.([texture])).rejects.toThrow(
      /Invalid compressed texture dimensions/,
    );
    expect(createTexture).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
});

it("rejects a mip chain longer than the base dimensions allow before any GPU allocation", async () => {
  const { device, createTexture } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    // A 4x4 base holds three levels. The fourth 1x1 level is excess, and each size is correct.
    const texture = new CompressedTexture(
      [4, 2, 1, 1].map((size) => ({ data: new Uint8Array(16), width: size, height: size })),
      4,
      4,
      RGBA_BPTC_Format,
    );
    texture.needsUpdate = true;
    await expect(renderer.prepareTextures?.([texture])).rejects.toThrow(
      /Invalid compressed texture mip chain/,
    );
    expect(createTexture).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
});

it("rejects an unaligned block-compressed base before allocating when unaligned support is absent", async () => {
  const createTexture = vi.fn(() => ({ destroy: vi.fn() }));
  // Only the unaligned capability is missing. Every other feature the format needs is present.
  const features = { has: vi.fn((name: string) => name !== "texture-compression-unaligned") };
  const renderer = await webgpuRenderer({
    backend: { device: { queue: { writeTexture: vi.fn() }, features, createTexture } },
  });
  try {
    // A 5x5 base spans two block columns and two block rows of 4x4 BC7 blocks.
    const texture = new CompressedTexture(
      [{ data: new Uint8Array(64), width: 5, height: 5 }],
      5,
      5,
      RGBA_BPTC_Format,
    );
    texture.needsUpdate = true;
    await expect(renderer.prepareTextures?.([texture])).rejects.toThrow(/block-aligned/);
    expect(features.has).toHaveBeenCalledWith("texture-compression-unaligned");
    expect(createTexture).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
});

it("prepares an unaligned block-compressed base when the device reports unaligned support", async () => {
  const { device, created, writes } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    const texture = new CompressedTexture(
      [{ data: new Uint8Array(64), width: 5, height: 5 }],
      5,
      5,
      RGBA_BPTC_Format,
    );
    texture.needsUpdate = true;
    const replacements = new Map<Texture, Texture>();
    await expect(
      renderer.prepareTextures?.([texture], undefined, undefined, replacements),
    ).resolves.toBe(1);
    expect(created).toHaveLength(1);
    expect(writes).not.toHaveLength(0);
    // The rounded physical extent is 8x8, so every write stays inside it.
    for (const { destination, extent } of writes) {
      expect(destination.origin.x + (extent?.width ?? 0)).toBeLessThanOrEqual(8);
      expect(destination.origin.y + (extent?.height ?? 0)).toBeLessThanOrEqual(8);
    }
  } finally {
    renderer.dispose();
  }
});

/** A 4x4 BC7 array with one mip of `layers` layers. Surplus layers beyond `depth` are allowed. */
function layered(depth: number, layers = 4): CompressedArrayTexture {
  const value = new CompressedArrayTexture(
    [{ data: new Uint8Array(16 * layers), width: 4, height: 4 }],
    4,
    4,
    depth,
    RGBA_BPTC_Format,
  );
  value.needsUpdate = true;
  return value;
}

it("rejects truncated array layer data before allocating or publishing", async () => {
  const { device, createTexture, writeTexture } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    // Depth three needs three 16-byte layers. The mip holds only two.
    const replacements = new Map<Texture, Texture>();
    await expect(
      renderer.prepareTextures?.([layered(3, 2)], undefined, undefined, replacements),
    ).rejects.toThrow(/Invalid compressed texture layer data/);
    expect(createTexture).not.toHaveBeenCalled();
    expect(writeTexture).not.toHaveBeenCalled();
    expect(replacements.size).toBe(0);
  } finally {
    renderer.dispose();
  }
});

it("rejects an image byte count beyond the safe integer range before allocating", async () => {
  const { device, createTexture } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    // One 2^40-square BC7 layer needs 2^80 bytes. The data is tiny, so only the count is unsafe.
    const side = 2 ** 40;
    const texture = new CompressedTexture(
      [{ data: new Uint8Array(16), width: side, height: side }],
      side,
      side,
      RGBA_BPTC_Format,
    );
    texture.needsUpdate = true;
    await expect(renderer.prepareTextures?.([texture])).rejects.toThrow(
      /Invalid compressed texture layer data/,
    );
    expect(createTexture).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
});

it("invalidates a fresh array job when its depth changes after allocation", async () => {
  const destroys: ReturnType<typeof vi.fn>[] = [];
  const scopes: ((value: unknown) => void)[] = [];
  let holding = false;
  const device = {
    queue: { writeTexture: vi.fn() },
    features: { has: vi.fn(() => true) },
    createTexture: vi.fn(() => {
      const destroy = vi.fn();
      destroys.push(destroy);
      return { destroy };
    }),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() =>
      holding
        ? new Promise((resolve) => {
            scopes.push(resolve);
          })
        : Promise.resolve(null),
    ),
  };
  const release = () => {
    holding = false;
    for (const settle of scopes.splice(0)) settle(null);
  };
  const renderer = await webgpuRenderer({ backend: { device } });
  const texture = layered(3);
  const committed = new Map<Texture, Texture>();
  const refreshed = new Map<Texture, Texture>();
  let pending: Promise<number> | undefined;
  try {
    await renderer.prepareTextures?.([texture], undefined, undefined, committed);
    const prepared = committed.get(texture);
    // Hold the next job's validation so the depth change lands after its allocation.
    holding = true;
    texture.version += 1;
    pending = renderer.prepareTextures?.([texture], undefined, undefined, refreshed);
    await vi.waitFor(() => expect(scopes.length).toBeGreaterThan(0));
    texture.image.depth = 2;
    release();
    await expect(pending).rejects.toThrow(/invalidated/i);
    // The fresh allocation is destroyed once. The committed replacement stays alive and published.
    expect(destroys).toHaveLength(2);
    expect(destroys[1]).toHaveBeenCalledTimes(1);
    expect(destroys[0]).not.toHaveBeenCalled();
    expect(refreshed.size).toBe(0);
    expect(committed.get(texture)).toBe(prepared);
  } finally {
    release();
    await pending?.catch(() => undefined);
    renderer.dispose();
  }
});

it("publishes a fresh replacement after a committed depth change to valid data", async () => {
  const { device, created, destroy } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    const texture = layered(3);
    const first = new Map<Texture, Texture>();
    await renderer.prepareTextures?.([texture], undefined, undefined, first);
    // Four layers back the new depth, so the changed payload is valid.
    texture.image.depth = 4;
    const refreshed = new Map<Texture, Texture>();
    await expect(
      renderer.prepareTextures?.([texture], undefined, undefined, refreshed),
    ).resolves.toBe(1);
    expect(created).toHaveLength(2);
    expect(created[1]?.descriptor).toMatchObject({ size: { depthOrArrayLayers: 4 } });
    expect(refreshed.get(texture)).not.toBe(first.get(texture));
    // The prior replacement stays valid until its lifetime ends.
    expect(destroy).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
});

it("fails closed after a committed depth change without layer data", async () => {
  const { device, created, destroy } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    const texture = layered(3);
    await renderer.prepareTextures?.([texture]);
    // Depth five needs five layers, and the mip holds four.
    texture.image.depth = 5;
    const refreshed = new Map<Texture, Texture>();
    await expect(
      renderer.prepareTextures?.([texture], undefined, undefined, refreshed),
    ).rejects.toThrow(/Invalid compressed texture layer data/);
    // No replacement is allocated, and the prior one keeps its GPU texture.
    expect(created).toHaveLength(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(refreshed.size).toBe(0);
  } finally {
    renderer.dispose();
  }
});

it("rejects a 2D compressed texture that declares image depth before allocating", async () => {
  const { device, createTexture } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    // The 2D constructor sets no depth. A declared depth above one would drop layers silently.
    const texture = compressed();
    Object.assign(texture.image, { depth: 4 });
    await expect(renderer.prepareTextures?.([texture])).rejects.toThrow(
      /cannot carry image depth above 1/,
    );
    expect(createTexture).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
});

async function rejectsDeclaredDepth(depth: unknown, message: RegExp): Promise<void> {
  const { device, createTexture, writeTexture } = mockDevice();
  const renderer = await webgpuRenderer({ backend: { device } });
  try {
    const texture = compressed();
    Object.assign(texture.image, { depth });
    const replacements = new Map<Texture, Texture>();
    await expect(
      renderer.prepareTextures?.([texture], undefined, undefined, replacements),
    ).rejects.toThrow(message);
    expect(createTexture).not.toHaveBeenCalled();
    expect(writeTexture).not.toHaveBeenCalled();
    expect(replacements.size).toBe(0);
  } finally {
    renderer.dispose();
  }
}

// A 2D texture accepts only an undefined or 1 depth. Invalid values must not suggest an array class.
it.each([Number.NaN, 0, -1, Number.NEGATIVE_INFINITY, 0.5, null])(
  "rejects a 2D compressed texture declaring invalid image depth %s before allocating",
  (depth) =>
    rejectsDeclaredDepth(
      depth,
      /^Invalid compressed 2D texture depth\. Only undefined or 1 is valid\.$/,
    ),
);

it.each([Number.POSITIVE_INFINITY, 1.5])(
  "rejects a 2D compressed texture declaring oversized image depth %s before allocating",
  (depth) => rejectsDeclaredDepth(depth, /cannot carry image depth above 1/),
);

it.each([undefined, 1])(
  "prepares a 2D compressed texture declaring image depth %s as one layer",
  async (depth) => {
    const { device, createTexture } = mockDevice();
    const renderer = await webgpuRenderer({ backend: { device } });
    try {
      const texture = compressed();
      Object.assign(texture.image, { depth });
      await expect(renderer.prepareTextures?.([texture])).resolves.toBe(1);
      expect(createTexture).toHaveBeenCalledTimes(1);
      expect(createTexture.mock.calls[0]?.[0]).toMatchObject({ size: { depthOrArrayLayers: 1 } });
    } finally {
      renderer.dispose();
    }
  },
);

it("rejects a cancelled caller at once and starts the next allocation after every popped scope settles", async () => {
  // Each pop returns its own deferred validation, so the test releases scopes one at a time.
  const scopes: ((value: unknown) => void)[] = [];
  const destroys: ReturnType<typeof vi.fn>[] = [];
  let holding = true;
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const device = {
    queue: {
      writeTexture: vi.fn(() => {
        // Each write spends the 2 ms budget, so every tile starts a new batch.
        clock += 3;
      }),
    },
    features: { has: vi.fn(() => true) },
    createTexture: vi.fn(() => {
      const destroy = vi.fn();
      destroys.push(destroy);
      return { destroy };
    }),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() =>
      holding
        ? new Promise((resolve) => {
            scopes.push(resolve);
          })
        : Promise.resolve(null),
    ),
  };
  const renderer = await webgpuRenderer({ backend: { device } });
  const { texture } = await realCompressed();
  const queued = compressed();
  const controller = new AbortController();
  const first = new Map<Texture, Texture>();
  const next = new Map<Texture, Texture>();
  const release = () => {
    holding = false;
    for (const settle of scopes.splice(0)) settle(null);
  };
  let pending: Promise<number> | undefined;
  let queuedPending: Promise<number> | undefined;
  try {
    pending = renderer.prepareTextures?.([texture], controller.signal, undefined, first);
    queuedPending = renderer.prepareTextures?.([queued], undefined, undefined, next);
    // Four batches of two pops each hold eight scopes. The lane then waits on the first batch.
    await vi.waitFor(() => expect(scopes).toHaveLength(8));
    controller.abort(new Error("caller cancelled"));
    // The caller rejects at once, while every popped scope is still pending.
    await expect(pending).rejects.toThrow("caller cancelled");
    expect(device.createTexture).toHaveBeenCalledTimes(1);
    // Settling one scope is not enough. The first batch still waits on its partner scope.
    scopes.shift()?.(null);
    await flush();
    expect(device.createTexture).toHaveBeenCalledTimes(1);
    expect(next.size).toBe(0);
    // Settling every remaining scope lets the lane finish and start the queued allocation.
    release();
    await queuedPending;
    expect(device.createTexture).toHaveBeenCalledTimes(2);
    expect(destroys[0]).toHaveBeenCalledTimes(1);
    expect(destroys[1]).not.toHaveBeenCalled();
    expect(first.size).toBe(0);
    expect(next.size).toBe(1);
  } finally {
    release();
    renderer.dispose();
    await Promise.allSettled([pending, queuedPending]);
    now.mockRestore();
  }
});
