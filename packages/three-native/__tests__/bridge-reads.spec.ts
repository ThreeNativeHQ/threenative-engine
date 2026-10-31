/**
 * PRD-748: game code that looks free in plain three.js pays a JS-to-Wasm crossing per read on the web
 * engine. The shooter's backlight read the key light's intensity 454 times and its colour 227 times a
 * frame, and core's AutoBatch read `scene.children` every frame. The back end keeps those answers:
 * a setter-only property until its setter or a method on the object runs, an animated number also
 * until a mixer call, and `children`/`parent`/a whole walk until the engine's hierarchy counter moves.
 * What it cannot keep, the census frame names (`TN_BRIDGE_WARNING`).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BRIDGE_CENSUS_MARKER,
  BRIDGE_WARNING_MARKER,
  ENGINE_COST_KNOB,
  WARMUP_FRAMES,
  WINDOW_FRAMES,
} from "../src/bridge-meter.js";
import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import { loadCatalog } from "../src/catalog.js";

const REPO = process.cwd();
const catalog = loadCatalog(REPO);
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

/** The engine's hierarchy counter sits at this byte address, as Object3D::hierarchyVersionAddress. */
const HIERARCHY = 64;
/** The fake engine's one work total (`__engineCounters`), a matrix compose count. */
const COMPOSES = 72;

/** A scene-graph engine over plain maps; every get, set and call is logged, and a get costs 1 us of clock. */
function sceneRuntime(clock: { ms: number }) {
  const types = new Map<string, number>();
  const names = new Map<number, string>();
  const typeId = (name: string) => {
    if (!types.has(name)) {
      types.set(name, types.size + 1);
      names.set(types.size, name);
    }
    return types.get(name) as number;
  };
  const words = new Uint32Array(64);
  const heap = new Float64Array(4096);
  const values = new Map<string, Map<string, EngineValue>>();
  const children = new Map<string, IEngineRef[]>();
  const parents = new Map<string, IEngineRef | null>();
  const calls: string[] = [];
  let next = 0;
  const make = (name: string): IEngineRef => {
    next += 1;
    const ref = { key: `${name}:${next}`, type: typeId(name) };
    heap[next * 4] = 1; // a Layers mask, and a visible flag byte below
    values.set(ref.key, new Map());
    children.set(ref.key, []);
    parents.set(ref.key, null);
    return ref;
  };
  const detach = (child: IEngineRef) => {
    const parent = parents.get(child.key);
    if (parent)
      children.set(
        parent.key,
        (children.get(parent.key) ?? []).filter((c) => c.key !== child.key),
      );
    parents.set(child.key, null);
  };
  const walk = (ref: IEngineRef): IEngineRef[] => [
    ref,
    ...(children.get(ref.key) ?? []).flatMap(walk),
  ];
  const runtime: IBrowserRuntime = {
    typeId,
    construct(name, args) {
      calls.push(`construct ${name}`);
      const ref = make(name);
      if (name.endsWith("Light") && typeof args[1] === "number")
        values.get(ref.key)?.set("intensity", args[1]);
      return ref;
    },
    invoke(self, method, args) {
      calls.push(`call ${names.get(self.type)}.${method}`);
      if (method === "add") {
        const child = args[0] as IEngineRef;
        detach(child);
        parents.set(child.key, self);
        children.get(self.key)?.push(child);
        words[HIERARCHY / 4] = (words[HIERARCHY / 4] ?? 0) + 1;
      }
      if (method === "remove") {
        detach(args[0] as IEngineRef);
        words[HIERARCHY / 4] = (words[HIERARCHY / 4] ?? 0) + 1;
      }
      if (method === "__walk") return walk(self);
      if (method === "clipAction") return make("AnimationAction");
      if (method === "isScheduled") return true;
      if (method === "computeBoundingSphere")
        values.get(self.key)?.set("boundingSphere", make("Sphere"));
      if (method === "update")
        for (const props of values.values()) if (props.has("intensity")) props.set("intensity", 7);
      if (method === "test") return true;
      if (method === "intersectObject") return [];
      return null;
    },
    get(self, property) {
      clock.ms += 0.001;
      if (property === "__address") return Number(self.key.split(":")[1]) * 32;
      if (property === "__hierarchy") return HIERARCHY;
      if (property === "__engineCounters") return `matrixEvaluations@${COMPOSES}`;
      calls.push(`get ${names.get(self.type)}.${property}`);
      if (property === "children") return [...(children.get(self.key) ?? [])];
      if (property === "parent") return parents.get(self.key) ?? null;
      // Object3D::subtreeVersion: the process counter at the last add, remove or attach at or under it.
      if (property === "__hierarchyRevision") return words[HIERARCHY / 4] ?? 0;
      if (property === "boundingSphere") return values.get(self.key)?.get(property) ?? null;
      if (property === "layers") {
        const layers = make("Layers");
        return layers;
      }
      return values.get(self.key)?.get(property) ?? (property === "name" ? "" : 1);
    },
    set(self, property, value) {
      calls.push(`set ${names.get(self.type)}.${property}`);
      values.get(self.key)?.set(property, value);
    },
    release() {},
    setCallback() {},
    readDoubles: (address) => heap[address / 8] as number,
    readByte: () => 1,
    readWord: (address) => words[address / 4] as number,
  };
  const count = (call: string) => calls.filter((c) => c === call).length;
  return { runtime, calls, count, words };
}

