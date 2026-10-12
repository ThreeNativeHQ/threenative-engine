// Served by the editor's own Vite server, so it can read the live view; everything it reports about
// the exported file comes from loading that file with a plain GLTFLoader, not from the view.
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export async function readBack(sampleIndices) {
  const state = window.strata.state;
  const live = {
    heights: sampleIndices.map((i) => state.height[i]),
    props: window.strata.view.inspectProps().map(({ id, transform }) => ({ id, ...transform })),
  };
  const output = await window.strata.view.exportCurrentWorld();
  const gltf = await new Promise((resolve, reject) =>
    new GLTFLoader().parse(output.bytes.slice().buffer, "", resolve, reject),
  );
  gltf.scene.updateMatrixWorld(true);
  let terrain;
  const placements = [];
  gltf.scene.traverse((object) => {
    if (object.userData.placementId)
      placements.push({ id: object.userData.placementId, matrix: object.matrixWorld.toArray() });
    if (object.name === "terrain")
      object.traverse((o) => {
        if (o.isMesh) terrain = o;
      });
  });
  const position = terrain.geometry.getAttribute("position");
  return {
    revision: output.report.revision,
    waterIds: output.report.waterIds,
    glbHeights: sampleIndices.map((i) => position.getY(i)),
    placements,
    live,
    resolution: state.resolution,
    size: state.size,
  };
}
