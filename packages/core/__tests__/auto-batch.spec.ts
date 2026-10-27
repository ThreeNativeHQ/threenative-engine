import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { AUTO_BATCH_MARKER, AutoBatch, isAutoBatchMerged } from "../src/auto-batch.js";
import { Registry } from "../src/entities.js";
import { ScenePicker } from "../src/picking.js";
import { type IViewportSize, Viewport } from "../src/viewport.js";
import { warmUpScene } from "../src/warmup.js";

/** Meshes the renderer would walk: every visible mesh still in the graph. */
function draws(scene: Scene): number {
  let count = 0;
  scene.traverseVisible((object) => {
    if ((object as Mesh).isMesh === true) count += 1;
  });
  return count;
}

const grey = new MeshStandardMaterial({ color: 0x888888, name: "grey" });
const red = new MeshStandardMaterial({ color: 0xaa2222, name: "red" });

/** A row of boxes, each its own geometry (a procedural town), alternating two materials. */
function town(count: number, parent: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  for (let at = 0; at < count; at += 1) {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), at % 2 === 0 ? grey : red);
    mesh.position.set(at * 2, 0.5, 0);
    parent.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

function run(batch: AutoBatch, frames: number): void {
  for (let frame = 0; frame < frames; frame += 1) batch.update();
}

function stubRenderer(canvas: HTMLCanvasElement = testCanvas()) {
  return {
    canvas,
    compileAsync: async () => undefined,
    compute: () => undefined,
    domElement: canvas,
    info: {},
    kind: "webgl2" as const,
    raw: {},
    render: () => undefined,
    readback: async () => new ArrayBuffer(0),
    renderOverlay: () => undefined,
    setOutputNode: () => undefined,
    setSize: () => undefined,
    gpuFrameMs: () => undefined,
    resolveGpuFrame: () => undefined,
    setResolutionScale: () => undefined,
    surface: () => ({
      atFloor: false,
      drawingBufferHeight: 1,
      drawingBufferWidth: 1,
      resolutionScale: 1,
      sampleCount: 1,
      scaleSource: "pinned" as const,
    }),
    dispose: () => undefined,
  };
}

function testCanvas(width = 1280, height = 720): HTMLCanvasElement & { size: IViewportSize } {
  const canvas = new EventTarget() as HTMLCanvasElement & { size: IViewportSize };
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, get: () => canvas.size.height },
    clientWidth: { configurable: true, get: () => canvas.size.width },
  });
  canvas.size = { aspect: width / height, height, width };
  return canvas;
}

