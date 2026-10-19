import {
  BoxGeometry,
  DirectionalLight,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type OrthographicCamera,
  PerspectiveCamera,
  Scene,
  type Sphere,
} from "three";
import type { NodeBuilder, NodeFrame } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_SMALL_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
  VirtualShadowNode,
} from "../src/render/virtual-shadow.js";

/**
 * PRD-473 step 0: a level's caster bill is reported, split by the kind of mesh that submitted it.
 *
 * The numbers are read straight off the node's own stats row, so a level that chooses the cluster
 * half reports the cluster-layer casters and none of the wide ones, the finest level adds its small
 * casters, and the merged per-chunk proxies and layer 0's own casters are counted as their own
 * kinds rather than folded into the batches they stand in for.
 */

const builder = {
  context: {},
  material: {},
  renderer: { shadowMap: { enabled: true } },
} as unknown as NodeBuilder;

let clock = 0;
function frameFor(camera: PerspectiveCamera): NodeFrame {
  clock += 1;
  return { camera, renderer: {}, time: clock } as unknown as NodeFrame;
}

/** One casting box on `layer` (0 for the main layer), with the name it draws under. */
function caster(scene: Scene, layer: number, name: string): Mesh {
  const mesh = new Mesh(new BoxGeometry(8, 8, 8), new MeshBasicMaterial());
  mesh.name = name;
  mesh.position.set(0, 4, 0);
  mesh.castShadow = true;
  mesh.layers.set(layer);
  scene.add(mesh);
  return mesh;
}

function shadowWorld(): { camera: PerspectiveCamera; light: DirectionalLight; scene: Scene } {
  const scene = new Scene();
  const light = new DirectionalLight(0xffffff, 1);
  // Off vertical: a sun exactly overhead leaves the level camera's own placement degenerate.
  light.position.set(60, 200, -40);
  light.target.position.set(0, 0, 0);
  light.castShadow = true;
  scene.add(light, light.target);
  const camera = new PerspectiveCamera(60, 1, 0.1, 900);
  camera.position.set(0, 10, 0);
  camera.updateMatrixWorld(true);
  scene.add(camera);
  return { camera, light, scene };
}

function nodeFor(
  light: DirectionalLight,
  options: { clipExtents?: readonly number[]; invalidationDelay?: number } = {},
): VirtualShadowNode {
  const node = new VirtualShadowNode(light, {
    clipExtents: [24, 96],
    mapSize: 1024,
    marker: false,
    ...options,
  });
  node.setup(builder);
  // The real draw belongs to three's renderer; this test is about what the level reports.
  for (const levelNode of [...node.levelNodes, ...node.moverNodes])
    (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () =>
      undefined;
  return node;
}

afterEach(() => {
  clock = 0;
  vi.restoreAllMocks();
});

/** What every level reports: the bill, the size gate and the depth derived off the caster set. */
function report(node: VirtualShadowNode): unknown[] {
  return node.stats.perLevel.map((level, index) => {
    const camera = (
      node.levelLights[index] as unknown as { shadow: { camera: OrthographicCamera } }
    ).shadow.camera;
    return {
      draws: level.draws,
      drawsBy: level.drawsBy,
      far: camera.far,
      gateHidden: level.gateHidden,
      near: camera.near,
    };
  });
}

describe("a level's reported caster draws", () => {
  it("reports the chosen cluster half, its small casters, its chunk proxies and layer 0", () => {
    const { camera, light, scene } = shadowWorld();
    // One cluster square the window covers, and three key-wide meshes waiting on the wide layer:
    // 1 < 3, so the level takes the cluster half. A merged chunk proxy rides the cluster layer too,
    // and the small and layer-0 casters take no part in the choice but are still drawn.
    caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "cluster");
    caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "world-chunk-shadow");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide");
    caster(scene, VIRTUAL_SHADOW_SMALL_CASTER_LAYER, "small");
    caster(scene, 0, "terrain");
    scene.updateMatrixWorld(true);

    const node = nodeFor(light);
    node.updateBefore(frameFor(camera));

    // The finest level takes the frame's single render, so its row is the one with a bill.
    const fine = node.stats.perLevel[0];
    const by = fine?.drawsBy;
    expect(by).toBeDefined();
    if (by === undefined || fine === undefined) return;
    expect(by.cluster).toBe(1);
    expect(by.chunkProxy).toBe(1);
    expect(by.small).toBe(1);
    expect(by.layer0).toBe(1);
    expect(by.wide).toBe(0);
    expect(by.cluster + by.wide + by.small + by.chunkProxy + by.layer0).toBe(fine.draws);
    expect(fine.draws).toBe(4);
    node.dispose();
  });

  it("reports none of the wide half when clustered, while keeping resolved small-layer casters", () => {
    const { camera, light, scene } = shadowWorld();
    caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "cluster");
    caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "world-chunk-shadow");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide");
    caster(scene, VIRTUAL_SHADOW_SMALL_CASTER_LAYER, "small");
    caster(scene, 0, "terrain");
    scene.updateMatrixWorld(true);

    const node = nodeFor(light);
    // The finest level renders first and defers the coarse one, which takes the next frame.
    node.updateBefore(frameFor(camera));
    node.updateBefore(frameFor(camera));

    const coarse = node.stats.perLevel[1];
    const by = coarse?.drawsBy;
    expect(by).toBeDefined();
    if (by === undefined || coarse === undefined) return;
    expect(by.small).toBe(1);
    expect(by.cluster).toBe(1);
    expect(by.chunkProxy).toBe(1);
    expect(by.layer0).toBe(1);
    expect(by.wide).toBe(0);
    expect(coarse.draws).toBe(4);
    node.dispose();
  });
});