/** Object3D's engine-internal subtree version, read as core's camera pass reads it. */
const revisionOf = (object: object): number | undefined =>
  (object as { __hierarchyRevision?: number }).__hierarchyRevision;

interface ILight {
  intensity: number;
  parent: object | null;
  children: object[];
  layers: { test(other: unknown): boolean };
  add(child: object): unknown;
  remove(child: object): unknown;
  traverse(callback: (object: object) => void): void;
}

function scene(clock = { ms: 0 }) {
  const engine = sceneRuntime(clock);
  const browser = defineBrowserClasses(registry, engine.runtime, catalog);
  const Light = browser.classes.DirectionalLight as unknown as new (
    color: number,
    intensity: number,
  ) => ILight;
  const Group = browser.classes.Group as unknown as new () => ILight;
  const Mixer = browser.classes.AnimationMixer as unknown as new (
    root: object,
  ) => {
    update(dt: number): unknown;
    stopAllAction(): unknown;
    clipAction(clip: string): {
      isScheduled(): boolean;
      stop(): unknown;
      setEffectiveWeight(w: number): unknown;
    };
  };
  const Geometry = browser.classes.BufferGeometry as unknown as new () => {
    boundingSphere: object | null;
    computeBoundingSphere(): void;
  };
  return { ...engine, ...browser, Light, Group, Mixer, Geometry };
}

const host = globalThis as {
  __THREENATIVE_BRIDGE_CACHE__?: unknown;
  __tnPlaytestObserving?: number;
  __THREENATIVE_ENGINE_COST__?: unknown;
};

