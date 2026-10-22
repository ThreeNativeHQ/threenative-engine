import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Raycaster,
  SphereGeometry,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { packTraceScene, traceScene } from "../src/render/scene-trace.js";

/** A small seeded generator, so a failing ray can be rerun. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scatter(
  count: number,
  random: () => number,
  extent = 8,
): { group: Group; meshes: Mesh[] } {
  const group = new Group();
  const meshes: Mesh[] = [];
  for (let i = 0; i < count; i += 1) {
    const geometry =
      i % 3 === 0
        ? new SphereGeometry(0.4 + random() * 0.6, 12, 8)
        : i % 3 === 1
          ? new BoxGeometry(0.5 + random(), 0.5 + random(), 0.5 + random())
          : new PlaneGeometry(1 + random() * 2, 1 + random() * 2);
    const mesh = new Mesh(
      geometry,
      new MeshStandardMaterial({ side: i % 5 === 0 ? DoubleSide : 0 }),
    );
    mesh.position.set(
      (random() - 0.5) * extent,
      (random() - 0.5) * extent,
      (random() - 0.5) * extent,
    );
    mesh.rotation.set(random() * 6, random() * 6, random() * 6);
    mesh.scale.set(0.5 + random(), 0.5 + random(), 0.5 + random());
    group.add(mesh);
    meshes.push(mesh);
  }
  group.updateMatrixWorld(true);
  return { group, meshes };
}

describe("packTraceScene", () => {
  it("counts a box as twelve triangles and a plane as two, one material each", () => {
    const group = new Group();
    group.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    group.add(new Mesh(new PlaneGeometry(), new MeshStandardMaterial()));
    const pack = packTraceScene(group);
    expect(pack.report.triangles).toBe(14);
    expect(pack.report.materials).toBe(2);
    expect(pack.report.nodes).toBeGreaterThan(1);
    pack.dispose();
  });

  it("leaves out hidden subtrees and meshes whose triangles move", () => {
    const group = new Group();
    const hidden = new Group();
    hidden.visible = false;
    hidden.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    group.add(hidden);
    group.add(new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 4));
    group.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    const pack = packTraceScene(group);
    expect(pack.report.triangles).toBe(12);
    expect(pack.report.skippedMoving).toBe(1);
  });

  it("packs an empty scene and traces nothing in it", () => {
    const pack = packTraceScene(new Group());
    expect(pack.report.triangles).toBe(0);
    expect(traceScene(pack, new Vector3(), new Vector3(0, 0, 1))).toBeUndefined();
  });

  it("refuses a scene past the pack's index range", () => {
    const group = new Group();
    const geometry = new PlaneGeometry();
    const mesh = new Mesh(geometry, new MeshStandardMaterial());
    Object.defineProperty(geometry.index, "count", { value: 3 * ((1 << 20) + 1) });
    group.add(mesh);
    expect(() => packTraceScene(group)).toThrow(/TN_TRACE_SCENE_TOO_LARGE/);
  });
});

describe("traceScene", () => {
  it("returns the hit three's Raycaster returns for 400 rays through 60 scattered meshes", () => {
    const random = seeded(7);
    const { group, meshes } = scatter(60, random);
    const pack = packTraceScene(group);
    const material = (mesh: Mesh): number =>
      pack.materials.indexOf(mesh.material as MeshStandardMaterial);
    let hits = 0;
    for (let ray = 0; ray < 400; ray += 1) {
      const origin = new Vector3(
        (random() - 0.5) * 14,
        (random() - 0.5) * 14,
        (random() - 0.5) * 14,
      );
      const direction = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
      const expected = new Raycaster(origin, direction).intersectObjects(meshes, false)[0];
      const found = traceScene(pack, origin, direction);
      if (expected === undefined) {
        expect(found, `ray ${ray}`).toBeUndefined();
        continue;
      }
      hits += 1;
      expect(found, `ray ${ray}`).toBeDefined();
      expect(found?.distance).toBeCloseTo(expected.distance, 4);
      expect(found?.material).toBe(material(expected.object as Mesh));
    }
    // The scene is sparse, so most rays miss; a trace that missed everything would still pass the loop above.
    expect(hits).toBeGreaterThan(30);
  });

  it("culls the back of a front-side box and keeps it for a back-side or double-sided one", () => {
    const side = (value: 0 | 1 | 2) => {
      const group = new Group();
      group.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial({ side: value })));
      group.updateMatrixWorld(true);
      return packTraceScene(group);
    };
    const inside = new Vector3(0, 0, 0);
    const out = new Vector3(0, 0, 1);
    expect(traceScene(side(0), inside, out)).toBeUndefined();
    expect(traceScene(side(BackSide), inside, out)?.distance).toBeCloseTo(1, 5);
    expect(traceScene(side(DoubleSide), inside, out)?.distance).toBeCloseTo(1, 5);
    const outside = new Vector3(0, 0, 5);
    const toward = new Vector3(0, 0, -1);
    expect(traceScene(side(0), outside, toward)?.distance).toBeCloseTo(4, 5);
    expect(traceScene(side(BackSide), outside, toward)?.distance).toBeCloseTo(6, 5);
  });

  it("keeps the visible face of a mirrored mesh as its front", () => {
    const group = new Group();
    const mesh = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
    mesh.scale.set(-1, 1, 1);
    group.add(mesh);
    group.updateMatrixWorld(true);
    const pack = packTraceScene(group);
    const hit = traceScene(pack, new Vector3(5, 0, 0), new Vector3(-1, 0, 0));
    expect(hit?.distance).toBeCloseTo(4, 5);
    expect(hit?.front).toBe(true);
    expect(hit?.normal.x).toBeCloseTo(1, 5);
  });

  it("stops at far, and an any-hit query answers with a hit that is no nearer than the nearest", () => {
    const { group, meshes } = scatter(40, seeded(3));
    const pack = packTraceScene(group);
    const origin = new Vector3(-30, 0, 0);
    const direction = (meshes[1]?.position.clone() ?? new Vector3()).sub(origin).normalize();
    const nearest = traceScene(pack, origin, direction);
    expect(nearest).toBeDefined();
    const distance = nearest?.distance ?? 0;
    expect(traceScene(pack, origin, direction, distance - 0.01)).toBeUndefined();
    const any = traceScene(pack, origin, direction, Number.POSITIVE_INFINITY, true);
    expect(any?.distance).toBeGreaterThanOrEqual(distance - 1e-6);
  });

  it("closes a hairline gap between two triangles, and still misses a wide one", () => {
    // Float32 leaves cracks between triangles that share an edge: a ray through one passes between both.
    const quad = (gap: number): Group => {
      const half = gap / 2;
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        "position",
        new BufferAttribute(
          // Triangle A fills x + y <= 1. Triangle B is the other half of the square, moved out by the gap.
          new Float32Array([
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            1,
            0,
            1 + half,
            half,
            0,
            1 + half,
            1 + half,
            0,
            half,
            1 + half,
            0,
          ]),
          3,
        ),
      );
      geometry.computeVertexNormals();
      const group = new Group();
      group.add(new Mesh(geometry, new MeshStandardMaterial()));
      group.updateMatrixWorld(true);
      return group;
    };
    const through = (gap: number) =>
      traceScene(
        packTraceScene(quad(gap)),
        new Vector3(0.5 + gap / 4, 0.5 + gap / 4, 5),
        new Vector3(0, 0, -1),
      );
    expect(through(0)).toBeDefined();
    expect(through(2e-6)).toBeDefined();
    expect(through(2e-3)).toBeUndefined();
  });

  it("faces the interpolated vertex normal toward the ray", () => {
    const group = new Group();
    const sphere = new Mesh(
      new SphereGeometry(1, 48, 32),
      new MeshStandardMaterial({ side: DoubleSide }),
    );
    sphere.position.set(0, 0, -5);
    group.add(sphere);
    group.updateMatrixWorld(true);
    const pack = packTraceScene(group);
    const from = new Vector3(0, 0, 0);
    const front = traceScene(pack, from, new Vector3(0, 0, -1));
    expect(front?.normal.z).toBeGreaterThan(0.99);
    const inside = traceScene(pack, new Vector3(0, 0, -5), new Vector3(0, 0, -1));
    expect(inside?.normal.z).toBeGreaterThan(0.99);
    expect(inside?.front).toBe(false);
  });
});
