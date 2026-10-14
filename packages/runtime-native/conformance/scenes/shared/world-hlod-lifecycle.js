import { WorldCells } from "../../../../core/src/world-cells.ts";
import { DiscreteLodPlugin, TN_DISCRETE_LOD, isLodJoinProxy, updateModelLods } from "../../../../core/src/model-lod.ts";
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
  assets: { scatter: { glb: "scatter.glb", lods: [], bounds: { min: [-1, -1, -1], max: [1, 1, 1] } } },
  cells: [
    {
      x: 0,
      z: 0,
      runs: [{ asset: "scatter", count: 1, offset: 0 }],
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

async function decodedModel(proxy) {
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
    const sibling = mesh.clone();
    sibling.geometry = mesh.geometry.clone();
    root.add(sibling);
    const members = [mesh, sibling];
    const associations = new Map([[root, { meshes: 0, nodes: 0 }]]);
    members.forEach((member, index) => associations.set(member, { meshes: 0, nodes: 0, primitives: index }));
    const definition = {
      absoluteErrors: [0.01], counts: [6], errors: [0.01], indices: [0], lod0Triangles: 12,
      schemaVersion: 1, sharedVertexBuffers: true, strategy: "discrete",
    };
    const plugin = new DiscreteLodPlugin();
    plugin.setParser({
      associations,
      getDependency: async (type) => {
        if (type !== "mesh") return { array: mesh.geometry.index.array.slice(0, 18) };
        const joined = new THREE.Group();
        const joinedMesh = new THREE.Mesh(mesh.geometry.clone(), material);
        joinedMesh.name = "hlod-source-joined";
        joined.add(joinedMesh);
        return joined;
      },
      json: {
        extensions: { [TN_DISCRETE_LOD]: { joined: [{ draws: 1, error: 0.01, mesh: "chunk__lod_join", primitives: 2, sources: ["chunk#0", "chunk#1"], triangles: 12 }] } },
        meshes: [
          { name: "chunk", primitives: members.map(() => ({ extensions: { [TN_DISCRETE_LOD]: definition } })) },
          { name: "chunk__lod_join", primitives: [{}] },
        ],
      },
    });
    await plugin.afterRoot({ scene: root });
    plugin.attach(root, { hysteresis: 0.15, maxPixelError: 1 });
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
  let joined = 0;
  let scatter = 0;
  world.traverse((node) => {
    if (node.name === "hlod-collision-sentinel") collision = node.parent !== null;
    if (node.isMesh !== true) return;
    if (isLodJoinProxy(node)) joined += 1;
    if (node.isInstancedMesh === true && node.layers.isEnabled(0) && node.count > 0) scatter += 1;
    const proxy = node.name === "hlod-proxy-detail" || node.name.startsWith("world-cell-proxy:");
    if (proxy) {
      proxyMeshes += 1;
      if (node.visible && (node.geometry.drawRange.count ?? 0) > 0) proxyVisible += 1;
    } else if (node.layers.isEnabled(0) && node.isInstancedMesh !== true) {
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
    `gpu=${String(stats.gpuScene.on)} joined=${String(joined)} scatter=${String(scatter)} ` +
    `refused=${String(stats.hlod.refused)} failures=${String(stats.hlod.failures)}`;
  return { collision, joined, line, proxyVisible, scatter, shadowCasters, sourceMeshes, sourceVisible, stats };
}

export async function startScene(canvas, dimensions) {
  const state = await startVisualScene(
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
        budgets: { bytes: 32 * 1024 * 1024, instances: 16, residentCells: 1 },
        terrain: false,
        gpuScene: true,
        bundles: false,
        shadows: { cast: true, receive: true },
        data: { manifest: MANIFEST, placements: new Float32Array([6, 0, 0, 0, 0, 0, 1, 1]).buffer },
        loadModel: async (url) => {
          if (!url.endsWith("scatter.glb")) return decodedModel(url.endsWith("proxy.glb"));
          const root = new THREE.Group();
          root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x4f824c })));
          return root;
        },
      });
      const worldRenderer = {
        compileAsync: (object, view) => renderer.compileAsync(object, view),
        compute: (nodes) => renderer.compute(nodes),
        domElement: renderer.domElement,
        info: renderer.info,
        kind: "webgpu",
        raw: renderer,
        readback: async (attribute, target) => {
          const result = await renderer.getArrayBufferAsync(attribute, target);
          assertCondition(result === target && target.buffer instanceof ArrayBuffer, "HLOD GPU readback lost its owned target");
          return target.buffer.slice(0);
        },
      };
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
        gpu: false,
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
          // The GPU scene is on where the backend has compute and indirect draws, and the CPU path
          // carries the same scatter where it has not (the Android emulator's software GPU).
          assertCondition(result.scatter > 0, "chunk HLOD removed scatter");
          detail.gpu = result.stats.gpuScene.on;
          assertCondition(result.joined > 0, "chunk HLOD did not coexist with an active AutoLOD join");
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
        get census() {
          return `stage=${stage} ${lastCensus}`;
        },
        render() {
          updateModelLods(world, camera, dimensions.height);
          world.update(worldRenderer, camera);
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
  // The harness may open native startup readiness as soon as startScene resolves. Keep both
  // targets behind the lifecycle proof, rather than letting a merely initialized scene pass.
  // The wait is wall-clock, not frames: this loop spins far faster than the renderer draws (181,582
  // loop turns in one Android emulator run). 30 s sits inside the harness's 45 s native budget.
  const startedAt = performance.now();
  await new Promise((resolve, reject) => {
    let frames = 0;
    const check = () => {
      const proof = state.subject.detail;
      if (proof.active && proof.nearRestored && proof.shadowCovered && proof.collisionRetained && proof.evicted) {
        console.info(
          `TN_WORLD_HLOD_CONFORMANCE_COMPLETE gpu=${String(proof.gpu)} joined=true sourceShadow=true near=true evicted=true collisionAttachment=true`,
        );
        resolve();
      } else if (++frames >= 180 && performance.now() - startedAt >= 30_000) {
        reject(
          new Error(
            `World HLOD lifecycle did not complete before capture: ${JSON.stringify(proof)} ` +
              `after ${String(frames)} frames, ${state.subject.census}`,
          ),
        );
      } else requestAnimationFrame(check);
    };
    check();
  });
  return state;
}
