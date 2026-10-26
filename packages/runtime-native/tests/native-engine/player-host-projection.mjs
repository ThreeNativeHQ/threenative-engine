// PRD-573 v1.11 step 3 on the V8 player: core's SceneRenderProjection with the host seam (the native renderer batches the
// authored scene) against the same scene through core's JS mirror (`renderer.projection: "js"`), both drawn by the real
// player into a render target (headless GPU) and compared pixel by pixel. The scene holds the classes the host must not
// get wrong: per-instance colours, shadow casters and receivers, a transparent mesh, render order, hidden objects, skinned
// rigs, a sprite, an LOD, a line and a BatchedMesh. A second scene carries an onBeforeRender hook, which both paths decline.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-host-projection.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-host-projection-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const projectionModule = resolve(native, "../core/src/renderProjection.ts");

const entry = resolve(work, "game.ts");
const outfile = resolve(work, "game.js");
await writeFile(entry, `
import {
  AmbientLight, BatchedMesh, BoxGeometry, BufferGeometry, Bone, Color, DirectionalLight, DoubleSide, Float32BufferAttribute,
  Group, InstancedMesh, LOD, Line, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry,
  RenderTarget, Scene, Skeleton, SkinnedMesh, SphereGeometry, Sprite, SpriteMaterial, UnsignedByteType, Vector3,
} from "three";
import { WebGPURenderer } from "three/webgpu";
import { SceneRenderProjection } from ${JSON.stringify(projectionModule)};

const WIDTH = 320;
const HEIGHT = 180;

function skinned(count, geometry, material) {
  const rigs = [];
  for (let index = 0; index < count; index += 1) {
    const root = new Bone();
    const tip = new Bone();
    tip.position.y = 1;
    root.add(tip);
    const rig = new SkinnedMesh(geometry, material);
    rig.add(root);
    rig.bind(new Skeleton([root, tip]));
    rig.position.set(-9 + index * 3.2, 0.2, 7);
    rig.castShadow = true;
    tip.rotation.z = 0.15 * (index + 1);
    rigs.push(rig);
  }
  return rigs;
}

let hookCalls = 0;

function build(withHook, withBatched) {
  const scene = new Scene();
  scene.add(new AmbientLight(0xffffff, 0.5));
  const sun = new DirectionalLight(0xffffff, 2);
  sun.position.set(8, 16, 10);
  sun.castShadow = true;
  sun.shadow.camera.left = -16;
  sun.shadow.camera.right = 16;
  sun.shadow.camera.top = 16;
  sun.shadow.camera.bottom = -16;
  sun.shadow.camera.far = 60;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);
  const floor = new Mesh(new PlaneGeometry(40, 30), new MeshStandardMaterial({ color: 0x606870 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Per-instance colour: one geometry, three materials that differ only in base colour (the uniform lane).
  const box = new BoxGeometry(0.8, 0.8, 0.8);
  const palette = [0xd04030, 0x30c050, 0x3050d0].map((color) => new MeshStandardMaterial({ color, roughness: 0.6 }));
  const cubes = [];
  for (let index = 0; index < 300; index += 1) {
    const cube = new Mesh(box, palette[index % 3]);
    cube.position.set(-11 + (index % 20) * 1.15, 0.4 + (index % 7) * 0.05, -8 + Math.floor(index / 20) * 1.1);
    cube.castShadow = true;
    cube.receiveShadow = index % 2 === 0;
    scene.add(cube);
    cubes.push(cube);
  }
  // Exact-lane objects: too few to batch, transparent, ordered, hidden, and a hidden subtree.
  const ball = new SphereGeometry(0.5, 16, 12);
  const ballMaterial = new MeshStandardMaterial({ color: 0xe0c040, metalness: 0.4, roughness: 0.3 });
  for (let index = 0; index < 3; index += 1) {
    const sphere = new Mesh(ball, ballMaterial);
    sphere.position.set(-4 + index * 1.5, 1.4, 3);
    sphere.castShadow = true;
    scene.add(sphere);
  }
  const glass = new Mesh(box, new MeshStandardMaterial({ color: 0x80c0ff, transparent: true, opacity: 0.5 }));
  glass.position.set(3, 0.8, 3);
  scene.add(glass);
  const ordered = new Mesh(box, new MeshBasicMaterial({ color: 0xff00ff }));
  ordered.renderOrder = 5;
  ordered.position.set(5, 0.5, 3);
  scene.add(ordered);
  const hidden = new Mesh(box, palette[0]);
  hidden.visible = false;
  hidden.position.set(0, 3, 0);
  scene.add(hidden);
  const hiddenGroup = new Group();
  hiddenGroup.visible = false;
  hiddenGroup.add(new Mesh(box, palette[1]));
  scene.add(hiddenGroup);

  // What the native scene holds besides meshes.
  const rigs = skinned(6, (() => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-0.3, 0, 0, 0.3, 0, 0, -0.3, 2, 0, 0.3, 2, 0], 3));
    geometry.setAttribute("normal", new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    geometry.setAttribute("skinIndex", new Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    geometry.setAttribute("skinWeight", new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    return geometry;
  })(), new MeshStandardMaterial({ color: 0xc08040, side: DoubleSide }));
  for (const rig of rigs) scene.add(rig);
  const sprite = new Sprite(new SpriteMaterial({ color: 0x40ffd0 }));
  sprite.position.set(7, 2, 2);
  sprite.scale.set(1.5, 1.5, 1);
  scene.add(sprite);
  const lod = new LOD();
  lod.addLevel(new Mesh(ball, new MeshStandardMaterial({ color: 0xff8040 })), 0);
  lod.addLevel(new Mesh(box, new MeshStandardMaterial({ color: 0x4080ff })), 40);
  lod.position.set(-7, 1, 3);
  scene.add(lod);
  const lineGeometry = new BufferGeometry();
  lineGeometry.setAttribute("position", new Float32BufferAttribute([-10, 0.05, 6, 10, 0.05, 6, 10, 3, 6], 3));
  const line = new Line(lineGeometry, new LineBasicMaterial({ color: 0xffffff }));
  scene.add(line);
  const batched = new BatchedMesh(4, 64, 64, new MeshStandardMaterial({ color: 0xffffff }));
  const shape = batched.addGeometry(new BoxGeometry(0.6, 0.6, 0.6));
  [[0, 0.3, 4.5, 0xff4040], [1, 0.3, 4.5, 0x40ff40]].forEach(([x, y, z, color], slot) => {
    const id = batched.addInstance(shape);
    batched.setMatrixAt(id, new Matrix4().makeTranslation(9 + x * 1.2, y, z));
    batched.setColorAt(id, new Color(color));
  });
  if (withBatched) scene.add(batched);
  if (withHook) cubes[0].onBeforeRender = () => { hookCalls += 1; };
  // An authored InstancedMesh: the mirror's stand-in shares its instanceMatrix (copySpecializedState), so a
  // setMatrixAt after the mirror is built moves what both paths draw.
  const instanced = new InstancedMesh(box, new MeshStandardMaterial({ color: 0xffe080 }), 3);
  for (let index = 0; index < 3; index += 1) instanced.setMatrixAt(index, new Matrix4().makeTranslation(-2 + index * 2, 0.6, 5));
  scene.add(instanced);
  return { cubes, hidden, instanced, scene };
}

const camera = new PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 200);
camera.position.set(0, 13, 20);
camera.lookAt(0, 0, 1);
camera.updateMatrixWorld(true);

const renderer = new WebGPURenderer({ canvas: { width: WIDTH, height: HEIGHT } });
renderer.setClearColor(0x101820, 1);
renderer.shadowMap.enabled = true;

const waiting = [];
const nextTick = () => new Promise((resolve) => waiting.push(resolve));
const progress = (phase, details = {}) => globalThis.tn.log("HOST_PROJECTION_PROGRESS " + JSON.stringify({ phase, ...details, atMs: Date.now() }));

/** The draw list the player submits for a root on its own frame: three's renderer.info.render, a frame behind. */
async function frameDraws(root, label) {
  const startedAt = Date.now();
  progress("frame-draws-start", { label });
  globalThis.tn.scene = root;
  globalThis.tn.camera = camera;
  for (let index = 0; index < 4; index += 1) await nextTick();
  const info = globalThis.tn.renderInfo();
  progress("frame-draws-complete", { label, elapsedMs: Date.now() - startedAt });
  return { draws: info.drawCalls, triangles: info.triangles };
}

async function draw(root, label, frame) {
  const startedAt = Date.now();
  progress("draw-start", { label, frame });
  const target = new RenderTarget(WIDTH, HEIGHT, { type: UnsignedByteType });
  renderer.setRenderTarget(target);
  renderer.render(root, camera);
  renderer.setRenderTarget(null);
  progress("render-complete", { label, frame, elapsedMs: Date.now() - startedAt });
  const readbackStartedAt = Date.now();
  progress("readback-start", { label, frame });
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT);
  progress("readback-complete", { label, frame, elapsedMs: Date.now() - readbackStartedAt });
  const copy = Uint8Array.from(pixels);
  target.dispose();
  return copy;
}

function compare(a, b) {
  let sum = 0;
  let max = 0;
  let over = 0;
  let lit = 0;
  for (let index = 0; index < a.length; index += 4) {
    let pixelMax = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(a[index + channel] - b[index + channel]);
      sum += delta;
      pixelMax = Math.max(pixelMax, delta);
    }
    max = Math.max(max, pixelMax);
    if (pixelMax > 8) over += 1;
    if (a[index] + a[index + 1] + a[index + 2] > 90) lit += 1;
  }
  return { lit, max, mean: sum / (a.length / 4 * 3), over };
}

async function check(label, withHook, withBatched) {
  const startedAt = Date.now();
  progress("check-start", { label });
  const { cubes, hidden, instanced, scene } = build(withHook, withBatched);
  const host = new SceneRenderProjection(scene, { onReport: () => {} });
  const mirror = new SceneRenderProjection(scene, { onReport: () => {}, projection: "js" });
  const results = [];
  const hooks = { host: 0, mirror: 0 };
  let control;
  let lists;
  for (let frame = 0; frame < 3; frame += 1) {
    if (frame === 1) {
      // Moved, hidden and shown objects, and a recoloured instance, between the frames.
      for (let index = 0; index < cubes.length; index += 7) cubes[index].position.y += 0.6;
      hidden.visible = true;
      cubes[11].visible = false;
      cubes[12].material = cubes[13].material;
      instanced.setMatrixAt(1, new Matrix4().makeTranslation(0, 2.4, 5));
      instanced.instanceMatrix.needsUpdate = true;
    }
    if (frame === 2) {
      for (const cube of cubes) cube.rotation.y += 0.4;
      cubes[20].castShadow = false;
    }
    scene.updateMatrixWorld(true);
    host.reconcile();
    mirror.reconcile();
    if (host.root !== scene) throw new Error(label + ": the host path built a mirror");
    if (mirror.root === scene && !withHook && !withBatched) throw new Error(label + ": the forced mirror did not project: " + mirror.report.reasonCode + " " + (mirror.report.reason ?? ""));
    let before = hookCalls;
    const hostPixels = await draw(host.root, label + ":host", frame);
    hooks.host += hookCalls - before;
    before = hookCalls;
    const mirrorPixels = await draw(mirror.root, label + ":mirror", frame);
    hooks.mirror += hookCalls - before;
    results.push({ frame, ...compare(mirrorPixels, hostPixels) });
    if (frame === 2) {
      // The instrument has to be able to fail: the mirror's last picture against the host's after a cube moves.
      cubes[3].position.x += 3;
      scene.updateMatrixWorld(true);
      host.reconcile();
      control = compare(mirrorPixels, await draw(host.root, label + ":control", frame));
      cubes[3].position.x -= 3;
      scene.updateMatrixWorld(true);
      host.reconcile();
      lists = { host: await frameDraws(host.root, label + ":host"), mirror: await frameDraws(mirror.root, label + ":mirror") };
    }
  }
  const hostReport = host.report;
  const mirrorReport = mirror.report;
  progress("check-complete", { label, elapsedMs: Date.now() - startedAt });
  return {
    label,
    control,
    lists,
    hooks,
    results,
    host: { path: hostReport.path, reasonCode: hostReport.reasonCode, projecting: hostReport.projecting, sourceRenderables: hostReport.sourceRenderables, projectedObjects: hostReport.projectedObjects },
    mirror: { path: mirrorReport.path, pathOverridden: mirrorReport.pathOverridden, reasonCode: mirrorReport.reasonCode, projecting: mirrorReport.projecting, projectedObjects: mirrorReport.projectedObjects },
  };
}

let ticks = 0;
globalThis.tn.onUpdate(() => {
  ticks += 1;
  for (const resolve of waiting.splice(0)) resolve();
  if (ticks === 1) { globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); }
  if (ticks !== 10) return;
  (async () => {
    progress("comparison-start", { tick: ticks });
    const report = [await check("mixed", false, false), await check("batched", false, true), await check("hook", true, false)];
    progress("comparison-complete", { tick: ticks });
    globalThis.tn.log("HOST_PROJECTION_RESULT " + JSON.stringify(report));
  })().catch((error) => globalThis.tn.log("HOST_PROJECTION_ERROR " + (error && error.stack || error)));
});
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy" };
delete env.TN_PLAYTEST_MAILBOX_ROOT;
const child = spawn(resolve(executable), [outfile], { env });
let output = "";
const verdict = await new Promise((done) => {
  const timer = setTimeout(() => done("timeout"), 120_000);
  const read = (chunk) => {
    output += chunk;
    const match = output.match(/HOST_PROJECTION_(RESULT [^\n]*|ERROR[^\n]*)/u);
    if (match) {
      clearTimeout(timer);
      done(match[0]);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.once("exit", () => {
    clearTimeout(timer);
    done(output.match(/HOST_PROJECTION_(RESULT [^\n]*|ERROR[^\n]*)/u)?.[0] ?? "exited");
  });
});
child.kill();
assert(verdict.startsWith("HOST_PROJECTION_RESULT "), `${verdict}\n${output.slice(-3000)}`);
const [mixed, batched, hook] = JSON.parse(verdict.slice("HOST_PROJECTION_RESULT ".length));
for (const scene of [mixed, batched, hook]) {
  for (const result of scene.results)
    console.log(`${scene.label} frame ${result.frame}: ${result.lit} lit pixels, mean |delta| ${result.mean.toFixed(4)} /255, max ${result.max}, ${result.over} pixels over 8`);
}
assert(mixed.control.over > 20 && mixed.control.mean > 0.01, `the comparison cannot see a moved cube: ${JSON.stringify(mixed.control)}`);
console.log(`control (a cube moved after the mirror's frame): mean |delta| ${mixed.control.mean.toFixed(4)}, ${mixed.control.over} pixels over 8`);
console.log(`draw list on the player's own frame: host ${JSON.stringify(mixed.lists.host)}, mirror ${JSON.stringify(mixed.lists.mirror)}`);
assert(mixed.lists.host.draws > 0 && mixed.lists.host.draws <= mixed.lists.mirror.draws, "the host draws no more than the mirror does");
// The host path is the native renderer's own batching of the authored scene; the mirror is core's. The same picture.
assert.equal(mixed.host.path, "host");
assert.equal(mixed.host.reasonCode, "hostProjected");
assert.equal(mixed.mirror.path, "js");
assert.equal(mixed.mirror.pathOverridden, true);
assert.equal(mixed.mirror.reasonCode, "projected");
// An authored BatchedMesh makes the mirror give the whole frame back (it cannot reproduce the sub-draws); the native
// renderer draws it as it is and still batches around it.
assert.equal(batched.mirror.reasonCode, "unsupportedObject");
assert.equal(batched.host.reasonCode, "hostProjected");
assert.equal(hook.host.projecting, false, "a render hook is declined by the host path too");
assert.equal(hook.host.reasonCode, "renderHook");
// core's mirror looks for an own `onBeforeRender` property, which a native object does not carry, so it projects and the
// hook never runs; the native renderer calls it for every drawn frame.
assert.equal(hook.hooks.host, 3, "the host path runs the authored hook once a frame");
assert.equal(hook.hooks.mirror, 0, "the engine mirror loses a native object's hook");
for (const scene of [mixed, batched, hook])
  for (const result of scene.results) {
    assert(result.lit > 3000, `${scene.label} frame ${result.frame} drew almost nothing (${result.lit} lit pixels)`);
    assert(result.mean < 0.5, `${scene.label} frame ${result.frame}: mean |delta| ${result.mean}`);
    assert(result.over < 40, `${scene.label} frame ${result.frame}: ${result.over} pixels differ by more than 8/255`);
  }
console.log("PASS the host projection draws the pictures the JS mirror draws");
