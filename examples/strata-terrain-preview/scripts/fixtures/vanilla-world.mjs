import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const scene = new Scene();
scene.background = new Color(0xa6c5d3);
scene.add(new HemisphereLight(0xd6e9ef, 0x403c2e, 1.2));
const sun = new DirectionalLight(0xffedd4, 2.8);
sun.position.set(-180, 240, 120);
scene.add(sun);
const renderer = new WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 5000);
const gltf = await new GLTFLoader().loadAsync("/world.glb");
scene.add(gltf.scene);
gltf.scene.updateMatrixWorld(true);
const bounds = new Box3().setFromObject(gltf.scene);
const at = bounds.getCenter(new Vector3());
const radius = bounds.getSize(new Vector3()).length() / 2;
camera.position
  .copy(at)
  .add(
    new Vector3(0.7, 0.65, 1).normalize().multiplyScalar((radius / Math.sin(Math.PI / 6)) * 1.1),
  );
camera.lookAt(at);
const placements = [];
const water = [];
let meshes = 0;
let pbrMaps = 0;
let lights = 0;
// The centre pixel of every distinct colour map, so a receiving game can tell which image arrived.
const mapPixels = new Set();
const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
gltf.scene.traverse((object) => {
  if (object.userData.placementId)
    placements.push({ id: object.userData.placementId, matrix: object.matrixWorld.toArray() });
  // A glTF node name cannot carry a colon in three's loader: it strips reserved characters on the
  // way in, so the exported `water:river` arrives as `waterriver`. Matching the prefix is what an
  // ordinary consumer can actually do, so that is what this one does.
  if (typeof object.name === "string" && object.name.startsWith("water"))
    water.push({
      id: object.name.slice("water".length).replace(/^:/, ""),
      triangles:
        (object.geometry.index?.count ?? object.geometry.getAttribute("position").count) / 3,
    });
  if (object.isLight) lights++;
  if (object instanceof Mesh) {
    meshes++;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const image = material.map?.image;
      if (image?.width) {
        probe.canvas.width = image.width;
        probe.canvas.height = image.height;
        probe.drawImage(image, 0, 0);
        mapPixels.add(
          [
            ...probe.getImageData(image.width >> 1, image.height >> 1, 1, 1).data.slice(0, 3),
          ].join(),
        );
      }
      pbrMaps += [material.map, material.normalMap, material.roughnessMap, material.aoMap].filter(
        Boolean,
      ).length;
    }
  }
});
const context = renderer.getContext();
const debug = context.getExtension("WEBGL_debug_renderer_info");
window.portableWorld = {
  meshes,
  placements,
  pbrMaps,
  water,
  lights,
  mapPixels: [...mapPixels],
  cameras: gltf.cameras.length,
  animations: gltf.animations.length,
  frames: 0,
  renderer: "WebGLRenderer",
  adapter: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unknown",
  rootExtras: gltf.scene.children[0]?.userData,
};
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  window.portableWorld.frames++;
});
window.exportConsumerReady = true;