/**
 * PRD-475 cut 2: the caster set a level reads is memoised, so a world that did not change is not
 * walked again on the next render. Three things have to hold for that to be worth anything, and
 * each is asserted here through the node's own reported bill and derived depth rather than through
 * a counter of its own: the walk happens once and not per render, a change the tree reports rebuilds
 * it, and every other change a game can make to a caster — its `castShadow`, where it stands — is
 * still read on the render itself. The last is checked against a node that has never seen the
 * world, because "the memoised node agrees with a fresh walk" is the only statement worth making
 * about a memo.
 */
/**
 * What a node that has never seen this world says about it, having walked it in full — the
 * statement the memo has to keep making after every change a game can make to a caster.
 */
function reportFromAFreshNode(light: DirectionalLight, camera: PerspectiveCamera): unknown[] {
  const fresh = nodeFor(light, { invalidationDelay: 0 });
  fresh.updateBefore(frameFor(camera));
  const reported = report(fresh);
  fresh.dispose();
  return reported;
}

describe("the memoised caster set", () => {
  it.each(["cluster", "wide"] as const)(
    "finishes the coarse probe after an alpha caster, choosing %s casters",
    (half) => {
      const { camera, light, scene } = shadowWorld();
      const cells = new Group();
      scene.add(cells);
      const cutout = caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "pine-leaves@0,0");
      (cutout.material as MeshBasicMaterial).alphaTest = 0.5;
      cells.add(cutout);
      const node = nodeFor(light, { clipExtents: [24, 96, 320], invalidationDelay: 0 });
      node.updateBefore(frameFor(camera));

      // Stream a populated subtree after the first render, with an opaque trunk behind the cutout.
      const loaded = new Group();
      const trunk = caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "pine-trunk@0,0");
      const wide = caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "pine-trunk@*");
      trunk.position.set(20, 12, -48);
      wide.position.copy(trunk.position);
      loaded.add(trunk, wide);
      if (half === "cluster") {
        const secondWide = caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "oak-trunk@*");
        loaded.add(secondWide);
        loaded.add(caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "birch-trunk@*"));
      }
      cells.add(loaded);
      const receiver = caster(scene, 0, "terrain-block");
      receiver.geometry = new BoxGeometry(512, 1, 512);
      receiver.castShadow = false;
      receiver.receiveShadow = true;

      for (const distance of [0, 32, 64]) {
        camera.position.z = -distance;
        loaded.position.y = distance / 8;
        scene.updateMatrixWorld(true);
        node.invalidateAll();
        for (let level = 0; level < 3; level += 1) {
          node.updateBefore(frameFor(camera));
          if (level === 0) continue;
          const coarse = node.stats.perLevel[level];
          expect(coarse?.rendered).toBe(1);
          expect(coarse?.drawsBy[half]).toBe(half === "cluster" ? 2 : 1);
          expect(coarse?.draws).toBe(half === "cluster" ? 2 : 1);
          const shadowLight = node.levelLights[level] as DirectionalLight;
          shadowLight.shadow.updateMatrices(shadowLight);
          const shadowCamera = shadowLight.shadow.camera;
          const frustum = new Frustum().setFromProjectionMatrix(
            new Matrix4().multiplyMatrices(
              shadowCamera.projectionMatrix,
              shadowCamera.matrixWorldInverse,
            ),
          );
          expect(frustum.intersectsObject(half === "cluster" ? trunk : wide)).toBe(true);
          expect(shadowCamera.far).toBeLessThan(1000);
        }
        expect(cutout.castShadow).toBe(true);
      }
      node.dispose();
    },
  );

  it("continues the probe after a mesh with no bounding sphere", () => {
    const { camera, light, scene } = shadowWorld();
    const missing = caster(scene, 0, "missing-bounds");
    vi.spyOn(missing.geometry, "computeBoundingSphere").mockImplementation(() => undefined);
    caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "trunk");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide-1");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide-2");
    scene.updateMatrixWorld(true);
    const node = nodeFor(light);
    node.updateBefore(frameFor(camera));
    expect(node.stats.perLevel[0]?.drawsBy.cluster).toBe(1);
    expect(node.stats.perLevel[0]?.draws).toBe(1);
    node.dispose();
  });

  /** Four casters: one cluster square against two wide meshes, so the cluster half wins the choice,
   *  and one on layer 0, which every level draws and no half decides. */
  function threeCasters(): {
    camera: PerspectiveCamera;
    cluster: Mesh;
    light: DirectionalLight;
    scene: Scene;
  } {
    const { camera, light, scene } = shadowWorld();
    const cluster = caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "cluster");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide-2");
    caster(scene, 0, "terrain");
    scene.updateMatrixWorld(true);
    return { camera, cluster, light, scene };
  }

  it("walks the caster root once for two renders of a world that did not change", () => {
    const { camera, light, scene } = threeCasters();
    const node = nodeFor(light, { invalidationDelay: 0 });
    const walk = vi.spyOn(scene, "traverse");

    node.updateBefore(frameFor(camera));
    expect(node.stats.perLevel[0]?.rendered).toBe(1);
    expect(walk).toHaveBeenCalledTimes(1);

    // The same level again, with nothing in the world touched: an ask, not a change.
    light.shadow.needsUpdate = true;
    node.updateBefore(frameFor(camera));
    expect(node.stats.perLevel[0]?.rendered).toBe(1);
    expect(walk).toHaveBeenCalledTimes(1);
    node.dispose();
  });

  it("walks again when a caster joins the tree, and says the same thing as a fresh walk", () => {
    const { camera, light, scene } = threeCasters();
    const node = nodeFor(light, { invalidationDelay: 0 });
    const walk = vi.spyOn(scene, "traverse");
    node.updateBefore(frameFor(camera));
    const before = report(node);
    expect(walk).toHaveBeenCalledTimes(1);

    caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "second-cluster");
    scene.updateMatrixWorld(true);
    light.shadow.needsUpdate = true;
    node.updateBefore(frameFor(camera));

    // The walk the change asked for, and not another one on the render after it.
    expect(walk).toHaveBeenCalledTimes(2);
    const after = report(node);
    expect(after).not.toEqual(before);
    expect(after).toEqual(reportFromAFreshNode(light, camera));
    node.dispose();
  });

  it("sees a caster that stops casting, without the tree changing", () => {
    const { camera, cluster, light, scene } = threeCasters();
    const node = nodeFor(light, { invalidationDelay: 0 });
    node.updateBefore(frameFor(camera));
    const before = report(node);

    // No add, no remove, so the caster set is the same set of meshes — and the level no longer
    // draws the cluster half, because a mesh that casts nothing is not in either bill.
    cluster.castShadow = false;
    light.shadow.needsUpdate = true;
    node.updateBefore(frameFor(camera));
    const after = report(node);
    expect(after).not.toEqual(before);
    expect(after).toEqual(reportFromAFreshNode(light, camera));
    node.dispose();
  });

  it("sees a caster that moved, without the tree changing", () => {
    const { camera, cluster, light, scene } = threeCasters();
    const node = nodeFor(light, { invalidationDelay: 0 });
    node.updateBefore(frameFor(camera));
    const before = report(node);

    // Raised 36 m: same mesh, same layers, a longer throw and so a deeper window. The world matrix
    // the world sphere was derived from is what the render compares, which is why a memo keyed on
    // anything coarser than this would hand the level a stale depth.
    cluster.position.set(0, 40, 0);
    scene.updateMatrixWorld(true);
    light.shadow.needsUpdate = true;
    node.updateBefore(frameFor(camera));
    const after = report(node);
    expect(after).not.toEqual(before);
    expect(after).toEqual(reportFromAFreshNode(light, camera));
    node.dispose();
  });

  it("drops a caster that leaves the tree", () => {
    const { camera, light, scene } = threeCasters();
    const node = nodeFor(light, { invalidationDelay: 0 });
    node.updateBefore(frameFor(camera));
    const before = report(node);

    scene.remove(scene.getObjectByName("cluster") as Mesh);
    scene.updateMatrixWorld(true);
    light.shadow.needsUpdate = true;
    node.updateBefore(frameFor(camera));
    const after = report(node);
    expect(after).not.toEqual(before);
    expect(after).toEqual(reportFromAFreshNode(light, camera));
    node.dispose();
  });
});

