import { BoxGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, Scene } from "three";
import { describe, expect, it } from "vitest";
import { createProjectionScanWorkspace, scanProjection } from "../src/projection-plan.js";
import { ProjectionStability } from "../src/projection-stability.js";

function sceneWith(material: MeshStandardMaterial | MeshBasicMaterial): {
  scene: Scene;
  mesh: Mesh;
} {
  const scene = new Scene();
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  scene.add(mesh);
  return { mesh, scene };
}

describe("ProjectionStability lane predicates", () => {
  it("holds after record, and drops when a material or geometry lane value changes", () => {
    const material = new MeshStandardMaterial();
    const { scene, mesh } = sceneWith(material);
    const stability = new ProjectionStability();
    const workspace = createProjectionScanWorkspace();
    stability.record(scene, scanProjection(scene, 4, workspace));
    expect(stability.holds(scene)).toBe(true);

    // A lane change that is not a scene-structure change still costs a re-scan.
    material.transparent = true;
    expect(stability.holds(scene)).toBe(false);
    material.transparent = false;

    const ranged = new BoxGeometry(1, 1, 1);
    mesh.geometry = ranged;
    const workspace2 = createProjectionScanWorkspace();
    stability.record(scene, scanProjection(scene, 4, workspace2));
    expect(stability.holds(scene)).toBe(true);
    ranged.setDrawRange(1, 8);
    expect(stability.holds(scene)).toBe(false);
  });

  it("drops when a renderable moves in or out of the exact lane via visibility", () => {
    const material = new MeshBasicMaterial();
    const { scene, mesh } = sceneWith(material);
    const stability = new ProjectionStability();
    const workspace = createProjectionScanWorkspace();
    stability.record(scene, scanProjection(scene, 4, workspace));
    expect(stability.holds(scene)).toBe(true);
    mesh.visible = false;
    expect(stability.holds(scene)).toBe(false);
    mesh.visible = true;
    expect(stability.holds(scene)).toBe(true);
  });
});

describe("a scene recorded again and again", () => {
  it("watches each distinct material and geometry once, however many scans run", () => {
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const first = new MeshStandardMaterial();
    const second = new MeshStandardMaterial();
    for (let index = 0; index < 40; index += 1)
      scene.add(new Mesh(geometry, index % 2 === 0 ? first : second));

    const stability = new ProjectionStability();
    const workspace = createProjectionScanWorkspace();
    for (let scan = 0; scan < 25; scan += 1)
      stability.record(scene, scanProjection(scene, 4, workspace));

    // RED before the fix: 25 scans appended all 40 meshes' materials and geometry 25 times over, so
    // `holds` walked the log of every scan instead of the scene.
    expect(stability.watchedMaterialCount).toBe(2);
    expect(stability.watchedGeometryCount).toBe(1);
    expect(stability.holds(scene)).toBe(true);

    // The re-recorded proof is not stale: a lane value on a watched material still fails it.
    first.transparent = true;
    expect(stability.holds(scene)).toBe(false);
    first.transparent = false;

    // Nor on a watched geometry: a buffer someone streamed into still fails it.
    stability.record(scene, scanProjection(scene, 4, workspace));
    expect(stability.holds(scene)).toBe(true);
    const position = geometry.attributes.position;
    if (position === undefined) throw new Error("box geometry lost its position");
    position.needsUpdate = true;
    expect(stability.holds(scene)).toBe(false);
  });
});

describe("a host whose `children` is built on every read", () => {
  // The native engine returns a fresh array of wrappers from each `children` read, so a walk that reads
  // it per index is quadratic in the scene's size: 4096 cubes cost three seconds a frame.
  it("reads the root's children once per scan, record and holds, not once per child", () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    const geometry = new BoxGeometry(1, 1, 1);
    for (let index = 0; index < 300; index += 1) scene.add(new Mesh(geometry, material));
    const real = scene.children;
    let reads = 0;
    Object.defineProperty(scene, "children", {
      get() {
        reads += 1;
        return real;
      },
    });

    const stability = new ProjectionStability();
    const workspace = createProjectionScanWorkspace();
    const scan = scanProjection(scene, 4, workspace);
    stability.record(scene, scan);
    expect(stability.holds(scene)).toBe(true);
    // One read per walk: the scan, the record and the check each take the array once.
    expect(reads).toBeLessThanOrEqual(6);
  });
});

describe("a host that stamps the structure it owns", () => {
  // The native engine hashes the walk, visibility and each mesh's geometry, material and flags in
  // one call. A matching stamp must skip the per-object reads; a changed one must fall back to the
  // exact walk, which still decides.
  function stamped(count: number) {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    const geometry = new BoxGeometry(1, 1, 1);
    const meshes: Mesh[] = [];
    for (let index = 0; index < count; index += 1) {
      const mesh = new Mesh(geometry, material);
      meshes.push(mesh);
      scene.add(mesh);
    }
    const stamp = { calls: 0, value: 1 };
    (scene as unknown as { __tnStructureStamp: () => number }).__tnStructureStamp = () => {
      stamp.calls += 1;
      return stamp.value;
    };
    const reads = { children: 0 };
    const real = scene.children;
    Object.defineProperty(scene, "children", {
      get() {
        reads.children += 1;
        return real;
      },
    });
    return { meshes, reads, scene, stamp };
  }

  it("holds on a matching stamp without walking the scene", () => {
    const { scene, reads, stamp } = stamped(50);
    const stability = new ProjectionStability();
    stability.record(scene, scanProjection(scene, 4, createProjectionScanWorkspace()));
    const before = reads.children;
    expect(stability.holds(scene)).toBe(true);
    expect(reads.children).toBe(before);
    expect(stamp.calls).toBeGreaterThanOrEqual(2);
  });

  it("walks when the stamp changes, and still holds when the walk finds nothing that matters", () => {
    const { scene, reads, stamp } = stamped(50);
    const stability = new ProjectionStability();
    stability.record(scene, scanProjection(scene, 4, createProjectionScanWorkspace()));
    stamp.value = 2;
    const before = reads.children;
    expect(stability.holds(scene)).toBe(true);
    expect(reads.children).toBeGreaterThan(before);
  });

  it("drops on a script-side change the stamp cannot see", () => {
    const { scene, meshes } = stamped(10);
    const stability = new ProjectionStability();
    stability.record(scene, scanProjection(scene, 4, createProjectionScanWorkspace()));
    expect(stability.holds(scene)).toBe(true);
    (meshes[3] as Mesh).customDepthMaterial = new MeshBasicMaterial();
    expect(stability.holds(scene)).toBe(false);
  });

  it("drops when the stamp changes because a mesh really changed", () => {
    const { scene, meshes, stamp } = stamped(10);
    const stability = new ProjectionStability();
    stability.record(scene, scanProjection(scene, 4, createProjectionScanWorkspace()));
    (meshes[2] as Mesh).visible = false;
    stamp.value = 3;
    expect(stability.holds(scene)).toBe(false);
  });
});
