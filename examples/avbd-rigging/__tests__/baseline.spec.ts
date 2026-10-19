import { BufferAttribute, BufferGeometry, Mesh } from "three";
import {
  MeshBasicNodeMaterial,
  ReadbackBuffer,
  type StorageArrayElementNode,
  type StorageBufferNode,
} from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { AnchoredCloth } from "../src/game.js";
import { observeCloth } from "../src/physics/cloth-observation.js";

const drain = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function fixture(readbackEveryFrames = 1) {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0]), 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const source = new MeshBasicNodeMaterial();
  const accepted = vi.fn(() => 0.25);
  const cloth = new AnchoredCloth(
    new Mesh(geometry, source),
    {
      stiffness: 1000,
      damping: 1.8,
      gravity: [0, -9.81, 0],
      wind: [0, 0, 0],
      pinned: [0, 1],
      readbackEveryFrames,
    },
    accepted,
  );
  const readback = vi.fn(
    async (_attribute?: unknown, _target?: ReadbackBuffer) => new ArrayBuffer(64),
  );
  const renderer = { kind: "webgpu", compute: vi.fn(), readback } as unknown as Parameters<
    AnchoredCloth["attachRenderer"]
  >[0];
  const dispose = () => {
    cloth.detach();
    geometry.dispose();
    source.dispose();
  };
  return { cloth, accepted, renderer, readback, dispose };
}

describe("independent spring-arm observations", () => {
  it("counts actual padded GPU bytes before SoftBody compacts the four-vertex sample", async () => {
    const f = fixture();
    try {
      f.cloth.attachRenderer(f.renderer);
      f.cloth.process(f.renderer);
      await drain();
      expect(f.cloth.readbackBytes).toBe(64);
      expect(f.cloth.sample?.data.byteLength).toBe(48);
      expect(f.cloth.readbackFailures).toBe(0);
      expect(f.cloth.position.x).toBe(0.25);
    } finally {
      f.dispose();
    }
  });

  it("reports a rejected real SoftBody readback instead of zero failures or bytes", async () => {
    const f = fixture();
    f.readback.mockRejectedValueOnce(new Error("mapped copy rejected"));
    try {
      f.cloth.attachRenderer(f.renderer);
      f.cloth.process(f.renderer);
      await drain();
      expect(f.cloth.readbackFailures).toBe(1);
      expect(f.cloth.readbackBytes).toBe(0);
      expect(f.cloth.sample).toBeUndefined();
    } finally {
      f.dispose();
    }
  });

  it("preserves the parent's attached-renderer default and released no-op", () => {
    const f = fixture();
    try {
      f.cloth.attachRenderer(f.renderer);
      f.cloth.process();
      expect(f.cloth.steps).toBe(1);
      f.cloth.detach();
      f.cloth.position.x = 7;
      f.accepted.mockClear();
      f.renderer.compute = vi.fn();
      expect(() => f.cloth.process()).not.toThrow();
      expect(() => f.cloth.process(f.renderer)).not.toThrow();
      expect(f.accepted).not.toHaveBeenCalled();
      expect(f.renderer.compute).not.toHaveBeenCalled();
      expect(f.cloth.position.x).toBe(7);
      expect(f.cloth.steps).toBe(1);
    } finally {
      f.dispose();
    }
  });

  it("rejects a foreign dispatch renderer and excludes a late old-scene copy", async () => {
    const f = fixture();
    let land: ((value: ArrayBuffer) => void) | undefined;
    f.readback.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    try {
      f.cloth.attachRenderer(f.renderer);
      expect(() => f.cloth.process({ ...f.renderer })).toThrow("TN_RIGGING_BASELINE");
      f.cloth.process(f.renderer);
      f.cloth.detach();
      if (land === undefined) throw new Error("test failed to issue a real pending readback");
      land(new ArrayBuffer(64));
      await drain();
      expect(f.cloth.readbackBytes).toBe(0);
      expect(f.cloth.readbackFailures).toBe(0);
      expect(f.cloth.sample).toBeUndefined();
    } finally {
      f.dispose();
    }
  });
});

