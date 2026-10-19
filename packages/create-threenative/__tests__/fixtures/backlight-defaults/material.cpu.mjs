// CPU conversion fidelity only; a constructed TSL graph is not GPU/visual/native proof.
import assert from "node:assert/strict";
import {
  Color,
  DirectionalLight,
  DoubleSide,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3,
} from "three";
import { backlightMaterial } from "./material.ts";
const source = new MeshStandardMaterial({
  color: 0x345678,
  metalness: 0.8,
  roughness: 0.65,
  emissive: 0x101820,
  emissiveIntensity: 2.5,
  transparent: true,
  opacity: 0.7,
  side: DoubleSide,
});
source.map = new Texture();
source.normalMap = new Texture();
source.emissiveMap = new Texture();
const key = new DirectionalLight(0xffeed0, 2.5);
const scene = new Scene();
scene.add(key);
const controls = {
  key,
  scene,
  camera: new PerspectiveCamera(),
  rimGain: 0.1,
  fillGain: 0.2,
  fillColor: new Color(0x405060),
  fillDirection: new Vector3(0, 1, 0),
  fillAngularSize: 0.3,
  fillAdmitted: false,
};
const converted = backlightMaterial(source, controls);
for (const name of [
  "metalness",
  "roughness",
  "emissiveIntensity",
  "transparent",
  "opacity",
  "side",
])
  assert.equal(converted[name], source[name], name);
for (const name of ["color", "emissive"]) assert.ok(converted[name].equals(source[name]), name);
for (const name of ["map", "normalMap", "emissiveMap"])
  assert.equal(converted[name], source[name], name);
assert.ok(converted.emissiveNode);
assert.equal(converted.vertexNode, null);
assert.equal(converted.normalNode, null);
assert.throws(() => backlightMaterial(new MeshPhysicalMaterial(), controls), /Physical\/custom/);
const custom = new MeshStandardMaterial();
custom.onBeforeCompile = () => {};
assert.throws(() => backlightMaterial(custom, controls), /Physical\/custom/);
assert.throws(
  () => backlightMaterial(source, { ...controls, fillDirection: new Vector3() }),
  /controls/,
);
console.log(
  "PASS standard property/map/emissive fidelity, default vertex/normal paths, unsupported material/direction refusal; no GPU or skinning execution claimed.",
);
