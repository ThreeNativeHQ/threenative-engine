import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { formatProjectionWindow } from "../src/projection-marker.js";
import {
  DEFAULT_MINIMUM_PROJECTED_PIXELS,
  RenderCameraCull,
  alwaysRender,
} from "../src/render-camera-cull.js";

/**
 * The projected-size gate.
 *
 * These prove the decision the shipped game had to discover by hand: an object the render camera
 * cannot resolve is not submitted, the decision is per camera rather than per player distance, and
 * nothing a multi-camera frame still needs is dropped. They are behaviour tests, not a pixel
 * ladder — the ladder needs a browser and lives in the in-game verification lane.
 */

const vector3Allocations = vi.hoisted(() => ({ count: 0 }));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    Vector3: class CountingVector3 extends actual.Vector3 {
      constructor(...args: ConstructorParameters<typeof actual.Vector3>) {
        super(...args);
        vector3Allocations.count += 1;
      }
    },
  };
});

/** A perspective camera at the origin looking down -Z, matching the default Three camera. */
function camera(fov = 60): PerspectiveCamera {
  const result = new PerspectiveCamera(fov, 1, 0.1, 1_000_000);
  result.updateMatrixWorld();
  return result;
}

function sphere(radius: number): SphereGeometry {
  const geometry = new SphereGeometry(radius, 8, 6);
  geometry.computeBoundingSphere();
  return geometry;
}

/** A mesh whose bounding sphere is exactly `radius`, placed at `z`. */
function ball(radius: number, z: number): Mesh {
  const mesh = new Mesh(sphere(radius), new MeshBasicMaterial());
  mesh.position.set(0, 0, z);
  mesh.updateMatrixWorld();
  return mesh;
}

function sceneWith(...objects: Object3D[]): Scene {
  const scene = new Scene();
  for (const object of objects) scene.add(object);
  scene.updateMatrixWorld();
  return scene;
}

/** A mesh with a writable position buffer and an explicitly computed sphere, placed at `z`. */
function dynamicMesh(
  points: number[],
  z: number,
): { mesh: Mesh; position: Float32Array; attribute: BufferAttribute } {
  const geometry = new BufferGeometry();
  const position = new Float32Array(points);
  const attribute = new BufferAttribute(position, 3);
  geometry.setAttribute("position", attribute);
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  mesh.position.set(0, 0, z);
  mesh.updateMatrixWorld();
  return { mesh, position, attribute };
}