afterEach(() => {
  host.__THREENATIVE_BRIDGE_CACHE__ = undefined;
  host[ENGINE_COST_KNOB as "__THREENATIVE_ENGINE_COST__"] = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("bridge reads the back end keeps", () => {
  it("reads a light's intensity once however many callbacks ask, until its setter runs", () => {
    const { Light, count } = scene();
    const key = new Light(0xffffff, 3);
    for (let read = 0; read < 500; read++) expect(key.intensity).toBe(3);
    expect(count("get DirectionalLight.intensity")).toBe(1);
    key.intensity = 5;
    expect(key.intensity).toBe(5);
    expect(count("get DirectionalLight.intensity")).toBe(2);
  });

  it("drops an animated number at a mixer call, which writes it in the engine", () => {
    const { Light, Group, Mixer, count } = scene();
    const root = new Group();
    const key = new Light(0xffffff, 3);
    root.add(key);
    const mixer = new Mixer(root);
    expect(key.intensity).toBe(3);
    mixer.update(0.016);
    expect(key.intensity).toBe(7);
    expect(count("get DirectionalLight.intensity")).toBe(2);
  });

  it("keeps children, parent and a whole walk until the hierarchy counter moves", () => {
    const { Light, Group, count } = scene();
    const root = new Group();
    const key = new Light(0xffffff, 1);
    root.add(key);
    const first = root.children;
    for (let read = 0; read < 100; read++) {
      expect(root.children).toBe(first);
      expect(key.parent).toBe(root);
      root.traverse(() => {});
    }
    expect(first).toEqual([key]);
    expect(count("get Group.children")).toBe(1);
    expect(count("get DirectionalLight.parent")).toBe(1);
    expect(count("call Group.__walk")).toBe(1);
    const other = new Group();
    other.add(key);
    expect(root.children).toEqual([]);
    expect(other.children[0]).toBe(key);
    expect(key.parent).toBe(other);
    const seen: object[] = [];
    other.traverse((object) => seen.push(object));
    expect(seen).toEqual([other, key]);
  });

  it("keeps a hierarchy revision until the engine's hierarchy counter moves", () => {
    const { Light, Group, count } = scene();
    const root = new Group();
    const key = new Light(0xffffff, 1);
    root.add(key);
    // Core's camera pass reads this for every rate root every frame to decide whether its rig index
    // still describes the engine's graph (stress lab: 120 crossings a frame).
    const first = revisionOf(root);
    for (let read = 0; read < 100; read++) expect(revisionOf(root)).toBe(first);
    expect(count("get Group.__hierarchyRevision")).toBe(1);
    // Its only writer stamps the same process-wide counter every add, remove and attach moves.
    const other = new Group();
    other.add(key);
    expect(revisionOf(root)).not.toBe(first);
    expect(revisionOf(other)).toBe(revisionOf(root));
    expect(count("get Group.__hierarchyRevision")).toBe(3);
  });

  it("asks an action whether it is scheduled once, until its own play/stop or a mixer-wide call", () => {
    const { Group, Mixer, count } = scene();
    const mixer = new Mixer(new Group());
    const action = mixer.clipAction("walk");
    const other = mixer.clipAction("run");
    for (let step = 0; step < 50; step++) {
      expect(action.isScheduled()).toBe(true);
      other.setEffectiveWeight(0.5);
      mixer.clipAction("walk");
      mixer.update(0.016);
    }
    expect(count("call AnimationAction.isScheduled")).toBe(1);
    action.stop();
    action.isScheduled();
    expect(count("call AnimationAction.isScheduled")).toBe(2);
    mixer.stopAllAction();
    action.isScheduled();
    expect(count("call AnimationAction.isScheduled")).toBe(3);
  });

  it("reads an action's timeScale, paused, time and weight and the mixer's timeScale in place, no crossing", () => {
    const { Group, Mixer, count } = scene();
    const mixer = new Mixer(new Group()) as unknown as {
      timeScale: number;
      clipAction(clip: string): object;
    };
    const action = mixer.clipAction("walk") as {
      timeScale: number;
      paused: boolean;
      time: number;
      weight: number;
    };
    // An AnimationPlayer reads these on every action every frame.
    for (let frame = 0; frame < 200; frame++) {
      void action.timeScale;
      void action.paused;
      void action.time;
      void action.weight;
      void mixer.timeScale;
    }
    for (const property of ["timeScale", "paused", "time", "weight"])
      expect(count(`get AnimationAction.${property}`)).toBe(0);
    expect(count("get AnimationMixer.timeScale")).toBe(0);
  });

  it("keeps the labels through a transform-only method, a setter of another property and a same-value write", () => {
    const { Light, Group, count } = scene();
    const key = new Light(0xffffff, 3) as ILight & {
      renderOrder: number;
      lookAt(x: number, y: number, z: number): void;
      copy(other: object): unknown;
    };
    expect(key.intensity).toBe(3);
    for (let frame = 0; frame < 20; frame++) {
      key.lookAt(0, 0, frame);
      expect(key.renderOrder).toBe(1);
      key.intensity = 3;
    }
    expect(count("get DirectionalLight.renderOrder")).toBe(1);
    expect(count("set DirectionalLight.intensity")).toBe(0);
    key.intensity = 4;
    expect(key.renderOrder).toBe(1);
    expect(count("get DirectionalLight.renderOrder")).toBe(1);
    key.copy(new Group());
    void key.renderOrder;
    expect(count("get DirectionalLight.renderOrder")).toBe(2);
  });

  it("keeps a geometry's bound once present, never a missing one", () => {
    const { Geometry, count } = scene();
    const geometry = new Geometry();
    expect(geometry.boundingSphere).toBeNull();
    expect(geometry.boundingSphere).toBeNull();
    expect(count("get BufferGeometry.boundingSphere")).toBe(2);
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    for (let read = 0; read < 50; read++) expect(geometry.boundingSphere).toBe(sphere);
    expect(count("get BufferGeometry.boundingSphere")).toBe(3);
  });

  it("tests two layer masks in JS, with no call", () => {
    const { Light, Group, count } = scene();
    const key = new Light(0xffffff, 1);
    const camera = new Group();
    for (let read = 0; read < 50; read++) expect(key.layers.test(camera.layers)).toBe(true);
    expect(count("call Layers.test")).toBe(0);
  });

  it("crosses for every read with the knob off, the A/B arm", () => {
    host.__THREENATIVE_BRIDGE_CACHE__ = false;
    const { Light, Group, count, collect } = scene();
    collect();
    const root = new Group();
    const key = new Light(0xffffff, 3);
    root.add(key);
    for (let read = 0; read < 10; read++) {
      void key.intensity;
      void root.children;
      void key.parent;
    }
    expect(count("get DirectionalLight.intensity")).toBe(10);
    expect(count("get Group.children")).toBe(10);
    expect(count("get DirectionalLight.parent")).toBe(10);
  });
});

describe("the bridge census", () => {
  /** Runs frames that each read the key light's intensity `reads` times; the clock moves 16 ms a frame. */
  function frames(reads: number, observer = false) {
    const clock = { ms: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    const { Light, collect } = scene(clock);
    const key = new Light(0xffffff, 3);
    const validateControls = () => {
      if (observer) host.__tnPlaytestObserving = 1;
      for (let read = 0; read < reads; read++) if (!(key.intensity >= 0)) throw new Error("bad");
      if (observer) host.__tnPlaytestObserving = 0;
    };
    for (let frame = 0; frame < WARMUP_FRAMES + WINDOW_FRAMES * 2; frame++) {
      collect();
      validateControls();
      clock.ms += 16;
    }
    return warnings.filter((line) => line.startsWith(BRIDGE_WARNING_MARKER));
  }

  it("names the redundant read and its caller when the cache cannot keep it", () => {
    host.__THREENATIVE_BRIDGE_CACHE__ = false;
    const warnings = frames(500);
    expect(warnings.length).toBeGreaterThan(0);
    const verdict = JSON.parse((warnings[0] as string).slice(BRIDGE_WARNING_MARKER.length + 1)) as {
      top: { name: string; redundant: number; caller: string }[];
      share: number;
    };
    expect(verdict.top[0]?.name).toBe("get DirectionalLight.intensity");
    expect(verdict.top[0]?.redundant).toBe(499);
    expect(verdict.top[0]?.caller).toContain("validateControls");
    expect(verdict.share).toBeGreaterThan(1 / 50);
  });

  it("stays silent on the same frames with the cache on", () => {
    expect(frames(500)).toEqual([]);
  });

  it("leaves the playtest observer's reads out, which no player run makes", () => {
    // Hosted CI's adventure `puzzle` run failed on 45,920 redundant reads, led by the playtest
    // sample's own scene walk (countMaterials, Box3.setFromObject) inside the census frame.
    host.__THREENATIVE_BRIDGE_CACHE__ = false;
    expect(frames(500, true)).toEqual([]);
  });
});

describe("ray tests", () => {
  it("asks the engine for hits only on objects that can have any, as three's empty Object3D.raycast", () => {
    // The platformer's picker raycast each Group and Bone of its targets: 309 crossings a frame that
    // answered nothing (2026-10-27 census). The engine raycasts a Mesh (and its kinds) and a LOD only.
    const { classes, count } = scene();
    const caster = new (classes.Raycaster as unknown as new () => object)();
    const hits: unknown[] = [];
    const cast = (names: readonly string[]) => {
      for (const name of names) {
        const object = new (
          classes[name] as unknown as new () => {
            raycast(raycaster: object, intersects: unknown[]): void;
          }
        )();
        object.raycast(caster, hits);
      }
    };
    cast([
      "Object3D",
      "Group",
      "Scene",
      "Bone",
      "PerspectiveCamera",
      "DirectionalLight",
      "PointLight",
    ]);
    expect(count("call Raycaster.intersectObject")).toBe(0);
    cast([
      "Mesh",
      "SkinnedMesh",
      "InstancedMesh",
      "BatchedMesh",
      "Line",
      "LineSegments",
      "Sprite",
      "LOD",
    ]);
    expect(count("call Raycaster.intersectObject")).toBe(8);
    expect(hits).toEqual([]);
  });
});

describe("the engine cost totals", () => {
  it("answers children reads, walk visits, hierarchy moves and the engine's own totals, read in place", () => {
    const { Light, Group, counters, words, count } = scene();
    const root = new Group();
    const key = new Light(0xffffff, 1);
    root.add(key);
    words[COMPOSES / 4] = 9_000;
    const before = counters();
    for (let read = 0; read < 50; read++) void root.children;
    root.traverse(() => {});
    root.remove(key);
    root.add(key);
    words[COMPOSES / 4] = 9_040;
    const after = counters();
    const delta = (name: string) => (after[name] ?? Number.NaN) - (before[name] ?? Number.NaN);
    expect(delta("childrenReads")).toBe(50);
    // A kept walk answers its nodes without a visit; the first walk after a move visits both.
    expect(delta("walkVisits")).toBe(2);
    expect(delta("hierarchyMoves")).toBe(2);
    expect(delta("matrixEvaluations")).toBe(40);
    // Reading them costs no crossing: the totals are JS counts and words read in place.
    const crossed = count("get Group.__engineCounters");
    counters();
    expect(count("get Group.__engineCounters")).toBe(crossed);
  });

  it("prints each census with its top crossings and callers only when a playtest asks", () => {
    const run = (asked: boolean) => {
      host[ENGINE_COST_KNOB as "__THREENATIVE_ENGINE_COST__"] = asked;
      host.__THREENATIVE_BRIDGE_CACHE__ = false;
      const clock = { ms: 0 };
      vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
      const lines: string[] = [];
      vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      const { Light, collect } = scene(clock);
      const key = new Light(0xffffff, 3);
      const readTwice = () => key.intensity + key.intensity;
      for (let frame = 0; frame < WARMUP_FRAMES + WINDOW_FRAMES * 2; frame++) {
        collect();
        readTwice();
        clock.ms += 16;
      }
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      return lines.filter((line) => line.startsWith(BRIDGE_CENSUS_MARKER));
    };
    expect(run(false)).toEqual([]);
    const [line] = run(true);
    const census = JSON.parse((line as string).slice(BRIDGE_CENSUS_MARKER.length + 1)) as {
      crossings: number;
      top: { name: string; perFrame: number; caller: string }[];
    };
    expect(census.crossings).toBe(2);
    expect(census.top[0]).toMatchObject({ name: "get DirectionalLight.intensity", perFrame: 2 });
    expect(census.top[0]?.caller).toContain("readTwice");
  });
});

describe("debug hierarchy counter producer", () => {
  it("converts native elapsed microseconds to monotonic milliseconds across a low-word rollover", () => {
    vi.stubEnv("TN_DEBUG", "1");
    const engine = sceneRuntime({ ms: 0 });
    const get = engine.runtime.get;
    engine.runtime.get = (self, property) =>
      property === "__engineCounters" ? "pipelineCompileMicros@80" : get(self, property);
    const browser = defineBrowserClasses(registry, engine.runtime, catalog);
    const Group = browser.classes.Group as new () => object;
    new Group();
    engine.words[20] = 0xffffffff;
    const before = browser.counters().pipelineCompileMs;
    engine.words[20] = 1;
    engine.words[21] = 1;
    expect(browser.counters().pipelineCompileMs).toBeCloseTo((before ?? 0) + 0.002, 6);
    expect(browser.counters()).not.toHaveProperty("pipelineCompileMicros");
  });

  it("reads full debug byte totals coherently when the high word changes during a read", () => {
    vi.stubEnv("TN_DEBUG", "1");
    const engine = sceneRuntime({ ms: 0 });
    const get = engine.runtime.get;
    engine.runtime.get = (self, property) =>
      property === "__engineCounters" ? "bufferUploadBytes@80" : get(self, property);
    let highReads = 0;
    const readWord = engine.runtime.readWord;
    engine.runtime.readWord = (address) => {
      if (address === 84) return highReads++ === 0 ? 0 : 1;
      if (address === 80) return highReads === 1 ? 0xffffffff : 1;
      return readWord?.(address) ?? 0;
    };
    const browser = defineBrowserClasses(registry, engine.runtime, catalog);
    const Group = browser.classes.Group as new () => object;
    new Group();
    expect(browser.counters().bufferUploadBytes).toBe(0x100000001);
    expect(highReads).toBe(4);
  });

  it("keeps off counter reads on the original low-word census", () => {
    vi.stubEnv("TN_DEBUG", "0");
    const engine = sceneRuntime({ ms: 0 });
    const read = vi.spyOn(engine.runtime, "readWord");
    const browser = defineBrowserClasses(registry, engine.runtime, catalog);
    const Group = browser.classes.Group as new () => object;
    new Group();
    read.mockClear();
    browser.counters();
    expect(read.mock.calls).toEqual([[HIERARCHY], [COMPOSES]]);
  });

  it("enables native totals once and retains repeated hierarchy reads and wrapper population", () => {
    vi.stubEnv("TN_DEBUG", "1");
    const graph = scene();
    const root = new graph.Group();
    const child = new graph.Group();
    root.add(child);
    const first = root.children;
    expect(root.children).toBe(first);
    root.traverse(() => {});
    root.traverse(() => {});
    const totals = graph.counters();
    expect(graph.count("set Group.__debugTelemetry")).toBe(1);
    expect(totals).toMatchObject({
      childrenReads: 2,
      walkVisits: 2,
      bridgeWrappersCreated: 2,
      bridgeLiveWrappers: 2,
      hierarchyMoves: 1,
    });
    expect(totals.bridgeWrapRequests).toBeGreaterThan(0);
    expect(totals.bridgeGetCrossings).toBeGreaterThan(0);
  });
});