describe("AutoBatch", () => {
  it("merges static meshes that share a material into one draw each, with nothing called by the game", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    town(40, group);
    const lines: string[] = [];
    const batch = new AutoBatch(scene, { settleFrames: 3, report: (line) => lines.push(line) });
    expect(draws(scene)).toBe(40);
    run(batch, 8);
    expect(draws(scene)).toBe(2);
    expect(lines.some((line) => line.startsWith(`${AUTO_BATCH_MARKER}:`))).toBe(true);
    expect(batch.census).toMatchObject({ meshes: 40, draws: 2, optedOut: 0, restored: 0 });
  });

  it("keeps an opted-out subtree separate and reports it", () => {
    const scene = new Scene();
    const group = new Group();
    const kept = new Group();
    kept.userData.batch = "off";
    scene.add(group, kept);
    town(10, group);
    town(6, kept);
    const batch = new AutoBatch(scene, { settleFrames: 3 });
    run(batch, 8);
    expect(draws(scene)).toBe(2 + 6);
    expect(batch.census.optedOut).toBe(6);
  });

  it("leaves a mesh that moves while the scene settles out of the merge", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    const meshes = town(10, group);
    const spinner = meshes[0] as Mesh;
    const batch = new AutoBatch(scene, { settleFrames: 4 });
    for (let frame = 0; frame < 8; frame += 1) {
      spinner.position.y += 0.1;
      spinner.updateMatrixWorld(true);
      batch.update();
    }
    expect(spinner.visible).toBe(true);
    expect(draws(scene)).toBe(1 + 2);
    expect(batch.census.unsettled).toBe(1);
  });

  it("hides each source, keeps it in the graph, and gives it back when the game moves it", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    const meshes = town(10, group);
    const batch = new AutoBatch(scene, { settleFrames: 3 });
    run(batch, 8);
    const plate = meshes[4] as Mesh;
    // Still the game's object in the game's place, so rays and `userData` keep answering from it.
    expect(plate.parent).toBe(group);
    expect(plate.visible).toBe(false);
    const merged = scene.children.find((child) => isAutoBatchMerged(child)) as Mesh;
    const position = merged.geometry.getAttribute("position");
    const before = Array.from(position.array as Float32Array).filter((value) => value !== 0).length;
    plate.position.y = -3;
    batch.update();
    expect(plate.visible).toBe(true);
    expect(batch.census.restored).toBe(1);
    expect(draws(scene)).toBe(3);
    // Its 24 vertices collapsed to the origin, so the merged mesh no longer draws it.
    const after = Array.from(position.array as Float32Array).filter((value) => value !== 0).length;
    expect(before - after).toBeGreaterThan(0);
  });

  it("answers a scene ray from the authored mesh, never from the merged one", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    const meshes = town(10, group);
    const batch = new AutoBatch(scene, { settleFrames: 3 });
    run(batch, 8);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const picker = new ScenePicker({
      camera,
      pointer: () => new Vector2(0, 0),
      scene,
      viewport: new Viewport({ camera, renderer: stubRenderer() }),
    });
    const hit = picker.raycast({
      origin: new Vector3(8, 0.5, 5),
      direction: new Vector3(0, 0, -1),
    });
    expect(hit?.object).toBe(meshes[4]);
  });

  it("answers a targeted ray with the farther target, not the nearer merged neighbour", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    const meshes = town(10, group);
    const batch = new AutoBatch(scene, { settleFrames: 3 });
    run(batch, 8);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const picker = new ScenePicker({
      camera,
      pointer: () => new Vector2(0, 0),
      scene,
      viewport: new Viewport({ camera, renderer: stubRenderer() }),
    });
    const ray = { origin: new Vector3(-5, 0.5, 0), direction: new Vector3(1, 0, 0) };
    const target = meshes[6] as Mesh;
    const hit = picker.raycast({ ...ray, targets: [target] });
    expect(hit?.object).toBe(target);
    expect(hit?.face?.normal.x).toBeCloseTo(-1);
    expect(picker.raycast({ ...ray, targets: [target], exclude: target })).toBeUndefined();
    expect(picker.raycast(ray)?.object).toBe(meshes[0]);
    expect(picker.raycastAll(ray).map((each) => each.object)).toContain(meshes[9]);
  });

  it("gives a source back when the game removes it from the scene", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    const meshes = town(10, group);
    const batch = new AutoBatch(scene, { settleFrames: 3 });
    run(batch, 8);
    const gone = meshes[2] as Mesh;
    gone.removeFromParent();
    batch.update();
    expect(batch.census.restored).toBe(1);
    expect(draws(scene)).toBe(2);
  });

  it("gives a subtree back when an ancestor moves", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    const meshes = town(10, group);
    const batch = new AutoBatch(scene, { settleFrames: 3 });
    run(batch, 8);
    expect(draws(scene)).toBe(2);
    group.position.x = 5;
    batch.update();
    expect(meshes.every((mesh) => mesh.visible)).toBe(true);
    expect(draws(scene)).toBe(10);
  });

  // The shooter turns matrixAutoUpdate off on its town pieces to keep their sight boxes. The guard
  // then stamped a piece's matrix into its shared buffer and read that tail back as the town
  // group's own, so the group "moved" and every source under it came back (8307 on the shooter).
  it("keeps a still parent merged when its children hold their own matrices", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    const pieces = town(12, group);
    group.updateMatrixWorld(true);
    for (const piece of pieces) piece.matrixAutoUpdate = false;
    const batch = new AutoBatch(scene, { settleFrames: 3, guard: "everyFrame" });
    run(batch, 20);
    expect(batch.census).toMatchObject({ meshes: 12, draws: 2, restored: 0 });
    expect(draws(scene)).toBe(2);
  });

  it("keeps a mesh a game entity holds out of the merge, and reports it", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    const meshes = town(10, group);
    const entities = new Registry();
    entities.add("plate", { parts: { plate: meshes[3] } });
    const batch = new AutoBatch(scene, { entities, settleFrames: 3 });
    run(batch, 8);
    expect(meshes[3]?.visible).toBe(true);
    expect(draws(scene)).toBe(1 + 2);
    expect(batch.census.heldByEntities).toBe(1);
  });

  it("merges at once on settleNow, before any frame has run", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    const meshes = town(10, group);
    const batch = new AutoBatch(scene, { settleFrames: 3 });
    batch.settleNow();
    expect(draws(scene)).toBe(2);
    // The scene did not change shape, so the frame loop starts no second pass over it.
    run(batch, 8);
    expect(draws(scene)).toBe(2);
    meshes[1]?.position.setY(4);
    batch.update();
    expect(batch.census.restored).toBe(1);
  });

  it("checks every source each frame on request", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    town(10, group);
    const exact = new AutoBatch(scene, { guard: "everyFrame", settleFrames: 3 });
    run(exact, 8);
    expect(exact.census.guardStaleFrames).toBe(1);
  });

  it("counts a merged mesh in the warm-up, not the hidden sources it replaced", async () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    town(10, group);
    const batch = new AutoBatch(scene, { settleFrames: 3 });
    run(batch, 8);
    const report = await warmUpScene({} as never, scene, {} as never, {
      granularity: "object",
      includeHidden: true,
    });
    expect(report.candidates).toBe(2);
  });

  it("reads no children list on a still frame, and still merges what the game adds later", () => {
    // On the native engine every `children` read wraps each child across the bridge: the shooter
    // town's 8,000 meshes cost 10 ms a frame when the pass polled the scene's shape.
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    town(10, group);
    const batch = new AutoBatch(scene, { settleFrames: 3 });
    run(batch, 8);
    expect(batch.census.meshes).toBe(10);
    let reads = 0;
    const watched = [scene, ...scene.children];
    for (const node of watched) {
      const list = node.children;
      Object.defineProperty(node, "children", {
        configurable: true,
        get: () => {
          reads += 1;
          return list;
        },
      });
    }
    run(batch, 20);
    expect(reads).toBe(0);
    for (const node of watched) {
      const list = node.children;
      Object.defineProperty(node, "children", { configurable: true, writable: true, value: list });
    }
    town(4, group);
    run(batch, 8);
    expect(batch.census.meshes).toBe(14);
  });

  it("does nothing when disabled, and says so", () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    town(10, group);
    const lines: string[] = [];
    const batch = new AutoBatch(scene, {
      enabled: false,
      settleFrames: 3,
      report: (line) => lines.push(line),
    });
    run(batch, 8);
    expect(draws(scene)).toBe(10);
    expect(lines.join("\n")).toContain('"enabled":false');
  });
});
