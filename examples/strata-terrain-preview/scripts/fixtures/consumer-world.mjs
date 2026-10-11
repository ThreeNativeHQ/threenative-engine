// What an ordinary game does with an authored document, in a browser page that only has the packed
// `@threenative/terrain`, `three` and a plain GLTFLoader: re-evaluate the saved recipe, dress it in
// the game's OWN appearance (1x1 stand-in maps, boxes for models, a quad for water), export the whole
// world, and load the file back with the vanilla loader. It imports no editor or server module.
import { Terrain, applyPlacementOverrides, bakeMesh } from "@threenative/terrain";
import { exportWorldGLB } from "@threenative/terrain/export";
import { toGeometry } from "@threenative/terrain/three";
import {
  BoxGeometry,
  BufferAttribute,
  DataTexture,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// 4x4, not 1x1: a game's asset pipeline compresses textures in 4-pixel blocks.
const map = (colour) => {
  const value = new DataTexture(new Uint8Array(4 * 4 * 4).fill(160), 4, 4);
  value.needsUpdate = true;
  if (colour) value.colorSpace = SRGBColorSpace;
  return value;
};

export async function exportAndLoad(document, revision, sampleIndices, withBytes = false) {
  const evaluated = Terrain.fromJSON(document.recipe).evaluate();
  const state = applyPlacementOverrides(evaluated, document.placementOverrides ?? {});
  const geometry = toGeometry(bakeMesh(state));
  geometry.setAttribute("uv", new BufferAttribute(bakeMesh(state).uvs, 2));
  const terrain = new Mesh(
    geometry,
    new MeshStandardMaterial({
      map: map(true),
      normalMap: map(false),
      roughnessMap: map(false),
      aoMap: map(false),
    }),
  );
  const model = new Mesh(new BoxGeometry(1, 4, 1), new MeshStandardMaterial({ color: 0x335522 }));
  const transforms = new Map(
    state.instances.map((item) => {
      const pose = item.transform;
      return [
        item.id,
        new Matrix4().compose(
          new Vector3(...(pose ? pose.position : item.position)),
          pose
            ? new Quaternion(...pose.quaternion)
            : new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), item.rotation),
          pose ? new Vector3(...pose.scale) : new Vector3().setScalar(item.scale),
        ),
      ];
    }),
  );
  const water = [...state.waters.map((w) => w.id), ...state.rivers.map((r) => r.id)].map((id) => ({
    id,
    object: new Mesh(new PlaneGeometry(8, 8), new MeshStandardMaterial({ color: 0x336688 })),
    time: 0,
    staleFrames: 0,
  }));
  const output = await exportWorldGLB({
    revision,
    snapshotTime: 0,
    state,
    terrain,
    assets: new Map(state.instances.map((item) => [item.asset, model])),
    transforms,
    water,
  });
  const bytes = output.bytes.slice().buffer;
  const gltf = await new Promise((resolve, reject) =>
    new GLTFLoader().parse(bytes, "", resolve, reject),
  );
  gltf.scene.updateMatrixWorld(true);
  const json = gltf.parser.json;
  let loadedTerrain;
  const placements = [];
  const waterIds = [];
  let meshes = 0;
  gltf.scene.traverse((object) => {
    if (object.isMesh) meshes++;
    if (object.userData.placementId)
      placements.push({
        id: object.userData.placementId,
        asset: object.userData.assetId,
        grounding: object.userData.grounding,
        matrix: object.matrixWorld.toArray(),
        expected: transforms.get(object.userData.placementId)?.toArray(),
      });
    if (object.name === "terrain")
      object.traverse((o) => {
        if (o.isMesh) loadedTerrain = o;
      });
    if (object.name.startsWith("water")) waterIds.push(object.name.replace(/^water:?/, ""));
  });
  const position = loadedTerrain.geometry.getAttribute("position");
  const base64 = withBytes
    ? await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.readAsDataURL(new Blob([output.bytes]));
      })
    : undefined;
  return {
    glbBase64: base64,
    heights: withBytes ? Array.from(state.height) : undefined,
    report: output.report,
    glbBytes: output.bytes.length,
    resolution: state.resolution,
    size: state.size,
    stateHeights: sampleIndices.map((i) => state.height[i]),
    loadedHeights: sampleIndices.map((i) => position.getY(i)),
    heightCount: position.count,
    placements,
    waterIds,
    meshes,
    images: (json.images ?? []).length,
    externalUris: [...(json.images ?? []), ...(json.buffers ?? [])].filter((e) => e.uri).length,
    cameras: gltf.cameras.length,
    rootExtras: gltf.scene.children[0]?.userData,
    // The page proves it never held an authoring surface: no editor global, no stored editor state.
    editorGlobals: Object.keys(globalThis).filter((key) => /strata|terrainEditor/iu.test(key)),
    storedKeys: Object.keys(localStorage),
  };
}
