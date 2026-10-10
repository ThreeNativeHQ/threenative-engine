import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { INativePhysicsHost } from "../../physics/src/native/host.js";

function resident() {
  const heap = new ArrayBuffer(64 * 1024);
  const view = new DataView(heap);
  let top = 8;
  const free = vi.fn();
  const physicsCall = vi.fn(
    (
      op: number,
      _world: number,
      _packet: number,
      _input: number,
      _count: number,
      output: number,
    ): number => {
      if (op === 0) return 512;
      if (op === 5) {
        [7, 1, 2, 3, 0, 0, 0, 1].forEach((value, i) =>
          view.setFloat32(output + i * 4, value, true),
        );
        return 1;
      }
      if (op === 8) {
        view.setUint32(output, 3, true);
        view.setUint32(output + 4, 7, true);
        return 1;
      }
      return 1;
    },
  );
  const native = {
    alloc: vi.fn((bytes: number) => {
      const at = top;
      top += bytes;
      return at;
    }),
    free,
    physicsCopy: vi.fn(
      (
        values: Float32Array | Uint32Array | Float64Array,
        at: number,
        count: number,
        kind: number,
        toNative: boolean,
      ) => {
        for (let i = 0; i < count; i++) {
          if (toNative) {
            if (kind === 7) view.setFloat64(at + i * 8, values[i] as number, true);
            else if (kind === 5) view.setUint32(at + i * 4, values[i] as number, true);
            else view.setFloat32(at + i * 4, values[i] as number, true);
          } else
            values[i] =
              kind === 5 ? view.getUint32(at + i * 4, true) : view.getFloat32(at + i * 4, true);
        }
        return 0;
      },
    ),
    physicsCall,
    physicsVersion: () => "0.30.0",
  };
  const source = readFileSync(new URL("../src/perry-physics.ts", import.meta.url), "utf8");
  const exports = {} as { createPerryPhysicsHost(): INativePhysicsHost };
  runInNewContext(
    transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText,
    { exports, require: () => native, Float32Array, Uint32Array, Float64Array },
  );
  return { host: exports.createPerryPhysicsHost(), native, view };
}

describe("Perry physics packing", () => {
  it("packs body ids, unsigned groups, quaternions and CCD without float32 integer loss", () => {
    const { host, native, view } = resident();
    const simulation = host.createSimulation({ gravity: [1, -5, 2] });
    const packet = native.physicsCall.mock.calls[0]?.[2] as number;
    expect([0, 1, 2].map((i) => view.getFloat64(packet + i * 8, true))).toEqual([1, -5, 2]);
    expect(
      simulation.createBody({
        type: "dynamic",
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        mass: 4,
        collisionLayer: 0x80000001,
        collisionMask: 0xffffffff,
        sensor: false,
        continuousCollision: true,
        shape: {
          kind: "box",
          x: 2,
          y: 3,
          z: 4,
          collisionLayer: 1,
          collisionMask: 1,
          sensor: false,
        },
      }),
    ).toBe(0);
    expect(Array.from({ length: 18 }, (_, i) => view.getFloat64(packet + i * 8, true))).toEqual([
      0, 0, 0, 1, 2, 3, 0, 0, 0, 1, 2, 3, 4, 4, 0x80000001, 0xffffffff, 0, 1,
    ]);
  });

  it("crosses once per step with only the active input rows and reuses output scratch", () => {
    const { host, native, view } = resident();
    const simulation = host.createSimulation();
    const transforms = new Float32Array([7, 1, 2, 3, 0, 0, 0, 1, Number.NaN]);
    native.physicsCall.mockClear();
    simulation.step(1 / 60, { kinematicCount: 1, kinematicTransforms: transforms });
    expect(native.physicsCall).toHaveBeenCalledTimes(1);
    const call = native.physicsCall.mock.calls[0];
    expect(call?.[0]).toBe(4);
    expect(call?.[4]).toBe(1);
    expect(
      Array.from({ length: 8 }, (_, i) => view.getFloat32((call?.[3] as number) + i * 4, true)),
    ).toEqual([7, 1, 2, 3, 0, 0, 0, 1]);
    const output = new Float32Array(16).fill(99);
    expect(simulation.readVisibleTransforms(output)).toBe(1);
    expect([...output]).toEqual([7, 1, 2, 3, 0, 0, 0, 1, 99, 99, 99, 99, 99, 99, 99, 99]);
    const allocations = native.alloc.mock.calls.length;
    simulation.readVisibleTransforms(output);
    expect(native.alloc.mock.calls.length).toBe(allocations);
    const pairs = new Uint32Array(2);
    simulation.readAreaIntersections(pairs);
    expect([...pairs]).toEqual([3, 7]);
    simulation.dispose();
    const releases = native.free.mock.calls.length;
    simulation.dispose();
    expect(native.free.mock.calls.length).toBe(releases);
    expect(() => simulation.step(1 / 60)).toThrow("TN_PERRY_PHYSICS_DISPOSED");
    expect(simulation.createJoint).toBeUndefined();
  });

  it("copies complete contacts only and rejects mismatched buffer types", () => {
    const { host, native, view } = resident();
    const simulation = host.createSimulation();
    native.physicsCall.mockImplementation((op, _world, _packet, _input, _count, output) => {
      if (op === 20) {
        for (let i = 0; i < 8; i++) view.setFloat32(output + i * 4, i + 1, true);
        return 2;
      }
      return 1;
    });
    const output = new Float32Array(9).fill(99);
    expect(simulation.readContacts?.(0, new Uint32Array([1, 2]), output)).toBe(2);
    expect([...output]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 99]);
    expect(() =>
      simulation.readVisibleTransforms(new Uint32Array(8) as unknown as Float32Array),
    ).toThrow("output buffer type");
    expect(() =>
      simulation.readAreaIntersections(new Float32Array(2) as unknown as Uint32Array),
    ).toThrow("output buffer type");
    expect(() =>
      simulation.readContacts?.(0, new Float32Array(1) as unknown as Uint32Array, output),
    ).toThrow("contact candidates");
    native.physicsCall.mockReturnValue(0);
    expect(() => simulation.readVisibleTransforms(undefined as unknown as Float32Array)).toThrow(
      "output buffer type",
    );
  });

  it("rejects malformed input and preserves named actuation errors", () => {
    const { host, native } = resident();
    expect(() => host.createSimulation({ gravity: Number.POSITIVE_INFINITY })).toThrow(
      "TN_PERRY_PHYSICS_INVALID",
    );
    const simulation = host.createSimulation();
    expect(() => simulation.step(0)).toThrow("deltaTime");
    expect(() =>
      simulation.step(1 / 60, { kinematicCount: 2, kinematicTransforms: new Float32Array(8) }),
    ).toThrow("kinematic count");
    expect(() => simulation.removeBody(-1)).toThrow("invalid integer");
    native.physicsCall.mockReturnValue(0);
    expect(() => simulation.applyBodyImpulse?.(0, { x: 1, y: 0, z: 0 })).toThrow(
      "TN_PHYSICS_UNKNOWN_BODY",
    );
    native.physicsCall.mockReturnValue(-1);
    expect(() => simulation.applyBodyForce?.(0, { x: 1, y: 0, z: 0 })).toThrow(
      "TN_PHYSICS_NOT_DYNAMIC",
    );
    expect(() => simulation.readVisibleTransforms(new Float32Array(0))).toThrow(
      "TN_PERRY_PHYSICS_BUFFER_TOO_SMALL",
    );
  });
});
