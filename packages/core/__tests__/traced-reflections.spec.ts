import { BoxGeometry, Group, Mesh, MeshStandardMaterial, PlaneGeometry } from "three";
import { float, vec3 } from "three/tsl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TracedReflections } from "../src/render/traced-reflections.js";

function room(): Group {
  const group = new Group();
  const floor = new Mesh(new PlaneGeometry(10, 10), new MeshStandardMaterial({ roughness: 0.8 }));
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ metalness: 1 })));
  group.updateMatrixWorld(true);
  return group;
}

afterEach(() => vi.restoreAllMocks());

describe("TracedReflections", () => {
  it("packs the scene's triangles and reports them once, as TN_TRACED_REFLECTIONS", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const traced = new TracedReflections(room());
    expect(traced.report.triangles).toBe(14);
    expect(traced.report.bytes).toBeGreaterThan(0);
    const lines = info.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.startsWith("TN_TRACED_REFLECTIONS "))).toHaveLength(1);
    expect(lines[0]).toContain('"triangles":14');
    traced.dispose();
  });

  it("stays silent when the marker is switched off, and still reports", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const traced = new TracedReflections(room(), { marker: false });
    expect(info).not.toHaveBeenCalled();
    expect(traced.report.triangles).toBe(14);
    traced.dispose();
  });

  it("defaults to Unreal's cut-off of 0.4 with a fade of 0.1, and keeps the game's own", () => {
    const standard = new TracedReflections(room(), { marker: false });
    expect([standard.maxRoughnessToTrace, standard.roughnessFadeLength]).toEqual([0.4, 0.1]);
    const own = new TracedReflections(room(), {
      marker: false,
      maxRoughnessToTrace: 0.6,
      roughnessFadeLength: 0.2,
    });
    expect([own.maxRoughnessToTrace, own.roughnessFadeLength]).toEqual([0.6, 0.2]);
  });

  it("refuses a limit that cannot mean what it says", () => {
    const build = (options: ConstructorParameters<typeof TracedReflections>[1]) => () =>
      new TracedReflections(room(), { marker: false, ...options });
    expect(build({ maxRoughnessToTrace: 0 })).toThrow(/TN_TRACED_REFLECTIONS: maxRoughnessToTrace/);
    expect(build({ maxRoughnessToTrace: 1.2 })).toThrow(/maxRoughnessToTrace/);
    expect(build({ roughnessFadeLength: -0.1 })).toThrow(
      /TN_TRACED_REFLECTIONS: roughnessFadeLength/,
    );
    expect(build({ maxRoughnessToTrace: 0.3, roughnessFadeLength: 0.4 })).toThrow(
      /roughnessFadeLength/,
    );
    expect(build({ maxSteps: 0 })).toThrow(/TN_TRACED_REFLECTIONS: maxSteps/);
    expect(build({ maxSteps: 2.5 })).toThrow(/maxSteps/);
  });

  it("walks as many nodes as the tree has, up to 2048, unless the game names a budget", () => {
    // A walk visits each node at most once, so a budget of the node count never cuts a ray short. A budget of 192
    // did: a ray along a capsule's wall crosses more boxes than that and reported the far wall.
    const small = new TracedReflections(room(), { marker: false });
    expect(small.report.nodes).toBeLessThan(192);
    expect(small.maxSteps).toBe(small.report.nodes);
    const dense = new Group();
    dense.add(new Mesh(new PlaneGeometry(1, 1, 64, 64), new MeshStandardMaterial()));
    dense.updateMatrixWorld(true);
    const large = new TracedReflections(dense, { marker: false });
    expect(large.report.nodes).toBeGreaterThan(2048);
    expect(large.maxSteps).toBe(2048);
    expect(new TracedReflections(dense, { marker: false, maxSteps: 64 }).maxSteps).toBe(64);
  });

  it("traces a surface at roughness 0.4 or less, and a rougher one casts no ray", () => {
    const traced = new TracedReflections(room(), { marker: false });
    expect(traced.weightAt(0)).toBe(1);
    expect(traced.weightAt(0.3)).toBe(1);
    expect(traced.weightAt(0.35)).toBeCloseTo(0.5, 6);
    expect(traced.weightAt(0.4)).toBe(0);
    expect(traced.weightAt(0.41)).toBe(0);
    expect(traced.weightAt(0.8)).toBe(0);
    // Unreal's fade is a smoothstep: it eases out of 1 (0.2 of the way in: 1 - 0.104) and into 0.
    expect(traced.weightAt(0.32)).toBeCloseTo(0.896, 3);
    expect(traced.weightAt(0.38)).toBeCloseTo(0.104, 3);
  });

  it("routes a rougher surface to the radiance cache, and past 0.8 to the diffuse GI (Unreal's max-roughness-to-trace rule)", () => {
    const traced = new TracedReflections(room(), { marker: false });
    expect([traced.maxRoughnessToEvaluateRoughSpecular, traced.roughSpecularFadeLength]).toEqual([
      0.8, 0.2,
    ]);
    // Smooth: the ray answers. Indoors at 0.6 the radiance cache answers, not the sky. At 0.8 and above: the diffuse GI.
    expect(traced.routeAt(0.2)).toEqual({ traced: 1, roughSpecular: 0, diffuse: 0 });
    expect(traced.routeAt(0.6).roughSpecular).toBeCloseTo(1, 9);
    expect(traced.routeAt(0.8).diffuse).toBeCloseTo(1, 9);
    expect(traced.routeAt(1).diffuse).toBe(1);
    expect(traced.routeAt(1).traced + traced.routeAt(1).roughSpecular).toBe(0);
    // The diffuse share rises over the 0.2 below the limit, as Unreal's RoughReflectionsDiffuseLerp does.
    expect(traced.routeAt(0.7).diffuse).toBeCloseTo(0.5, 6);
    expect(traced.routeAt(0.7).roughSpecular).toBeCloseTo(0.5, 6);
    // Across the trace fade the three shares still add to one, so no roughness is brighter or darker than its neighbours.
    for (let roughness = 0; roughness <= 1; roughness += 0.05) {
      const route = traced.routeAt(roughness);
      expect(route.traced + route.roughSpecular + route.diffuse).toBeCloseTo(1, 9);
    }
    const route = traced.route(float(0.6));
    for (const share of [route.traced, route.roughSpecular, route.diffuse])
      expect((share as { isNode?: boolean }).isNode).toBe(true);
    traced.dispose();
  });

  it("keeps the game's own rough-specular limit, and refuses one that cannot mean what it says", () => {
    const own = new TracedReflections(room(), {
      marker: false,
      maxRoughnessToEvaluateRoughSpecular: 0.9,
      roughSpecularFadeLength: 0.1,
    });
    expect(own.routeAt(0.85).diffuse).toBeCloseTo(0.5, 6);
    own.dispose();
    const build = (options: ConstructorParameters<typeof TracedReflections>[1]) => () =>
      new TracedReflections(room(), { marker: false, ...options });
    expect(build({ maxRoughnessToEvaluateRoughSpecular: 0.3 })).toThrow(
      /TN_TRACED_REFLECTIONS: maxRoughnessToEvaluateRoughSpecular/,
    );
    expect(build({ roughSpecularFadeLength: 0.9 })).toThrow(/roughSpecularFadeLength/);
  });

  it("has no fade when the length is zero: full weight up to the cut-off, none past it", () => {
    const traced = new TracedReflections(room(), {
      marker: false,
      maxRoughnessToTrace: 0.4,
      roughnessFadeLength: 0,
    });
    expect(traced.weightAt(0.399)).toBe(1);
    expect(traced.weightAt(0.4)).toBe(0);
  });

  it("answers a ray with the nodes a stage lights a hit from", () => {
    const traced = new TracedReflections(room(), { marker: false });
    const hit = traced.trace({ origin: vec3(0, 1, 0), direction: vec3(0, -1, 0), far: float(20) });
    for (const field of [
      "hit",
      "distance",
      "position",
      "normal",
      "triangle",
      "albedo",
      "roughness",
      "emissive",
      "metalness",
      "material",
    ] as const)
      expect((hit[field] as { isNode?: boolean }).isNode, field).toBe(true);
    expect((traced.weight(float(0.2)) as { isNode?: boolean }).isNode).toBe(true);
    traced.dispose();
  });

  it("builds a shadow ray that stops at the first hit", () => {
    const traced = new TracedReflections(room(), { marker: false });
    const shadow = traced.trace({
      origin: vec3(0, 1, 0),
      direction: vec3(0, 1, 0),
      anyHit: true,
    });
    expect((shadow.hit as { isNode?: boolean }).isNode).toBe(true);
    traced.dispose();
  });
});