describe("render camera cull", () => {
  it("does not submit an object below the threshold and submits one above it", () => {
    const tiny = ball(0.1, -1_000);
    const large = ball(1, -100);
    const scene = sceneWith(tiny, large);
    const cull = new RenderCameraCull();

    cull.apply(scene, camera(), 720);

    expect(tiny.visible).toBe(false);
    expect(large.visible).toBe(true);
    expect(cull.report.considered).toBe(2);
    expect(cull.report.culled).toBe(1);
  });

  it("does not walk a hidden subtree, and culls the visible one as before", () => {
    // The game's own hidden subtree — an unused LOD level, a merged stand-in, a hidden hull body —
    // is already not submitted. The walk must not descend into it at all: visiting it wastes the
    // walk and can hide/restore a node the game deliberately left out.
    const hidden = new Group();
    hidden.visible = false;
    const unreachable = ball(0.1, -1_000);
    hidden.add(unreachable);
    const tiny = ball(0.1, -1_000);
    const scene = sceneWith(hidden, tiny);
    const cull = new RenderCameraCull();

    cull.apply(scene, camera(), 720);

    // Only the visible tiny mesh is considered and culled; the hidden child is never visited.
    expect(cull.report.considered).toBe(1);
    expect(cull.report.culled).toBe(1);
    expect(tiny.visible).toBe(false);
    expect(unreachable.visible).toBe(true);
    cull.restore();
    expect(unreachable.visible).toBe(true);
  });

  it("decides per render camera, not from a player-relative range", () => {
    const far = ball(1, -1_000);
    const scene = sceneWith(far);
    const cull = new RenderCameraCull({ minimumPixels: 5 });

    const distant = camera();
    cull.apply(scene, distant, 720);
    expect(far.visible).toBe(false);
    const afterDistant = cull.report.culled;

    // The same object, same player, but a camera that has moved 900 units closer resolves it.
    const near = camera();
    near.position.set(0, 0, -900);
    near.updateMatrixWorld();
    cull.apply(scene, near, 720);

    expect(far.visible).toBe(true);
    expect(afterDistant).toBe(1);
    expect(cull.report.culled).toBe(0);
  });

  it("keeps a shadow caster that is off the main camera", () => {
    const caster = ball(0.01, -1_000);
    caster.position.set(100_000, 0, -1_000);
    caster.updateMatrixWorld();
    caster.castShadow = true;
    const scene = sceneWith(caster);
    const cull = new RenderCameraCull();

    cull.apply(scene, camera(), 720);

    expect(caster.visible).toBe(true);
    expect(cull.report.culled).toBe(0);
    expect(cull.report.exemptShadowCasters).toBe(1);
  });

  it("culls a shadow caster the main camera can see but cannot resolve", () => {
    const caster = ball(0.01, -1_000);
    caster.castShadow = true;
    const scene = sceneWith(caster);
    const cull = new RenderCameraCull();

    cull.apply(scene, camera(), 720);

    expect(caster.visible).toBe(false);
    expect(cull.report.culled).toBe(1);
    expect(cull.report.exemptShadowCasters).toBe(0);
  });

  it("keeps an object marked with the named override, and reports it", () => {
    const marked = ball(0.01, -1_000);
    alwaysRender(marked);
    const scene = sceneWith(marked);
    const cull = new RenderCameraCull();

    cull.apply(scene, camera(), 720);

    expect(marked.visible).toBe(true);
    expect(cull.report.culled).toBe(0);
    expect(cull.report.exemptMarked).toBe(1);

    alwaysRender(marked, false);
    cull.apply(scene, camera(), 720);
    expect(marked.visible).toBe(false);
  });

  it("keeps an object that already opted out of frustum culling", () => {
    // A pooled batch whose geometry bound projects to a fraction of a pixel but which sets
    // `frustumCulled = false`: the game has told three its bounds cannot be trusted, so a second,
    // stricter cull does not get to override that standing instruction.
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0]), 3),
    );
    geometry.computeBoundingSphere();
    const batch = new Mesh(geometry, new MeshBasicMaterial());
    batch.frustumCulled = false;
    batch.position.set(0, 0, -1_000);
    batch.updateMatrixWorld();
    const scene = sceneWith(batch);
    const cull = new RenderCameraCull();

    cull.apply(scene, camera(), 720);

    expect(batch.visible).toBe(true);
    expect(cull.report.culled).toBe(0);
    expect(cull.report.exemptFrustumCulled).toBe(1);
  });

  it("treats a zero-radius bound as unknown rather than as nothing to draw", () => {
    // A pooled tracer buffer before its first write: computeBoundingSphere sees every vertex at the
    // origin and caches radius 0, which projects to 0 px forever. A degenerate radius carries no
    // size information, so it reads as "no usable bounds", not as "infinitely small".
    const empty = dynamicMesh([0, 0, 0, 0, 0, 0, 0, 0, 0], -1_000);
    const scene = sceneWith(empty.mesh);
    const cull = new RenderCameraCull();

    cull.apply(scene, camera(), 720);

    expect(empty.mesh.geometry.boundingSphere?.radius).toBe(0);
    expect(empty.mesh.visible).toBe(true);
    expect(cull.report.culled).toBe(0);
    expect(cull.report.exemptWithoutBounds).toBe(1);
  });

  it("recomputes a stale bound after the position buffer changes", () => {
    const dynamic = dynamicMesh([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0], -1_000);
    const scene = sceneWith(dynamic.mesh);
    const cull = new RenderCameraCull();

    cull.apply(scene, camera(), 720);
    // Tiny and static: the gate is right to skip it.
    expect(dynamic.mesh.visible).toBe(false);
    expect(cull.report.culled).toBe(1);

    // The buffer is rewritten as a game's per-frame pool does, without recomputing the sphere.
    dynamic.position[3] = 100;
    dynamic.position[7] = 100;
    dynamic.attribute.needsUpdate = true;
    cull.apply(scene, camera(), 720);

    // The cached 0.001-radius sphere must not be trusted once the buffer moved.
    expect(dynamic.mesh.geometry.boundingSphere?.radius).toBeGreaterThan(1);
    expect(dynamic.mesh.visible).toBe(true);
    expect(cull.report.culled).toBe(0);
  });

  it.each([false, true])(
    "does not rescan a buffer rewritten every frame (prepare=%s)",
    (prepare) => {
      // A per-frame rewrite used to scan every vertex every frame. The gate cannot know the new
      // extents without that scan, so once it sees two changes in a row it treats the bound like
      // `frustumCulled = false` and keeps drawing, rather than paying the scan forever.
      const dynamic = dynamicMesh([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0], -1_000);
      const scene = sceneWith(dynamic.mesh);
      const cull = new RenderCameraCull();
      const compute = vi.spyOn(dynamic.mesh.geometry, "computeBoundingSphere");

      for (let frame = 0; frame < 40; frame += 1) {
        dynamic.position[3] = frame + 1;
        dynamic.attribute.needsUpdate = true;
        if (prepare) cull.prepareAnimation(scene, camera(), 720);
        cull.apply(scene, camera(), 720);
      }

      // One recompute for the first change, then the per-frame rewrite is recognised.
      expect(compute.mock.calls.length).toBe(1);
      expect(dynamic.mesh.visible).toBe(true);
      expect(cull.report.culled).toBe(0);
      expect(cull.report.exemptDynamicBounds).toBe(1);
      compute.mockRestore();
    },
  );

  it("culls a rewritten buffer again once it stops changing", () => {
    // The dynamic exemption is for a buffer that *is* rewritten every frame. One that settles has a
    // knowable bound again, and a startup burst of rewrites must not exempt it forever.
    const dynamic = dynamicMesh([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0], -1_000);
    const scene = sceneWith(dynamic.mesh);
    const cull = new RenderCameraCull();

    for (let frame = 0; frame < 5; frame += 1) {
      dynamic.position[3] = 100 + frame;
      dynamic.attribute.needsUpdate = true;
      cull.apply(scene, camera(), 720);
    }
    expect(cull.report.exemptDynamicBounds).toBe(1);

    // The last rewrite shrinks it back to a speck, then the buffer stops changing.
    dynamic.position[3] = 0.001;
    dynamic.attribute.needsUpdate = true;
    cull.apply(scene, camera(), 720);
    cull.apply(scene, camera(), 720);

    expect(cull.report.exemptDynamicBounds).toBe(0);
    expect(dynamic.mesh.geometry.boundingSphere?.radius).toBeLessThan(1);
    expect(dynamic.mesh.visible).toBe(false);
    expect(cull.report.culled).toBe(1);
  });

  it("keeps an object attached to the render camera", () => {
    const cockpit = ball(0.01, -1_000);
    const view = camera();
    view.add(cockpit);
    const scene = sceneWith(view);
    const cull = new RenderCameraCull();

    cull.apply(scene, view, 720);

    expect(cockpit.visible).toBe(true);
    expect(cull.report.exemptCameraAttached).toBe(1);
  });

  it("honours a game-supplied threshold over the default", () => {
    const mesh = ball(1, -100);
    const scene = sceneWith(mesh);

    const byDefault = new RenderCameraCull();
    byDefault.apply(scene, camera(), 720);
    expect(mesh.visible).toBe(true);

    const widened = new RenderCameraCull({ minimumPixels: 40 });
    widened.apply(scene, camera(), 720);
    expect(mesh.visible).toBe(false);
  });

  it("with nothing configured uses the stated default and still measures when disabled", () => {
    const mesh = ball(1, -100);
    const scene = sceneWith(mesh);

    const byDefault = new RenderCameraCull();
    expect(byDefault.report.thresholdPixels).toBe(DEFAULT_MINIMUM_PROJECTED_PIXELS);
    expect(DEFAULT_MINIMUM_PROJECTED_PIXELS).toBe(0.5);

    const disabled = new RenderCameraCull({ minimumPixels: false });
    disabled.apply(scene, camera(), 720);
    expect(mesh.visible).toBe(true);
    expect(disabled.report.enabled).toBe(false);
    expect(disabled.report.considered).toBe(1);
    expect(disabled.report.culled).toBe(0);
  });

  it("restores what it hid so the authored scene is left as the game made it", () => {
    const tiny = ball(0.1, -1_000);
    const scene = sceneWith(tiny);
    const cull = new RenderCameraCull();

    cull.apply(scene, camera(), 720);
    expect(tiny.visible).toBe(false);
    cull.restore();
    expect(tiny.visible).toBe(true);
  });

  it("leaves an orthographic camera uncullied rather than guessing a distance term", () => {
    const tiny = ball(0.001, -100);
    const scene = sceneWith(tiny);
    const cull = new RenderCameraCull();
    const orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    orthographic.updateMatrixWorld();

    cull.apply(scene, orthographic, 720);

    expect(tiny.visible).toBe(true);
    expect(cull.report.cameraResolved).toBe(false);
  });

  it("reports how many objects it skipped on the existing projection window", () => {
    const tiny = ball(0.1, -1_000);
    const large = ball(1, -100);
    const scene = sceneWith(tiny, large);
    const cull = new RenderCameraCull();
    cull.apply(scene, camera(), 720);

    const line = formatProjectionWindow(
      {
        schemaVersion: 1,
        projecting: false,
        reasonCode: "belowMeshFloor",
        sourceRenderables: 2,
        resultDrawCandidates: 2,
        projectedObjects: 0,
        batches: 0,
        instancedBatches: 0,
        materialBatches: 0,
        skinnedBatches: 0,
        exactObjects: 0,
        exact: {},
        drawsPlanned: 2,
        materialChecks: "spread",
        materialChecksPerFrame: 512,
        materialCheckStaleFrames: 0,
        materialChecksOverridden: false,
        path: "js",
        pathOverridden: false,
        timings: { compileMs: 0, reconcileMs: 0, lastReconcileMs: 0, maxReconcileMs: 0 },
      },
      7,
      2,
      cull.report,
    );

    const payload = JSON.parse(line.slice("TN_PROJECTION:".length)) as {
      cull: { culled: number; considered: number; thresholdPixels: number; enabled: boolean };
    };
    expect(payload.cull).toMatchObject({
      culled: 1,
      considered: 2,
      enabled: true,
      thresholdPixels: 0.5,
    });
  });

  it("rejects a threshold that is not false or a positive finite number", () => {
    expect(() => new RenderCameraCull({ minimumPixels: 0 })).toThrow(/minimumProjectedPixels/);
    expect(() => new RenderCameraCull({ minimumPixels: -1 })).toThrow(/minimumProjectedPixels/);
    expect(() => new RenderCameraCull({ minimumPixels: Number.NaN })).toThrow(
      /minimumProjectedPixels/,
    );
  });

  it("lets an engine root cull with its own frustum and reports its counters", () => {
    const counts = [9, 4, 1, 0, 2, 1, 0, 1];
    const root = {
      traverseVisible: vi.fn(),
      __cullProjected: vi.fn(() => counts),
      __restoreCull: vi.fn(),
    };
    const view = camera();
    const matrix = view.projectionMatrix;
    const projection = vi.fn(() => matrix);
    Object.defineProperty(view, "projectionMatrix", { get: projection });
    const traverse = vi.spyOn(view, "traverse");
    const cull = new RenderCameraCull();
    cull.apply(root, view, 720);
    // The engine knows what hangs from the camera: collecting it here is a crossing per child, per frame.
    expect(traverse).not.toHaveBeenCalled();
    // The JS frustum and camera position serve only the JS walk (asserted before the argument
    // match below, whose deep compare reads every camera property).
    expect(projection).not.toHaveBeenCalled();
    expect(root.traverseVisible).not.toHaveBeenCalled();
    expect(root.__cullProjected).toHaveBeenCalledWith(
      view,
      true,
      expect.any(Number),
      DEFAULT_MINIMUM_PROJECTED_PIXELS,
      true,
    );
    const report = cull.report;
    expect([
      report.considered,
      report.culled,
      report.exemptCameraAttached,
      report.exemptMarked,
      report.exemptShadowCasters,
      report.exemptWithoutBounds,
      report.exemptDynamicBounds,
      report.exemptFrustumCulled,
    ]).toEqual(counts);
    cull.restore();
    expect(root.__restoreCull).toHaveBeenCalledOnce();
  });

  it("does not allocate per object per frame", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    for (let index = 0; index < 300; index += 1) group.add(ball(1, -100 - index));

    const cull = new RenderCameraCull();
    const view = camera();
    cull.apply(scene, view, 720);
    cull.restore();
    const afterWarmup = vector3Allocations.count;

    for (let frame = 0; frame < 100; frame += 1) {
      cull.apply(scene, view, 720);
      cull.restore();
    }

    expect(vector3Allocations.count).toBe(afterWarmup);
  });
});
