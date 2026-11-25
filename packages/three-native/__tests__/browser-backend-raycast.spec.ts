/**
 * Hot-path calls that cross once and make no engine wrappers: a ray's flat hits
 * (`Raycaster.__tnIntersectObject(s)`) decode into JS vectors, and GroundSnap's and Billboard3D's
 * per-frame Object3D hooks skip the generic wrapper's bookkeeping.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
  engineRef,
} from "../src/browser-backend.js";

const shipped = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "packages", "three-native", "api", "native-registry.json"),
    "utf8",
  ),
) as IRegistryDump;

/** The shipped registry with the flat-hit methods on Raycaster, as the engine binding adds them. */
function registryWithFlatHits(flat: boolean): IRegistryDump {
  const raycaster = shipped.classes.Raycaster;
  if (raycaster === undefined) throw new Error("registry has no Raycaster");
  const baseMethods = raycaster.methods.filter(
    (method) => method !== "__tnIntersectObject" && method !== "__tnIntersectObjects",
  );
  const methods = flat
    ? [...baseMethods, "__tnIntersectObject", "__tnIntersectObjects"]
    : baseMethods;
  return { classes: { ...shipped.classes, Raycaster: { ...raycaster, methods } } };
}

interface ICall {
  self: IEngineRef;
  method: string;
  args: readonly EngineValue[];
}

function recordingRuntime(answer: (call: ICall) => EngineValue) {
  const names = [...Object.keys(shipped.classes)];
  const typeId = (name: string) => names.indexOf(name) + 1;
  const calls: ICall[] = [];
  const constructed: string[] = [];
  let next = 0;
  const runtime: IBrowserRuntime = {
    typeId,
    construct(name) {
      constructed.push(name);
      next += 1;
      return { key: `${name}:${next}`, type: typeId(name) };
    },
    invoke(self, method, args) {
      const call = { self, method, args };
      calls.push(call);
      return answer(call);
    },
    get(_self, property) {
      if (property === "__address") return 64;
      if (property === "__hierarchy") return 0;
      if (property === "__engineCounters") return "";
      return null;
    },
    set: () => undefined,
    release: () => undefined,
    setCallback: () => undefined,
    readDoubles: () => 0,
    readByte: () => 1,
    readWord: () => 1,
  };
  return { runtime, calls, constructed, typeId };
}

type Ctor = new (...args: unknown[]) => object;
interface IRaycaster {
  intersectObject(object: object, recursive?: boolean, target?: unknown): IHit[];
  intersectObjects(objects: object[], recursive?: boolean, target?: unknown): IHit[];
}
interface IHit {
  distance: number;
  [key: string]: unknown;
}