describe("explicit public spring position observations after primary timing", () => {
  it("reads GPU position storage with packed/padded byte and fixed-tick receipts", async () => {
    const f = fixture(0);
    try {
      f.cloth.attachRenderer(f.renderer);
      f.cloth.process();
      expect(f.readback).not.toHaveBeenCalled();
      const sample = await observeCloth(f.cloth, f.renderer, 4);
      expect(sample).toMatchObject({ fixedStep: 1, staleTicks: 0, bytes: 64 });
      expect(sample.positions).toHaveLength(12);
      expect(f.readback).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });
  it("rejects a real pending copy after the old cloth detaches", async () => {
    const f = fixture(0);
    let land: ((bytes: ArrayBuffer) => void) | undefined;
    f.readback.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    try {
      f.cloth.attachRenderer(f.renderer);
      const pending = observeCloth(f.cloth, f.renderer, 4);
      const rejected = expect(pending).rejects.toThrow(/TN_RIGGING_OBSERVATION_STALE/);
      f.cloth.detach();
      if (land === undefined) throw new Error("missing explicit copy");
      land(new ArrayBuffer(64));
      await rejected;
    } finally {
      f.dispose();
    }
  });
  it.each(["count", "bytes", "nonfinite"])(
    "rejects malformed %s instead of a zero-error observation",
    async (mode) => {
      const f = fixture(0);
      try {
        f.cloth.attachRenderer(f.renderer);
        if (mode === "bytes") f.readback.mockResolvedValueOnce(new ArrayBuffer(4));
        if (mode === "nonfinite") {
          const data = new Float32Array(16);
          data[0] = Number.NaN;
          f.readback.mockResolvedValueOnce(data.buffer);
        }
        await expect(observeCloth(f.cloth, f.renderer, mode === "count" ? 3 : 4)).rejects.toThrow(
          /TN_RIGGING_OBSERVATION_INVALID/,
        );
      } finally {
        f.dispose();
      }
    },
  );
});

it("refuses primary spring timing while periodic readbacks are enabled", () => {
  const f = fixture();
  try {
    expect(() => f.cloth.enableTimings({} as never)).toThrow(/TN_RIGGING_TIMING_INVALID/);
  } finally {
    f.dispose();
  }
});

it("accepts the actual Three GPU-mutated padded vec3 attribute without changing vertex count", async () => {
  const f = fixture(0);
  try {
    f.cloth.attachRenderer(f.renderer);
    const element = f.cloth.material.positionNode as StorageArrayElementNode<BufferAttribute>;
    const node = element.node as StorageBufferNode<BufferAttribute>;
    node.value.itemSize = 4;
    node.value.array = new Float32Array(16);
    expect(node.value.count).toBe(4);
    const sample = await observeCloth(f.cloth, f.renderer, 4);
    expect(sample.positions).toHaveLength(12);
  } finally {
    f.dispose();
  }
});
it("owns and disposes the explicit readback target even when mapping rejects", async () => {
  const f = fixture(0);
  let target: ReadbackBuffer | undefined;
  const disposed = vi.fn();
  f.readback.mockImplementationOnce(async (...args) => {
    target = args[1] as ReadbackBuffer | undefined;
    target?.addEventListener("dispose", disposed);
    throw new Error("map rejected");
  });
  try {
    f.cloth.attachRenderer(f.renderer);
    await expect(observeCloth(f.cloth, f.renderer, 4)).rejects.toThrow("map rejected");
    expect(target).toBeInstanceOf(ReadbackBuffer);
    expect(disposed).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});
it("retires immediately but defers GPU storage disposal until the pending final copy settles", async () => {
  const f = fixture(0);
  let land: ((value: ArrayBuffer) => void) | undefined;
  f.readback.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        land = resolve;
      }),
  );
  try {
    f.cloth.attachRenderer(f.renderer);
    const element = f.cloth.material.positionNode as StorageArrayElementNode<BufferAttribute>;
    const disposed = vi.spyOn(
      (element.node as StorageBufferNode<BufferAttribute>).value,
      "dispose",
    );
    const pending = f.cloth.observePositions(4);
    const rejected = expect(pending).rejects.toThrow(/TN_RIGGING_OBSERVATION_STALE/);
    f.cloth.detach();
    expect(f.cloth.released).toBe(true);
    expect(disposed).not.toHaveBeenCalled();
    land?.(new ArrayBuffer(64));
    await rejected;
    await f.cloth.whenReleased();
    expect(disposed).toHaveBeenCalledOnce();
    expect(f.cloth.readbackBytes).toBe(0);
  } finally {
    f.dispose();
  }
});

it("fails retirement when owned periodic staging cleanup throws, even after the map lands", async () => {
  const f = fixture();
  const failure = new Error("staging destroy failed");
  f.readback.mockImplementationOnce(async (...args) => {
    const target = args[1] as ReadbackBuffer;
    target.addEventListener("dispose", () => {
      throw failure;
    });
    return new ArrayBuffer(64);
  });
  try {
    f.cloth.attachRenderer(f.renderer);
    f.cloth.process();
    await drain();
    f.cloth.detach();
    await expect(f.cloth.whenReleased()).rejects.toThrow(/TN_RIGGING_READBACK_RELEASE/);
  } finally {
    f.dispose();
  }
});
it("fails retirement when a final supplied target cleanup throws after the old scene retires", async () => {
  const f = fixture(0);
  let land: ((bytes: ArrayBuffer) => void) | undefined;
  f.readback.mockImplementationOnce((...args) => {
    (args[1] as ReadbackBuffer).addEventListener("dispose", () => {
      throw new Error("staging destroy failed");
    });
    return new Promise((resolve) => {
      land = resolve;
    });
  });
  try {
    f.cloth.attachRenderer(f.renderer);
    const pending = f.cloth.observePositions(4);
    const failed = expect(pending).rejects.toThrow(/TN_RIGGING_READBACK_RELEASE/);
    f.cloth.detach();
    land?.(new ArrayBuffer(64));
    await failed;
    await expect(f.cloth.whenReleased()).rejects.toThrow(/TN_RIGGING_READBACK_RELEASE/);
  } finally {
    f.dispose();
  }
});
