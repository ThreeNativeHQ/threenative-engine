import assert from "node:assert/strict";
import {
  Camera,
  Color,
  DirectionalLight,
  MeshStandardMaterial,
  Scene,
  Texture,
  Vector3,
} from "three";
import type Node from "three/src/nodes/core/Node.js";
import NodeFrame from "three/src/nodes/core/NodeFrame.js";
import { test } from "vitest";
type LiveNode = Node & { value: unknown };
import { backlightMaterial } from "../templates/starter/src/render/backlightMaterial.js";
test("shared full graph preserves live render boundaries and independent material ownership", () => {
  const scene = new Scene();
  const camera = new Camera();
  const key = new DirectionalLight();
  scene.add(key);
  key.position.set(1, 2, 3);
  scene.updateMatrixWorld(true);
  const controls = {
    scene,
    camera,
    key,
    rimGain: 0.12,
    fillGain: 1,
    fillColor: new Color(0.2, 0.3, 0.4),
    fillDirection: new Vector3(0, 1, 0),
    fillAngularSize: 1.25,
    fillAdmitted: true,
  };
  const first = new MeshStandardMaterial({ color: 0xff0000, emissive: 0x112233 });
  const second = new MeshStandardMaterial({ color: 0x00ff00, emissive: 0x334455 });
  const borrowedMap = new Texture();
  first.map = borrowedMap;
  let mapDisposals = 0;
  borrowedMap.addEventListener("dispose", () => {
    mapDisposals += 1;
  });
  const a = backlightMaterial(first, controls);
  const b = backlightMaterial(second, controls);
  assert.equal(a.emissiveNode, b.emissiveNode, "same controls must share the complete graph");
  assert.notEqual(a.color, b.color);
  assert.equal(a.color.getHex(), first.color.getHex());
  assert.equal(b.emissive.getHex(), second.emissive.getHex());
  assert.notEqual(
    backlightMaterial(first, { ...controls }).emissiveNode,
    a.emissiveNode,
    "independent controllers must not share",
  );
  const nodes = new Set<LiveNode>();
  assert.ok(a.emissiveNode);
  a.emissiveNode.traverse((n) => {
    if (n.getUpdateType() === "render") nodes.add(n as LiveNode);
  });
  assert.equal(nodes.size, 8);
  let calls = 0;
  for (const n of nodes) {
    const update = n.update.bind(n);
    n.update = (frame: NodeFrame) => {
      calls++;
      return update(frame);
    };
  }
  const frame = new NodeFrame();
  frame.renderId = 1;
  for (const material of [a, b]) {
    assert.ok(material.emissiveNode);
    material.emissiveNode.traverse((n) => {
      if (nodes.has(n as LiveNode)) frame.updateNode(n);
    });
  }
  assert.equal(calls, 8);
  controls.fillDirection.set(1, 0, 0);
  key.position.set(-2, 0, 0);
  scene.updateMatrixWorld(true);
  controls.rimGain = 0.4;
  controls.fillAdmitted = false;
  key.color = new Color(0.7, 0.6, 0.5);
  key.intensity = 2;
  frame.renderId = 2;
  for (const n of nodes) frame.updateNode(n);
  assert.equal(calls, 16);
  assert.ok([...nodes].some((n) => n.value === controls.fillDirection));
  assert.ok(
    [...nodes].some(
      (n) =>
        n.value instanceof Vector3 &&
        n.value !== controls.fillDirection &&
        n.value.equals(new Vector3(-1, 0, 0)),
    ),
  );
  assert.ok([...nodes].some((n) => n.value === 0.4));
  assert.ok([...nodes].some((n) => n.value === key.color));
  assert.ok([...nodes].some((n) => n.value === 2));
  const matrices = key.matrixWorld.elements.slice();
  scene.remove(key);
  frame.renderId = 3;
  for (const n of nodes) frame.updateNode(n);
  assert.ok(![...nodes].some((n) => n.value === 2));
  assert.deepEqual(key.matrixWorld.elements, matrices);
  scene.add(key);
  camera.layers.set(2);
  frame.renderId = 4;
  for (const n of nodes) frame.updateNode(n);
  assert.ok(![...nodes].some((n) => n.value === 2));
  camera.layers.set(0);
  const secondFrame = new NodeFrame();
  secondFrame.renderId = 4;
  for (const n of nodes) secondFrame.updateNode(n);
  assert.equal(calls, 40, "independent renderer frames must update shared nodes");
  controls.rimGain = Number.NaN;
  secondFrame.renderId = 5;
  const firstNode = [...nodes][0];
  assert.ok(firstNode);
  assert.throws(() => secondFrame.updateNode(firstNode), /finite/);
  assert.equal(a.map, borrowedMap);
  a.dispose();
  assert.equal(mapDisposals, 0);
  assert.equal(first.map, borrowedMap);
  assert.equal(b.emissiveNode, a.emissiveNode);
  controls.rimGain = 0.12;
  secondFrame.renderId = 6;
  for (const n of nodes) secondFrame.updateNode(n);
});

test("shared graph follows the actual render camera and live key layers within one frame", () => {
  const scene = new Scene();
  const key = new DirectionalLight(0xffffff, 2);
  key.position.set(0, 2, -3);
  scene.add(key);
  scene.updateMatrixWorld(true);
  const ownerCamera = new Camera();
  const renderCamera = new Camera();
  renderCamera.layers.set(1);
  const controls = {
    scene,
    camera: ownerCamera,
    key,
    rimGain: 0.12,
    fillGain: 1,
    fillColor: new Color(0.2, 0.3, 0.4),
    fillDirection: new Vector3(0, 1, 0),
    fillAngularSize: 1.25,
    fillAdmitted: false,
  };
  const material = backlightMaterial(new MeshStandardMaterial(), controls);
  const nodes = new Set<LiveNode>();
  material.emissiveNode?.traverse((node) => {
    if (node.getUpdateType() === "render") nodes.add(node as LiveNode);
  });
  const frame = new NodeFrame();
  frame.frameId = 7;
  const render = (camera: Camera, renderId: number) => {
    frame.camera = camera;
    frame.renderId = renderId;
    for (const node of nodes) frame.updateNode(node);
    return [...nodes].some((node) => node.value === 2);
  };
  assert.equal(render(renderCamera, 1), false, "actual camera excludes the key");
  ownerCamera.layers.set(1);
  assert.equal(render(new Camera(), 2), true, "actual camera admits the key despite owner layers");
  key.layers.set(1);
  assert.equal(render(new Camera(), 3), false, "live key layers remove its contribution");
  assert.equal(render(renderCamera, 4), true, "second camera admits the changed key layers");
  assert.equal(frame.frameId, 7, "all camera renders belong to one frame");
  material.dispose();
});