/**
 * PRD-475: a level holds its map until something asks it to redraw, and a caster that leaves or joins
 * the world is something. These three ask for the ask — no `needsUpdate`, no `invalidateAll`, no
 * `invalidateRegion`, nothing but the tree itself changing — because that is exactly what a streamed
 * cell eviction and admission do, and a level that keeps its map across one keeps a ghost shadow of
 * geometry the world no longer holds.
 */
describe("a level and the casters that changed", () => {
  /**
   * Two cluster casters inside the finest window against three wide ones, so the level picks the
   * cluster half and its bill is those two plus the terrain. A change to the casters is then a
   * change in the bill, which is what these three read.
   */
  function twoCasters(): {
    b: Mesh;
    camera: PerspectiveCamera;
    light: DirectionalLight;
    scene: Scene;
  } {
    const { camera, light, scene } = shadowWorld();
    caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "A");
    const b = caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "B");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide-1");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide-2");
    caster(scene, VIRTUAL_SHADOW_WIDE_CASTER_LAYER, "wide-3");
    caster(scene, 0, "terrain");
    scene.updateMatrixWorld(true);
    return { b, camera, light, scene };
  }

  /**
   * Every level mapped and settled, then one frame that asks for nothing and must be served from
   * cache. The finest level's row is returned from the frame it rendered on, since a level that
   * keeps its map reports no draws of its own.
   */
  function settled(
    node: VirtualShadowNode,
    camera: PerspectiveCamera,
    draws = 3,
  ): { draws: number } {
    let row = { draws: 0 };
    for (let frame = 0; frame < 3; frame += 1) {
      node.updateBefore(frameFor(camera));
      if ((node.stats.perLevel[0]?.rendered ?? 0) === 1)
        row = { draws: node.stats.perLevel[0]?.draws ?? 0 };
    }
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ rendered: 0, cached: 2 });
    expect(row.draws).toBe(draws);
    return row;
  }

  it("re-renders and drops a caster that left the tree", () => {
    const { b, camera, light, scene } = twoCasters();
    const node = nodeFor(light);
    settled(node, camera);

    // What a cell eviction is: the parent drops it, and nothing sets a flag anywhere.
    scene.remove(b);
    scene.updateMatrixWorld(true);
    node.updateBefore(frameFor(camera));

    expect(node.stats.perLevel[0]).toMatchObject({ rendered: 1, invalidated: 1 });
    expect(node.stats.perLevel[0]?.draws).toBe(2);
    node.dispose();
  });

  it("re-renders and draws a caster that joined the tree", () => {
    const { camera, light, scene } = twoCasters();
    const node = nodeFor(light);
    settled(node, camera);

    caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "C");
    scene.updateMatrixWorld(true);
    node.updateBefore(frameFor(camera));

    expect(node.stats.perLevel[0]).toMatchObject({ rendered: 1, invalidated: 1 });
    expect(node.stats.perLevel[0]?.draws).toBe(4);
    node.dispose();
  });

  it("re-renders a level a caster only its sphere reaches into", () => {
    const { camera, light, scene } = twoCasters();
    const node = nodeFor(light);

    // A 16 m cube — a 13.86 m sphere — stood so its *centre* is outside the finest window and only
    // its sphere reaches over the edge, which is what a forest straddling a page boundary is. The
    // window is read off the node rather than guessed, so the placement survives a change to the
    // clipmap's own grid: `1.05 × radius` past the edge is inside the sphere's reach and outside
    // half of it, so a box sized by the radius names no level at all while the sphere names this one.
    const edge = caster(scene, VIRTUAL_SHADOW_CASTER_LAYER, "edge");
    edge.geometry = new BoxGeometry(16, 16, 16);
    edge.geometry.computeBoundingSphere();
    const radius = (edge.geometry.boundingSphere as Sphere).radius;
    const window = node.clipmap.getWindow(0);
    const half = node.clipmap.pagesPerAxis / 2;
    const centreU = (window.minX + half) * window.pageWorldSize;
    const centreV = (window.minY + half) * window.pageWorldSize;
    const { x, y, z } = node.clipmap.unproject({
      u: centreU + window.extent + radius * 1.05,
      v: centreV,
      w: 0,
    });
    edge.position.set(x, y, z);
    scene.updateMatrixWorld(true);

    settled(node, camera, 4);

    scene.remove(edge);
    node.updateBefore(frameFor(camera));

    expect(node.stats.perLevel[0]).toMatchObject({ rendered: 1, invalidated: 1 });
    expect(node.stats.perLevel[0]?.draws).toBe(3);
    node.dispose();
  });

  it("re-renders a level whose caster stopped casting", () => {
    const { b, camera, light, scene } = twoCasters();
    const node = nodeFor(light);
    settled(node, camera);

    b.castShadow = false;
    node.updateBefore(frameFor(camera));

    expect(node.stats.perLevel[0]).toMatchObject({ rendered: 1, invalidated: 1 });
    expect(node.stats.perLevel[0]?.draws).toBe(2);
    node.dispose();
  });
});
