import { afterEach, describe, expect, it, vi } from "vitest";
import { ANIMAL_LIMITS, parseAnimalBake } from "../src/format.js";
import { createAnimalGeometry, loadAnimalBake } from "../src/runtime.js";
import { animalFixture, encodeFixture } from "./fixture.js";

const allocated = vi.hoisted(() => ({ geometries: 0 }));
vi.mock("three", async (original) => {
  const three = await original<typeof import("three")>();
  return {
    ...three,
    BufferGeometry: class extends three.BufferGeometry {
      constructor() {
        super();
        allocated.geometries++;
      }
    },
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  allocated.geometries = 0;
});

function fixtureRecord(
  header: Record<string, unknown>,
  field: string,
  index: number,
): Record<string, unknown> {
  const value = (header[field] as Record<string, unknown>[])[index];
  if (!value) throw new Error(`Missing test fixture ${field}[${index}]`);
  return value;
}

describe("PANM public trust boundary", () => {
  it("preserves skin/rig/material arrays and snapshots the caller's input", () => {
    const original = animalFixture();
    const buffer = encodeFixture(original);
    const { bake, geometry } = createAnimalGeometry(buffer);
    expect(allocated.geometries).toBe(1);
    for (const key of [
      "pos",
      "nrm",
      "index",
      "skinIndex",
      "skinWeight",
      "comb",
      "tint",
      "coat",
      "pat",
      "surf",
    ] as const) {
      expect(bake[key]).toEqual(original[key]);
    }
    expect(bake.bones).toEqual(original.bones);
    expect(geometry.getAttribute("skinIndex").array).toEqual(original.skinIndex);
    expect(geometry.getAttribute("aCoat").array).toEqual(original.coat);
    new Uint8Array(buffer).fill(0);
    expect(bake.pos).toEqual(original.pos);
    geometry.dispose();
  });

  it.each([
    [
      "INDEX",
      (data: ReturnType<typeof animalFixture>) => {
        data.index[0] = 3;
      },
    ],
    [
      "BONE_INDEX",
      (data: ReturnType<typeof animalFixture>) => {
        data.skinIndex[0] = 1;
      },
    ],
    [
      "FINITE",
      (data: ReturnType<typeof animalFixture>) => {
        data.pos[0] = Number.NaN;
      },
    ],
    [
      "WEIGHTS",
      (data: ReturnType<typeof animalFixture>) => {
        data.skinWeight[0] = 0.5;
      },
    ],
    [
      "WEIGHTS",
      (data: ReturnType<typeof animalFixture>) => {
        data.skinWeight[0] = -1;
      },
    ],
    [
      "LIMIT",
      (data: ReturnType<typeof animalFixture>) => {
        data.nV = 250_001;
      },
    ],
  ])("rejects %s before constructing geometry", (code, change) => {
    const data = animalFixture();
    change(data);
    expect(() => createAnimalGeometry(encodeFixture(data))).toThrow(`TN_ANIMAL_${code}`);
    expect(allocated.geometries).toBe(0);
  });

  it.each([
    [
      "unknown revision",
      (header: Record<string, unknown>) => {
        header.threenative = { donorRevision: "unrecognized" };
      },
    ],
    [
      "coerced tier",
      (header: Record<string, unknown>) => {
        header.quality = ["crowd"];
      },
    ],
    [
      "coerced section key",
      (header: Record<string, unknown>) => {
        fixtureRecord(header, "arrays", 0).key = ["pos"];
      },
    ],
    [
      "inherited toString joint",
      (header: Record<string, unknown>) => {
        fixtureRecord(header, "bones", 0).headJ = "toString";
      },
    ],
    [
      "wide header",
      (header: Record<string, unknown>) => {
        header.unknown = Array(150_000).fill(0);
      },
    ],
    [
      "inherited joint",
      (header: Record<string, unknown>) => {
        fixtureRecord(header, "bones", 0).headJ = "constructor";
      },
    ],
    [
      "unknown tier",
      (header: Record<string, unknown>) => {
        header.quality = "hero";
      },
    ],
    [
      "wrong type",
      (header: Record<string, unknown>) => {
        fixtureRecord(header, "arrays", 0).type = "Float64Array";
      },
    ],
    [
      "overlap",
      (header: Record<string, unknown>) => {
        fixtureRecord(header, "arrays", 1).offset = 0;
      },
    ],
    [
      "unaligned section",
      (header: Record<string, unknown>) => {
        fixtureRecord(header, "arrays", 0).offset = 1;
      },
    ],
    [
      "huge section",
      (header: Record<string, unknown>) => {
        fixtureRecord(header, "arrays", 0).length = 0xffff_ffff;
      },
    ],
    [
      "duplicate section",
      (header: Record<string, unknown>) => {
        (header.arrays as unknown[])[1] = (header.arrays as unknown[])[0];
      },
    ],
    [
      "missing section",
      (header: Record<string, unknown>) => {
        (header.arrays as unknown[]).pop();
      },
    ],
    [
      "missing parent",
      (header: Record<string, unknown>) => {
        fixtureRecord(header, "bones", 0).parent = "missing";
      },
    ],
    [
      "cyclic rig",
      (header: Record<string, unknown>) => {
        fixtureRecord(header, "bones", 0).parent = "root";
      },
    ],
    [
      "null size",
      (header: Record<string, unknown>) => {
        header.params = { size: null };
      },
    ],
  ])("rejects %s", (_label, change) => {
    expect(() => createAnimalGeometry(encodeFixture(animalFixture(), change))).toThrow(
      "TN_ANIMAL_",
    );
    expect(allocated.geometries).toBe(0);
  });

  it("rejects magic/version/truncation/contradictory length and payload limits", () => {
    const buffer = encodeFixture();
    for (const truncated of [0, 4, 11, 16, buffer.byteLength - 8])
      expect(() => parseAnimalBake(buffer.slice(0, truncated))).toThrow("TN_ANIMAL_");
    const badMagic = buffer.slice(0);
    new Uint8Array(badMagic)[0] = 0;
    expect(() => parseAnimalBake(badMagic)).toThrow("TN_ANIMAL_MAGIC");
    const badVersion = buffer.slice(0);
    new DataView(badVersion).setUint32(4, 2, true);
    expect(() => parseAnimalBake(badVersion)).toThrow("TN_ANIMAL_REVISION");
    const trailing = new Uint8Array(buffer.byteLength + 8);
    trailing.set(new Uint8Array(buffer));
    expect(() => parseAnimalBake(trailing.buffer)).toThrow("TN_ANIMAL_SECTIONS");
    expect(() => parseAnimalBake(new ArrayBuffer(ANIMAL_LIMITS.bytes + 1))).toThrow(
      "TN_ANIMAL_LIMIT",
    );
  });

  it("rejects finite byte corruption that still passes structural and range checks", () => {
    const buffer = encodeFixture();
    const headerBytes = new DataView(buffer).getUint32(8, true);
    const start = Math.ceil((12 + headerBytes) / 8) * 8;
    new DataView(buffer).setFloat32(start, 0.125, true);
    expect(() => createAnimalGeometry(buffer)).toThrow("TN_ANIMAL_INTEGRITY");
    expect(allocated.geometries).toBe(0);
  });

  it("loads the manifest-resolved URL and never falls back after corruption", async () => {
    const resolve = vi.fn(async () => ["/wolf.1234.animal"]);
    const request = vi.fn(async () => new Response(encodeFixture()));
    vi.stubGlobal("fetch", request);
    expect((await loadAnimalBake({ resolve }, "wolf.animal")).nV).toBe(3);
    expect(resolve).toHaveBeenCalledWith("wolf.animal");
    expect(request).toHaveBeenCalledWith("/wolf.1234.animal", { signal: undefined });
    request.mockResolvedValue(new Response(new Uint8Array([0])));
    await expect(
      loadAnimalBake({ resolve: async () => ["/corrupt", "/source"] }, "wolf.animal"),
    ).rejects.toThrow("TN_ANIMAL_LIMIT");
    expect(request).toHaveBeenCalledTimes(2);
    expect(allocated.geometries).toBe(0);
  });

  it.each([404, 200])("cancels rejected response bodies (HTTP %s)", async (status) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(stream, {
      status,
      headers: status === 200 ? { "content-length": String(ANIMAL_LIMITS.bytes + 1) } : {},
    });
    vi.stubGlobal("fetch", async () => response);
    await expect(loadAnimalBake({ resolve: async () => ["/wolf"] }, "wolf.animal")).rejects.toThrow(
      status === 200 ? "TN_ANIMAL_LIMIT" : "TN_ANIMAL_LOAD",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(allocated.geometries).toBe(0);
  });

  it("bounds unannounced/underreported streamed bytes before materializing the bake", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(ANIMAL_LIMITS.bytes));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const response = new Response(stream, { headers: { "content-length": "1" } });
    const materialize = vi.spyOn(response, "arrayBuffer");
    vi.stubGlobal("fetch", async () => response);
    await expect(
      loadAnimalBake({ resolve: async () => ["/oversized"] }, "wolf.animal"),
    ).rejects.toThrow("TN_ANIMAL_LIMIT");
    expect(materialize).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(allocated.geometries).toBe(0);
  });

  it("cancels delayed resolution and a pending body read with a named error", async () => {
    const resolving = new AbortController();
    const resolve = () => new Promise<readonly string[]>(() => {});
    const load = loadAnimalBake({ resolve }, "wolf.animal", { signal: resolving.signal });
    resolving.abort();
    await expect(load).rejects.toThrow("TN_ANIMAL_ABORTED");
    const reading = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
      },
    });
    vi.stubGlobal("fetch", async () => new Response(stream));
    const bodyLoad = loadAnimalBake({ resolve: async () => ["/wolf"] }, "wolf.animal", {
      signal: reading.signal,
    });
    await new Promise<void>((done) => setTimeout(done, 0));
    reading.abort();
    await expect(bodyLoad).rejects.toThrow("TN_ANIMAL_ABORTED");
    expect(allocated.geometries).toBe(0);
  });

  it("rejects oversized already-buffered native-shaped responses before geometry", async () => {
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(ANIMAL_LIMITS.bytes + 1),
    };
    vi.stubGlobal("fetch", async () => response);
    await expect(loadAnimalBake({ resolve: async () => ["/wolf"] }, "wolf.animal")).rejects.toThrow(
      "TN_ANIMAL_LIMIT",
    );
    expect(allocated.geometries).toBe(0);
  });

  it("rejects empty resolution, missing assets and cancelled loads", async () => {
    await expect(loadAnimalBake({ resolve: async () => [] }, "missing.animal")).rejects.toThrow(
      "TN_ANIMAL_LOAD",
    );
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    await expect(
      loadAnimalBake({ resolve: async () => ["/missing"] }, "missing.animal"),
    ).rejects.toThrow("HTTP 404");
    const controller = new AbortController();
    vi.stubGlobal("fetch", async () => {
      controller.abort();
      return new Response(encodeFixture());
    });
    await expect(
      loadAnimalBake({ resolve: async () => ["/wolf"] }, "wolf.animal", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("TN_ANIMAL_ABORTED");
    expect(allocated.geometries).toBe(0);
  });
});

it("rejects a deeply nested hostile header with a named limit before allocation", () => {
  const source = encodeFixture();
  const sourceView = new DataView(source);
  const originalBytes = sourceView.getUint32(8, true);
  const originalStart = Math.ceil((12 + originalBytes) / 8) * 8;
  const text = new TextDecoder().decode(new Uint8Array(source, 12, originalBytes)).trimEnd();
  const header = new TextEncoder().encode(
    `${text.slice(0, -1)},"deep":${"[".repeat(12000)}0${"]".repeat(12000)}}`,
  );
  const headerBytes = Math.ceil(header.length / 8) * 8;
  const start = Math.ceil((12 + headerBytes) / 8) * 8;
  const bytes = new Uint8Array(start + source.byteLength - originalStart);
  bytes.set(new Uint8Array(source, 0, 12));
  new DataView(bytes.buffer).setUint32(8, headerBytes, true);
  bytes.fill(32, 12, 12 + headerBytes);
  bytes.set(header, 12);
  bytes.set(new Uint8Array(source, originalStart), start);
  expect(() => createAnimalGeometry(bytes.buffer)).toThrow("TN_ANIMAL_LIMIT");
  expect(allocated.geometries).toBe(0);
});