describe("Raycaster flat hits", () => {
  const setup = (flat: boolean) => {
    const held: { ref?: IEngineRef } = {};
    const meshHit = (extra: Record<string, EngineValue>): EngineValue => ({
      distance: 2,
      point: [1, 2, 3],
      object: held.ref ?? null,
      faceIndex: 4,
      face: { a: 0, b: 1, c: 2, normal: [0, 1, 0], materialIndex: 0 },
      barycoord: [0.2, 0.3, 0.5],
      ...extra,
    });
    const lineHit: EngineValue = {
      distance: 1,
      point: [4, 5, 6],
      index: 7,
      face: null,
      faceIndex: null,
      barycoord: null,
      object: null,
    };
    const { runtime, calls, constructed } = recordingRuntime(({ method }) => {
      if (method === "__tnIntersectObject")
        return [meshHit({ uv: [0.5, 0.25], uv1: [1, 0], normal: [0, 0, 1], instanceId: 3 })];
      if (method === "__tnIntersectObjects") return [meshHit({}), lineHit];
      return null;
    });
    const engine = defineBrowserClasses(registryWithFlatHits(flat), runtime);
    const { Raycaster, Mesh, Vector2, Vector3 } = engine.classes as Record<string, Ctor>;
    const raycaster = new (Raycaster as Ctor)() as unknown as IRaycaster;
    const mesh = new (Mesh as Ctor)();
    held.ref = engineRef(mesh);
    constructed.length = 0;
    calls.length = 0;
    return {
      raycaster,
      mesh,
      calls,
      constructed,
      Vector2: Vector2 as Ctor,
      Vector3: Vector3 as Ctor,
    };
  };

  it("decodes intersectObject's flat hit into JS vectors with one crossing and no wrappers", () => {
    const { raycaster, mesh, calls, constructed, Vector2, Vector3 } = setup(true);
    const [hit] = raycaster.intersectObject(mesh, false);
    expect(calls.map((call) => call.method)).toEqual(["__tnIntersectObject"]);
    expect(calls[0]?.args).toEqual([engineRef(mesh), false]);
    expect(constructed).toEqual([]);
    expect(hit?.object).toBe(mesh);
    expect(hit?.point).toBeInstanceOf(Vector3);
    expect(hit?.point).toMatchObject({ x: 1, y: 2, z: 3 });
    expect(hit?.barycoord).toMatchObject({ x: 0.2, y: 0.3, z: 0.5 });
    expect(hit?.normal).toBeInstanceOf(Vector3);
    expect(hit?.uv).toBeInstanceOf(Vector2);
    expect(hit?.uv).toMatchObject({ x: 0.5, y: 0.25 });
    expect(hit?.uv1).toMatchObject({ x: 1, y: 0 });
    expect(hit?.instanceId).toBe(3);
    const face = hit?.face as { normal: unknown };
    expect(face).toMatchObject({ a: 0, b: 1, c: 2, materialIndex: 0 });
    expect(face.normal).toBeInstanceOf(Vector3);
    expect(face.normal).toMatchObject({ x: 0, y: 1, z: 0 });
    // Reading the decoded vectors crosses nothing.
    expect(calls).toHaveLength(1);
  });

  it("keeps a mesh hit without optional fields and a line hit's nulls, and sorts into a target", () => {
    const { raycaster, mesh, calls, constructed } = setup(true);
    const target: IHit[] = [{ distance: 1.5 }];
    const result = raycaster.intersectObjects([mesh], true, target);
    expect(calls.map((call) => call.method)).toEqual(["__tnIntersectObjects"]);
    expect(calls[0]?.args).toHaveLength(2);
    expect(constructed).toEqual([]);
    expect(result).toBe(target);
    expect(result.map((hit) => hit.distance)).toEqual([1, 1.5, 2]);
    const [line, , meshHit] = result;
    expect(line).toMatchObject({ index: 7, face: null, faceIndex: null, barycoord: null });
    expect(line?.point).toMatchObject({ x: 4, y: 5, z: 6 });
    expect(meshHit && Object.keys(meshHit)).toEqual([
      "distance",
      "point",
      "object",
      "faceIndex",
      "face",
      "barycoord",
    ]);
    expect(() => raycaster.intersectObjects([mesh], true, {})).toThrow(TypeError);
  });

  it("keeps the engine's intersectObject when the flat method is not bound", () => {
    const { raycaster, mesh, calls } = setup(false);
    raycaster.intersectObject(mesh, false);
    expect(calls.map((call) => call.method)).toEqual(["intersectObject"]);
  });
});

describe("Object3D per-frame hooks", () => {
  const setup = () => {
    const { runtime, calls, typeId } = recordingRuntime(({ self, method }) => {
      if (method === "__tnGroundSnapApply") return 0.25;
      if (method === "__tnBillboardFace") return self; // chain(): the receiver
      return null;
    });
    const engine = defineBrowserClasses(shipped, runtime);
    const { Group, Mesh, PerspectiveCamera } = engine.classes as Record<string, Ctor>;
    const model = new (Mesh as Ctor)() as Record<string, (...args: unknown[]) => unknown>;
    const group = new (Group as Ctor)();
    const camera = new (PerspectiveCamera as Ctor)();
    calls.length = 0;
    return { model, group, camera, calls, typeId };
  };

  it("crosses once with the engine object and scalars and returns the engine's number", () => {
    const { model, group, calls } = setup();
    expect(model.__tnGroundSnapApply?.(group, 1, 0.016, -1, true, 0.1)).toBe(0.25);
    expect(calls).toEqual([
      {
        self: engineRef(model),
        method: "__tnGroundSnapApply",
        args: [engineRef(group), 1, 0.016, -1, true, 0.1],
      },
    ]);
  });

  it("returns the receiver for the chained billboard call", () => {
    const { model, camera, calls } = setup();
    expect(model.__tnBillboardFace?.(camera, 2)).toBe(model);
    expect(model.__tnBillboardFace?.(camera)).toBe(model);
    expect(calls.map((call) => call.args)).toEqual([[engineRef(camera), 2], [engineRef(camera)]]);
  });

  it("takes the generic path for an argument that is not an engine object", () => {
    const { model, calls } = setup();
    model.__tnBillboardFace?.(null, 0);
    expect(calls.map((call) => call.args)).toEqual([[null, 0]]);
  });
});
