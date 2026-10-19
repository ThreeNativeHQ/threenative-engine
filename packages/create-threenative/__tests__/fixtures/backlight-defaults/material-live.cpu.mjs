import assert from "node:assert/strict";
import {
  Color,
  DirectionalLight,
  Group,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from "three";
import { backlightMaterial } from "./material.ts";
const scene = new Scene();
const camera = new PerspectiveCamera();
const group = new Group();
const key = new DirectionalLight(0xffeed0, 4.5);
key.position.set(0, 2, -3);
group.add(key);
scene.add(group);
const c = {
  scene,
  camera,
  key,
  rimGain: 0.12,
  fillGain: 1,
  fillColor: new Color(0.1, 0.2, 0.3),
  fillDirection: new Vector3(-1, 1, 1),
  fillAngularSize: 0.7,
  fillAdmitted: false,
};
const m = backlightMaterial(new MeshStandardMaterial({ roughness: 0 }), c);
const numeric = [];
const vectors = [];
const colors = [];
m.emissiveNode.traverse((n) => {
  if (n.isUniformNode && n.updateType === "render") {
    if (typeof n.value === "number") numeric.push(n);
    if (n.value?.isVector3) vectors.push(n);
    if (n.value?.isColor) colors.push(n);
  }
});
assert.ok(numeric.length >= 4);
const update = () => {
  // Simulate the engine boundary, including an unattached target owned by the game.
  scene.updateMatrixWorld(true);
  key.target.updateMatrixWorld(true);
  for (const n of numeric) n.update({ camera });
};
const gains = () => numeric.map((n) => n.value);
update();
assert.ok(gains().includes(4.5));
scene.remove(group);
update();
assert.ok(!gains().includes(4.5));
scene.add(group);
group.visible = false;
update();
assert.ok(!gains().includes(4.5));
group.visible = true;
key.layers.set(2);
update();
assert.ok(!gains().includes(4.5));
key.layers.set(0);
key.position.copy(key.target.position);
update();
assert.ok(!gains().includes(4.5));
assert.ok(vectors.every((n) => n.value.toArray().every(Number.isFinite)));
key.position.set(1e308, 0, 0);
assert.throws(update, /magnitude/);
key.position.set(0, 2, -3);
key.intensity = Number.NaN;
assert.throws(update, /controls/);
key.intensity = 4.5;
c.rimGain = Number.NaN;
assert.throws(update, /controls/);
c.rimGain = 0.12;
c.fillAngularSize = 0;
assert.throws(update, /controls/);
c.fillAngularSize = 0.7;
const old = key.color;
const keyColorNode = colors.find((n) => n.value === old);
assert.ok(keyColorNode);
key.color = new Color(0.2, 0.3, 0.4);
keyColorNode.update({ camera });
assert.equal(keyColorNode.value, key.color);
key.color.r = -1;
assert.throws(update, /controls/);
console.log(
  "PASS live detached/hidden/layer-excluded/coincident key, invalid mutable controls/key, replaced key colour, finite fallback vector. CPU update boundaries only; no shader/GPU admission.",
);
