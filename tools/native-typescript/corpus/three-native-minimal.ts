import { struct, vec3 } from "three/tsl";
import {
  BoxGeometry,
  DataTexture,
  DirectionalLight,
  Float32BufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  Scene,
  WebGPURenderer,
} from "three/webgpu";

const scene = new Scene();
const material = new MeshBasicNodeMaterial();
const Sample = struct({ colour: "vec3", weight: "float" }, "Sample");
const colorNode = Sample({ colour: vec3(0.25, 0.5, 0.75), weight: 1 }).get("colour");
material.colorNode = colorNode;
const mesh = new Mesh(new BoxGeometry(2, 2, 0.1), material);
scene.add(mesh, new DirectionalLight(0xffffff, 1));
const camera = new OrthographicCamera(-1.5, 1.5, 1.125, -1.125, 0.1, 10);
camera.position.z = 3;
const attribute = new Float32BufferAttribute([1, 2, 3], 3);
if (attribute.array.join(",") !== "1,2,3") throw new Error("TN_CORPUS_ATTRIBUTE");
console.log("scene", scene.children.length);
console.log("position", mesh.position.x, mesh.position.y, mesh.position.z);
console.log("shader", material.colorNode === colorNode ? "node" : "missing");
// The facade's DataTexture is a function constructor over a captured engine class.
const texture = new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
console.log("texture", texture.image.width, texture.image.height);

export async function render(): Promise<void> {
  let calls = 0;
  mesh.onBeforeRender = () => {
    ++calls;
  };
  const renderer = new WebGPURenderer();
  if (renderer.getClearAlpha() !== 1) throw new Error("TN_CORPUS_CLEAR_ALPHA");
  renderer.setClearColor(0x000000, 0);
  renderer.setClearAlpha(1);
  renderer.setSize(320, 240);
  await renderer.init();
  renderer.render(scene, camera);
  if (calls !== 1) throw new Error(`TN_CORPUS_CALLBACK: ${calls}`);
  mesh.onBeforeRender = null as never;
  renderer.dispose();
}

if (process.env.TN_TSL_FRAME) render();
