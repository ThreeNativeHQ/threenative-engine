import { WorldCells } from "../../../../core/src/world-cells.ts";
import { assertCondition, startVisualScene, THREE } from "./scene-support.js";

/**
 * Runtime companion to the asset-cook HLOD fixture: one hand-placed chunk and its measured proxy
 * use the same world-v1 contract, while the loader returns the decoded meshes in both targets.
 * This intentionally proves lifecycle and representation ownership, not cooked-map performance.
 */
const MANIFEST = {
  version: 1,
  extent: { minX: -16, minZ: -16, sizeX: 32, sizeZ: 32 },
  cellSize: 32,
  placements: "placements.bin",
  terrain: {
    heightmap: "height.u16",
    columns: 2,
    rows: 2,
    spacing: 32,
    heightMin: 0,
    heightMax: 1,
  },
  assets: {},
  cells: [
    {
      x: 0,
      z: 0,
      runs: [],
      chunks: ["chunk.glb"],
      proxy: {
        glb: "proxy.glb",
        scope: "chunks",
        error: 0.1,
        triangles: 2,
        materialGroups: 1,
      },
    },
  ],
};

function decodedModel(proxy) {
  const root = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: 0x4f824c });
  const mesh = new THREE.Mesh(
    proxy ? new THREE.PlaneGeometry(4, 4) : new THREE.BoxGeometry(4, 1, 4),
    material,
  );
  mesh.name = proxy ? "hlod-proxy-detail" : "hlod-source-detail";
  if (proxy) mesh.rotation.x = -Math.PI / 2;
  root.add(mesh);
  if (!proxy) {
    const collision = new THREE.Object3D();
    collision.name = "hlod-collision-sentinel";
    collision.userData.tnCollision = true;
    root.add(collision);
  }
  return root;
}

function census(world, stage) {
  const stats = world.stats();
  let proxyMeshes = 0;
  let proxyVisible = 0;
  let sourceMeshes = 0;
  let sourceVisible = 0;
  let shadowCasters = 0;
  let collision = false;
  world.traverse((node) => {
    if (node.name === "hlod-collision-sentinel") collision = node.parent !== null;
    if (node.isMesh !== true) return;
    const proxy = node.name === "hlod-proxy-detail" || node.name.startsWith("world-cell-proxy:");
    if (proxy) {
      proxyMeshes += 1;
      if (node.visible && (node.geometry.drawRange.count ?? 0) > 0) proxyVisible += 1;
    } else if (node.layers.isEnabled(0)) {
      sourceMeshes += 1;
      if (node.visible) sourceVisible += 1;
    }
    if (node.castShadow && !node.layers.isEnabled(0)) shadowCasters += 1;
  });
  const line =
    `TN_WORLD_HLOD_CONFORMANCE stage=${stage} resident=${String(stats.residentCells)} ` +
    `loaded=${String(stats.hlod.loaded)} compiled=${String(stats.hlod.compiled)} ` +
    `observed=${String(stats.hlod.observed)} active=${String(stats.hlod.active)} ` +
    `pending=${String(stats.hlod.pending)} bytes=${String(stats.hlod.bytes)} ` +
    `sourceMeshes=${String(sourceMeshes)} sourceVisible=${String(sourceVisible)} ` +
    `proxyMeshes=${String(proxyMeshes)} proxyVisible=${String(proxyVisible)} ` +
    `shadowCasters=${String(shadowCasters)} collision=${String(collision)} ` +
    `refused=${String(stats.hlod.refused)} failures=${String(stats.hlod.failures)}`;
  return { collision, line, proxyVisible, shadowCasters, sourceMeshes, sourceVisible, stats };
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "world-hlod-lifecycle",
    async ({ camera, renderer, scene }) => {
      const follow = new THREE.Object3D();
      const world = await WorldCells.load({
        url: "/world/world.json",
        surface: new THREE.MeshBasicMaterial({ color: 0x415a43 }),
        follow,
        ring: 0,
        budgets: { bytes: 32 * 1024 * 1024, instances: 1, residentCells: 1 },
        terrain: false,
        gpuScene: false,
        bundles: false,
        shadows: { cast: true, receive: true },
        data: { manifest: MANIFEST, placements: new ArrayBuffer(0) },
        loadModel: async (url) => decodedModel(url.endsWith("proxy.glb")),
      });
      scene.add(world);
      const proofAnchor = new THREE.Mesh(
        new THREE.SphereGeometry(8, 16, 8),
        new THREE.MeshBasicMaterial({ color: 0xd69e2e }),
      );
      scene.add(proofAnchor);
      const proofDirection = new THREE.Vector3();

      const detail = {
        active: false,
        collisionRetained: false,
        evicted: false,
        nearRestored: false,
        shadowCovered: false,
      };
      let stage = "far";
      let lastStage = "";
      let lastCensus = "";
      const emit = (name) => {
        const result = census(world, name);
        if (result.line !== lastCensus) {
          lastCensus = result.line;
          console.info(result.line);
        }
        return result;
      };
      const observe = () => {
        const result = emit(stage);
        if (stage === "far" && result.stats.hlod.active > 0) {
          assertCondition(result.sourceVisible === 0, "HLOD proxy active while source detail is visible");
          assertCondition(result.proxyVisible === 1, "HLOD proxy is active without a visible proxy draw");
          assertCondition(result.shadowCasters > 0, "HLOD proxy removed source shadow coverage");
          assertCondition(result.collision, "HLOD proxy removed source collision sentinel");
          detail.active = true;
          detail.collisionRetained = result.collision;
          detail.shadowCovered = result.shadowCasters > 0;
          stage = "near";
          camera.position.set(0, 2, 1.5);
          camera.lookAt(0, 0, 0);
        } else if (stage === "near" && result.stats.hlod.active === 0) {
          assertCondition(result.sourceVisible > 0, "near HLOD restoration did not show source detail");
          detail.nearRestored = true;
          stage = "evict";
          follow.position.set(1000, 0, 1000);
          camera.position.set(1000, 2, 1000);
          camera.lookAt(1000, 0, 1000);
        } else if (stage === "evict" && result.stats.residentCells === 0) {
          assertCondition(result.stats.hlod.bytes === 0, "evicted HLOD resources remain charged");
          detail.evicted = true;
          stage = "done";
        }
        if (lastStage !== stage) {
          lastStage = stage;
          emit(stage);
        }
        const conformance = globalThis.__TN_CONFORMANCE;
        if (conformance !== undefined) conformance.detail = { ...detail, stage };
      };
      return {
        detail,
        render() {
          world.update(renderer, camera);
          camera.getWorldDirection(proofDirection);
          proofAnchor.position.copy(camera.position).addScaledVector(proofDirection, 20);
          renderer.render(scene, camera);
          if (stage !== "done") observe();
        },
      };
    },
    {
      background: 0x101820,
      camera: (size) => {
        const camera = new THREE.PerspectiveCamera(55, size.width / size.height, 0.1, 2000);
        camera.position.set(0, 3, 600);
        camera.lookAt(0, 0, 0);
        return camera;
      },
    },
  );
}
