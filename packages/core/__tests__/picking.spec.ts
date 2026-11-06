import {
  Bone,
  BoxGeometry,
  type BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  type Intersection,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  type Raycaster,
  Skeleton,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
} from "three";
import { acceleratedRaycast } from "three-mesh-bvh";
import { describe, expect, it, vi } from "vitest";
import { DiscreteLodPlugin, TN_DISCRETE_LOD, updateModelLods } from "../src/model-lod.js";
import { ScenePicker } from "../src/picking.js";
import { type IViewportSize, Viewport } from "../src/viewport.js";

function renderer(canvas: HTMLCanvasElement) {
  return {
    canvas,
    compileAsync: async () => undefined,
    compute: () => undefined,
    domElement: canvas,
    info: {},
    kind: "webgl2" as const,
    raw: {},
    render: () => undefined,
    readback: async () => new ArrayBuffer(0),
    renderOverlay: () => undefined,
    setOutputNode: () => undefined,
    setSize: () => undefined,
    gpuFrameMs: () => undefined,
    resolveGpuFrame: () => undefined,
    setResolutionScale: () => undefined,
    surface: () => ({
      atFloor: false,
      drawingBufferHeight: 1,
      drawingBufferWidth: 1,
      resolutionScale: 1,
      sampleCount: 1,
      scaleSource: "pinned" as const,
    }),
    dispose: () => undefined,
  };
}

function testCanvas(width = 1280, height = 720): HTMLCanvasElement & { size: IViewportSize } {
  const canvas = new EventTarget() as HTMLCanvasElement & { size: IViewportSize };
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, get: () => canvas.size.height },
    clientWidth: { configurable: true, get: () => canvas.size.width },
  });
  canvas.size = { aspect: width / height, height, width };
  return canvas;
}

function scenePicker(...contents: Object3D[]) {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 5;
  camera.lookAt(0, 0, 0);
  const viewport = new Viewport({ camera, renderer: renderer(testCanvas()) });
  const root = new Mesh();
  for (const child of contents) root.add(child);
  const picker = new ScenePicker({
    camera,
    pointer: () => new Vector2(640, 360),
    scene: root,
    viewport,
  });
  return { camera, picker, root, viewport };
}

/** Subdivided so the hierarchy is more than a single leaf, which is what makes stale bounds observable. */
function plane(name: string, z: number): Mesh {
  const mesh = new Mesh(new PlaneGeometry(2, 2, 32, 32));
  mesh.name = name;
  mesh.position.z = z;
  return mesh;
}

/**
 * A skinned quad, bound to one bone, facing the camera.
 *
 * Characters arrive as skinned meshes and a game that wants one clickable has no other shape to
 * offer the picker, so this is the case that decides whether `ctx.pointer.on` works on a loaded
 * model at all.
 */
