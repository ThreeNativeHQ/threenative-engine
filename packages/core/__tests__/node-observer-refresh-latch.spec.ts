import { BoxGeometry, Euler, Quaternion } from "three";
import { InstancedMesh, MeshStandardNodeMaterial, NodeMaterialObserver } from "three/webgpu";
import { describe, expect, it } from "vitest";

const canvasTarget = {};

/** The slice of three's RenderObject that NodeMaterialObserver.equals() actually reads. */
function renderObjectFor(object: InstancedMesh) {
  return {
    object,
    geometry: object.geometry,
    material: object.material,
    bundle: null as null,
    lights: [] as never[],
    renderer: {
      getRenderTarget: () => null,
      getOutputRenderTarget: () => null,
      getCanvasTarget: () => canvasTarget,
    },
    context: { width: 1, height: 1 },
    _geometries: { attributes: { disposeVersion: 0 } },
    lightsNode: { getBuiltinLights: () => [] },
    scene: { environment: null, environmentIntensity: 1, environmentRotation: new Quaternion() },
  };
}

describe("NodeMaterialObserver geometry refresh latch", () => {
  it("reports a shared geometry settled on the second draw of the same frame", () => {
    const identity = new Quaternion().setFromEuler(new Euler());
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    const first = new InstancedMesh(geometry, material, 1);
    const second = new InstancedMesh(geometry, material, 1);
    for (const [index, mesh] of [first, second].entries()) {
      mesh.quaternion.copy(identity);
      mesh.position.set(index * 2, 0, 0);
      mesh.updateMatrixWorld();
    }

    // @types/three declares no members for the observer, so the method under test is named here.
    const observer = new NodeMaterialObserver({
      material,
      object: first,
      context: {},
    } as never) as unknown as {
      equals(renderObject: unknown, lightsData: unknown[], renderId: number): boolean;
    };
    const a = renderObjectFor(first);
    const b = renderObjectFor(second);

    // Frame 1 primes both draws, then the shared geometry's position attribute is rewritten.
    expect(observer.equals(a, [], 1)).toBe(true);
    expect(observer.equals(b, [], 1)).toBe(true);
    geometry.getAttribute("position").needsUpdate = true;

    // Frame 2: the first draw sees the new attribute version and re-snapshots it.
    expect(observer.equals(a, [], 2)).toBe(false);
    // The second draw shares that geometry. r187 versions the geometry snapshot (`_version`) and
    // each render object compares its own copy, so the draw that has not refreshed yet reports
    // "changed" exactly once and is settled right after. The old latch re-ran the refresh branch
    // for every later draw of the same geometry for the rest of the frame.
    expect(observer.equals(b, [], 2)).toBe(false);
    expect(observer.equals(a, [], 2)).toBe(true);
    expect(observer.equals(b, [], 2)).toBe(true);

    // Nothing moved on frame 3, so both draws stay settled.
    expect(observer.equals(a, [], 3)).toBe(true);
    expect(observer.equals(b, [], 3)).toBe(true);
  });
});