function skinnedQuad(name: string, z: number): Group {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  geometry.setAttribute(
    "skinIndex",
    new Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.name = `${name}-mesh`;
  const bone = new Bone();
  bone.name = "Root";
  mesh.add(bone);
  mesh.bind(new Skeleton([bone]));
  const group = new Group();
  group.name = name;
  group.position.z = z;
  group.add(mesh);
  group.updateWorldMatrix(true, true);
  return group;
}

function box(name: string, z: number): Mesh {
  const mesh = new Mesh(new BoxGeometry(2, 2, 2));
  mesh.name = name;
  mesh.position.z = z;
  return mesh;
}

describe("ScenePicker", () => {
  it("should hit a skinned mesh the same way it hits a static one", () => {
    const rig = skinnedQuad("character", 0);
    const { picker } = scenePicker(rig);
    const hit = picker.raycast({ screen: new Vector2(640, 360) });
    expect(hit?.object.name).toBe("character-mesh");
  });

  it("should follow a skinned mesh to where its bones moved it", () => {
    const rig = skinnedQuad("character", 0);
    const bone = rig.getObjectByName("Root") as Bone;
    // Move the whole quad two metres to the left by moving the only bone that drives it. On
    // screen the character is now over there; a click where it used to be should miss.
    bone.position.x = -2;
    bone.updateMatrixWorld(true);
    rig.updateWorldMatrix(true, true);
    const { picker } = scenePicker(rig);
    // Nothing is at the centre any more, and something is two metres to its left.
    expect(picker.raycast({ screen: new Vector2(640, 360) })?.object.name).toBeUndefined();
    const moved = picker.raycast({ screen: new Vector2(455, 360) });
    expect(moved?.object.name).toBe("character-mesh");
  });

  it("should hit a skinned mesh reached through the group a game registers", () => {
    const rig = skinnedQuad("character", 0);
    const { picker } = scenePicker(rig);
    const hits = picker.raycastAll({ screen: new Vector2(640, 360), targets: [rig] });
    expect(hits.map((entry) => entry.object.name)).toContain("character-mesh");
  });

  it("returns the nearest hit under the pointer and nothing when the ray misses", () => {
    const near = plane("near", 2);
    const far = plane("far", 0);
    const { picker } = scenePicker(far, near);

    const hit = picker.raycast();
    expect(hit?.object.name).toBe("near");
    expect(hit?.distance).toBeCloseTo(3, 5);

    expect(picker.raycast({ screen: new Vector2(0, 0) })).toBeUndefined();
  });

  it("should return the nearest hit when a farther target is listed first", () => {
    // Passes on the pre-change baseline too — correctness is not the discriminating gate here;
    // paired with the collection test below per PRD-186's negative-control rule.
    const near = box("near", 0);
    const far = box("far", -3);
    const { picker } = scenePicker(far, near);

    const hit = picker.raycast({ origin: new Vector3(0, 0, 5), direction: new Vector3(0, 0, -1) });
    expect(hit?.object.name).toBe("near");
  });

  it("should not collect hits behind the nearest for a single-hit query", () => {
    // The discriminating gate (PRD-186 phase 1): each target's raycast receives its own empty
    // scratch buffer and only one hit per object survives. On the old full-sort path every
    // object wrote into one shared array, so the second target saw the first's hits already
    // collected — red there, green here.
    class MultiHitProbe extends Object3D {
      seen: number[] = [];
      constructor(name: string, z: number) {
        super();
        this.name = name;
        this.position.z = z;
      }
      override raycast(_raycaster: Raycaster, intersects: Intersection[]): void {
        this.seen.push(intersects.length);
        const base = this.position.z === 0 ? 4 : 7;
        for (const distance of [base + 1, base + 2, base + 3]) {
          intersects.push({
            distance,
            object: this,
            point: new Vector3(),
          });
        }
      }
    }
    const near = new MultiHitProbe("near", 0);
    const far = new MultiHitProbe("far", -3);
    const { picker } = scenePicker(far, near);

    const hit = picker.raycast({ origin: new Vector3(0, 0, 5), direction: new Vector3(0, 0, -1) });
    expect(hit?.object.name).toBe("near");
    expect(hit?.distance).toBe(5);
    // One hit kept per object, and no target ever observed another target's hits.
    expect(near.seen).toEqual([0]);
    expect(far.seen).toEqual([0]);
  });

  it("restores the every-hit traversal mode after a single-hit query", () => {
    const seenFlags: boolean[] = [];
    const target = plane("target", 0);
    target.morphTargetInfluences = [0]; // force the stock fallback so we can observe the flag
    const stock = target.raycast.bind(target);
    target.raycast = (raycaster, intersects) => {
      seenFlags.push(raycaster.firstHitOnly === true);
      return stock(raycaster, intersects);
    };
    const { picker } = scenePicker(target);

    expect(picker.raycast()?.object.name).toBe("target");
    expect(seenFlags).toEqual([true]);

    // raycastAll must still see every hit afterwards.
    const hits = picker.raycastAll({
      direction: new Vector3(0, 0, -1),
      origin: new Vector3(0, 0, 5),
    });
    expect(hits.length).toBeGreaterThan(1);
    expect(seenFlags.at(-1)).toBe(false);
  });

  it("takes the accelerated path without patching any three prototype", () => {
    const target = plane("target", 0);
    const { picker } = scenePicker(target);
    // On the prototype: an instance spy would be the game's own `raycast`, which picking honours.
    const stock = vi.spyOn(Mesh.prototype, "raycast");

    try {
      expect(picker.raycast()?.object.name).toBe("target");
      // The empty root has no tree and takes the stock path; the target never does.
      expect(stock.mock.contexts).not.toContain(target);
    } finally {
      stock.mockRestore();
    }
    expect(Mesh.prototype.raycast).not.toBe(acceleratedRaycast);
  });

  it("honours a mesh's own no-op raycast without building its tree", () => {
    const decor = plane("decor", 0);
    // Unindexed, so a tree build is visible: MeshBVH writes an index into the geometry it reads.
    decor.geometry = decor.geometry.toNonIndexed();
    decor.raycast = () => undefined;
    const behind = plane("behind", -2);
    const { picker } = scenePicker(decor, behind);

    const hit = picker.raycast({ origin: new Vector3(0, 0, 5), direction: new Vector3(0, 0, -1) });
    expect(hit?.object.name).toBe("behind");
    expect(decor.geometry.index).toBeNull();
  });

  it("falls back to the stock raycast for a morphed mesh", () => {
    const target = plane("morphed", 0);
    target.morphTargetInfluences = [0];
    const { picker } = scenePicker(target);
    // Spy on the prototype: an instance spy is an own `raycast`, which takes the stock path by itself.
    const stock = vi.spyOn(Mesh.prototype, "raycast");

    expect(picker.raycast()?.object.name).toBe("morphed");
    expect(stock.mock.contexts.filter((self) => self === target)).toHaveLength(1);
    stock.mockRestore();
  });

  it("rebuilds the hierarchy when the geometry's positions change", () => {
    const target = plane("moved", 0);
    const position = target.geometry.attributes.position as BufferAttribute;
    for (let index = 0; index < position.count; index += 1)
      position.setX(index, position.getX(index) + 10);
    const { picker } = scenePicker(target);

    expect(picker.raycast()).toBeUndefined();

    for (let index = 0; index < position.count; index += 1)
      position.setX(index, position.getX(index) - 10);
    position.version += 1;

    expect(picker.raycast()?.object.name).toBe("moved");
  });

  it("drops cached hierarchies on dispose and rebuilds them on the next query", () => {
    const target = plane("kept", 0);
    const { picker } = scenePicker(target);

    expect(picker.raycast()?.object.name).toBe("kept");
    picker.dispose();
    expect(picker.raycast()?.object.name).toBe("kept");
  });

  it("rejects a screen point that is not finite", () => {
    const { picker } = scenePicker(plane("target", 0));
    expect(() => picker.raycast({ screen: new Vector2(Number.NaN, 0) })).toThrow(/must be finite/u);
  });

  it("casts a world ray, respects far, and returns all hits near to far", () => {
    const far = box("far", -3);
    const near = box("near", 0);
    far.position.x = 3;
    near.position.x = 3;
    const { picker } = scenePicker(far, near);
    const origin = new Vector3(3, 0, 5);
    const direction = new Vector3(0, 0, -1);

    expect(picker.raycast({ screen: new Vector2(640, 360) })).toBeUndefined();
    expect(picker.raycast({ origin, direction })?.object.name).toBe("near");
    expect(picker.raycast({ origin, direction })?.distance).toBeCloseTo(4, 5);
    expect(picker.raycast({ origin, direction, far: 3.5 })).toBeUndefined();

    const hits = picker.raycastAll({ origin, direction });
    expect(hits.length).toBeGreaterThan(2);
    expect(hits[0]?.object.name).toBe("near");
    expect(hits.at(-1)?.object.name).toBe("far");
    const distances = hits.map((hit) => hit.distance);
    expect(distances).toEqual([...distances].sort((first, second) => first - second));
  });

  it("sets the camera before a world ray reaches a sprite", () => {
    const sprite = new Sprite(new SpriteMaterial());
    sprite.name = "sprite";
    sprite.position.set(2, 0, 0);
    const target = box("target", -3);
    target.position.x = 2;
    const { picker } = scenePicker(sprite, target);

    expect(
      picker.raycast({
        direction: new Vector3(0, 0, -1),
        origin: new Vector3(2, 0, 5),
      })?.object.name,
    ).toBe("sprite");
  });

  it("keeps a previous raycastAll result unchanged after another query", () => {
    const far = box("far", -3);
    const near = box("near", 0);
    const { picker } = scenePicker(far, near);
    const origin = new Vector3(0, 0, 5);
    const direction = new Vector3(0, 0, -1);

    const firstHits = picker.raycastAll({ origin, direction });
    const firstHitNames = firstHits.map((hit) => hit.object.name);

    picker.raycastAll({ origin, direction, targets: near });

    expect(firstHits.map((hit) => hit.object.name)).toEqual(firstHitNames);
  });

  it("fills and returns a supplied raycastAll target", () => {
    const far = box("far", -3);
    const near = box("near", 0);
    const { picker } = scenePicker(far, near);
    const target: Intersection[] = [];
    const origin = new Vector3(0, 0, 5);
    const direction = new Vector3(0, 0, -1);

    expect(picker.raycastAll({ origin, direction }, target)).toBe(target);
    expect(target[0]?.object.name).toBe("near");

    picker.raycastAll({ origin, direction, targets: near }, target);
    expect(target).toHaveLength(2);
    expect(target[0]?.object.name).toBe("near");
  });

  it("excludes a parent and its whole subtree", () => {
    const excludedParent = new Object3D();
    const excludedChild = box("excluded", 0);
    excludedParent.add(excludedChild);
    const included = box("included", -3);
    const { picker } = scenePicker(excludedParent, included);

    const hit = picker.raycast({
      direction: new Vector3(0, 0, -1),
      exclude: excludedParent,
      origin: new Vector3(0, 0, 5),
      targets: excludedChild,
    });
    expect(hit).toBeUndefined();
    expect(
      picker.raycast({
        direction: new Vector3(0, 0, -1),
        exclude: excludedParent,
        origin: new Vector3(0, 0, 5),
        targets: [excludedParent, included],
      })?.object.name,
    ).toBe("included");
  });

  it("rejects ambiguous ray descriptions", () => {
    const { picker } = scenePicker(plane("target", 0));
    expect(() => picker.raycast({ origin: new Vector3(), screen: new Vector2(640, 360) })).toThrow(
      /cannot be combined/u,
    );
    expect(() => picker.raycast({ direction: new Vector3(0, 0, -1) })).toThrow(/requires origin/u);
  });

  it("picks the authored LOD0 surface while the camera draws a coarser level", async () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeBoundingSphere();
    const managed = new Mesh(geometry, new MeshBasicMaterial());
    managed.name = "picked";

    const plugin = new DiscreteLodPlugin();
    plugin.setParser({
      associations: new Map([[managed, { meshes: 0, primitives: 0 }]]),
      getDependency: async () => ({ array: Uint32Array.from([0, 1, 2]) }),
      json: {
        meshes: [
          {
            primitives: [
              {
                extensions: {
                  [TN_DISCRETE_LOD]: {
                    absoluteErrors: [0.05],
                    counts: [1],
                    errors: [0.05],
                    indices: [0],
                    lod0Triangles: 2,
                    schemaVersion: 1,
                    sharedVertexBuffers: true,
                    strategy: "discrete",
                  },
                },
              },
            ],
          },
        ],
      },
    } as never);
    await plugin.afterRoot({ scene: managed });
    expect(plugin.attach(managed, { hysteresis: 0.15, maxPixelError: 1 })).toBe(1);

    const { picker, root } = scenePicker(managed);
    // Far from the picker's own camera, the controller draws the one-triangle level.
    const far = new PerspectiveCamera(60, 1, 0.1, 1000);
    far.position.set(0, 0, 100);
    far.updateMatrixWorld(true);
    updateModelLods(root, far, 1080);
    expect(managed.geometry.index?.count).toBe(3);

    // A ray through the upper-left triangle: LOD0 has it, the drawn level does not.
    const hit = picker.raycast({
      direction: new Vector3(0, 0, -1),
      origin: new Vector3(-0.5, 0.5, 5),
    });
    expect(hit?.object).toBe(managed);
    expect(hit?.distance).toBeCloseTo(5, 5);
  });
});
