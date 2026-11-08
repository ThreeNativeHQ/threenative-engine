import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  Frustum,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CellRender } from "../src/world-cell-render.js";
import { localClip, localPoint } from "../src/world-root-frame.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

/**
 * The world's records live in the root's own frame; the camera lives in world space.
 *
 * `WorldCells` is an `Object3D`, so a game is free to place it — `world.position.y = -11.45` puts the
 * whole ring 11.45 m below the origin and every placement, box and GPU record with it, still written
 * in the package's own coordinates. Every per-frame read that compares the two therefore has to be
 * taken in the root's frame, or a moved root culls and grades from a camera that is not where the
 * world is drawn: the eye is metres off the ground its levels are measured against, and a cell whose
 * placements are in the view is thrown out of it.
 *
 * The two reads here are the ones a frame cannot get wrong:
 *
 * - the LOD eye, which levels and `maxDistance` are graded from, and which the GPU dispatch also
 *   measures from (`updateLodEye`), and
 * - the main-pass frustum, whose verdict is the window each main batch narrows itself to.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;

const surface = new MeshBasicMaterial();
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };
/** The fixture's `cellSize`. */
const CELL = 64;
/** The move the whole file is about: a game sinking its root below the origin. */
const DROP = -11.45;
/** The first `pine` record of each cell's run, from the package. */
const PINE = new Map<string, number>();
for (const cell of manifest.cells)
  for (const run of cell.runs)
    if (run.asset === "pine") PINE.set(`${String(cell.x)},${String(cell.z)}`, run.offset);

/** The world-space centre of cell `(x, z)`, from the package's own extent and cell size. */
function cellCentre(x: number, z: number): { x: number; z: number } {
  return { x: manifest.extent.minX + (x + 0.5) * CELL, z: manifest.extent.minZ + (z + 0.5) * CELL };
}

function plainModel(): Group {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

function fileResponse(buffer: Buffer): object {
  return {
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    headers: new Headers(),
    json: async () => JSON.parse(buffer.toString("utf8")),
    ok: true,
    status: 200,
  };
}

/**
 * The package with `pine`'s authored `lods` removed, so every one of its placements is drawn at
 * level 0 and a square's worth of a key is exactly the count its run states.
 */
function packageOf(): IWorldPackage {
  const pine = manifest.assets.pine;
  if (pine === undefined) throw new Error("the committed package has no pine asset.");
  return {
    ...manifest,
    assets: { ...manifest.assets, pine: { bounds: pine.bounds, glb: pine.glb } },
  };
}

function stubManifestFetch(): void {
  const pkg = packageOf();
  const body = JSON.stringify(pkg);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<object> => {
      const url = String(input);
      if (url.endsWith("world.json"))
        return {
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
          headers: new Headers(),
          json: async () => pkg,
          ok: true,
          status: 200,
        };
      if (url.endsWith("placements.bin"))
        return fileResponse(readFileSync(path.join(fixture, "placements.bin")));
      if (url.endsWith("heightmap.u16"))
        return fileResponse(readFileSync(path.join(fixture, "terrain", "heightmap.u16")));
      return {
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers(),
        ok: false,
        status: 404,
      };
    }),
  );
}

const placements = readFileSync(path.join(fixture, "placements.bin"));

/** The instance matrix one placement record composes into, which is the whole of an instance. */
function placementMatrix(index: number): Matrix4 {
  const at = index * 32;
  const scale = placements.readFloatLE(at + 28);
  return new Matrix4().compose(
    new Vector3(
      placements.readFloatLE(at),
      placements.readFloatLE(at + 4),
      placements.readFloatLE(at + 8),
    ),
    new Quaternion(
      placements.readFloatLE(at + 12),
      placements.readFloatLE(at + 16),
      placements.readFloatLE(at + 20),
      placements.readFloatLE(at + 24),
    ),
    new Vector3(scale, scale, scale),
  );
}

/** Whether the drawn window holds this exact placement, wherever in it. */
function draws(mesh: InstancedMesh, cell: string, placement = 0): boolean {
  const offset = PINE.get(cell);
  if (offset === undefined) throw new Error(`the committed package has no pine run in ${cell}.`);
  const wanted = placementMatrix(offset + placement).elements[12] as number;
  const matrix = new Matrix4();
  for (let index = 0; index < mesh.count; index += 1) {
    mesh.getMatrixAt(index, matrix);
    if (Math.abs((matrix.elements[12] as number) - wanted) < 1e-3) return true;
  }
  return false;
}

/**
 * Every placement's own reach, at `Infinity`: the world grades levels in 3D, which is the case where
 * the eye's height is a number a frame reads — a 2D world pins it to the ground plane by design.
 */
function infiniteReach(): Float32Array {
  const reach = new Float32Array(placements.byteLength / 32);
  reach.fill(Number.POSITIVE_INFINITY);
  return reach;
}

async function loadWorld(
  follow: { position: { x: number; y: number; z: number } },
  reach?: Float32Array,
): Promise<WorldCells> {
  return WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    // Off, because this file's subject is the coarse per-key window: a bundled mesh is never hidden
    // again, so a record — not `mesh.count` — is what decides what a frame draws.
    bundles: false,
    follow,
    ...(reach === undefined ? {} : { placementReach: reach }),
    loadModel: async () => plainModel(),
    prefetchSeconds: 0,
    ring: 1,
    surface,
    url: "/world/world.json",
  });
}

/** The `pine` level-0 main mesh: one per key, the one every camera here draws. */
function mainMesh(world: WorldCells): InstancedMesh {
  const found: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh && object.name === "pine:0:0") found.push(object);
  });
  const mesh = found[0];
  if (mesh === undefined) throw new Error("the world has no pine:0:0 mesh.");
  return mesh;
}

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Let the loads settle, then step again: a build waiting on the frame's mesh allowance is deferred. */
async function flushed(world: WorldCells): Promise<void> {
  for (let pass = 0; pass < 200; pass += 1) {
    await flush();
    world.update();
    const stats = world.stats();
    if (
      stats.admission.backlog === 0 &&
      stats.admission.deferred === 0 &&
      stats.loadsInFlight === 0
    )
      return;
  }
}

/**
 * A level camera standing at `height` above the root's own ground, looking along +X.
 *
 * The camera is a player in world space; the heights here are given against the root's local ground
 * so the world's own origin (`-11.45`, or a level's own drop) is the caller's to choose.
 */
function levelCamera(height: number, fov = 30): PerspectiveCamera {
  const centre = cellCentre(0, 1);
  const camera = new PerspectiveCamera(fov, 1, 0.1, 1000);
  camera.position.set(centre.x, height, centre.z);
  camera.lookAt(centre.x + CELL * 10, height, centre.z);
  camera.updateMatrixWorld();
  return camera;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the root's own frame", () => {
  it("is exactly projection × view when the root has not moved", () => {
    const camera = levelCamera(4);
    const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // The identity root is the common case and skips the multiply, so the numbers are the ones the
    // clip matrix always had, and the point is returned untouched.
    expect(localClip(new Matrix4(), camera, new Matrix4()).elements).toEqual(view.elements);
    const eye = new Vector3(1, 2, 3);
    expect(localPoint(eye, new Matrix4())).toBe(eye);
    expect(eye.toArray()).toEqual([1, 2, 3]);
  });

  it("keeps a placement in the view that a world-frame frustum drops", () => {
    // A 2° camera 4 m over the ground the root puts at -11.45, and a tree on that ground 10 m ahead:
    // in the root's frame it is on the camera's own axis; in the world's it is 11.45 m above it.
    const camera = new PerspectiveCamera(2, 1, 0.1, 1000);
    camera.position.set(0, DROP + 4, 0);
    camera.lookAt(10, DROP + 4, 0);
    camera.updateMatrixWorld();
    const root = new Matrix4().makeTranslation(0, DROP, 0);
    const tree = new Vector3(10, 4, 0);
    const inRoot = new Frustum().setFromProjectionMatrix(localClip(new Matrix4(), camera, root));
    const inWorld = new Frustum().setFromProjectionMatrix(
      localClip(new Matrix4(), camera, undefined),
    );
    expect(inRoot.containsPoint(tree)).toBe(true);
    expect(inWorld.containsPoint(tree)).toBe(false);
    // And the eye the kernel measures levels from is the camera read locally.
    expect(
      localPoint(new Vector3().setFromMatrixPosition(camera.matrixWorld), root).toArray(),
    ).toEqual([0, 4, 0]);
  });

  it("reads a root that is placed, turned and scaled, not only one that is moved", () => {
    const camera = levelCamera(4);
    const root = new Matrix4().compose(
      new Vector3(4, 8, -3),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 5),
      new Vector3(2, 2, 2),
    );
    const expected = new Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(root);
    const clip = localClip(new Matrix4(), camera, root);
    for (const [at, element] of expected.elements.entries())
      expect(clip.elements[at]).toBeCloseTo(element, 10);
    // A world point read in the root's frame and put back through the root is the point it was.
    const local = localPoint(new Vector3(1, 2, 3), root);
    const back = local.clone().applyMatrix4(root);
    for (const [at, value] of [1, 2, 3].entries())
      expect(back.getComponent(at)).toBeCloseTo(value, 10);
  });
});

describe("WorldCells reads its root's own frame", () => {
  it("grades levels from the camera in the root's frame, not the world's", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: DROP } };
    const eye = vi.spyOn(CellRender.prototype, "updateLodEye");
    const world = await loadWorld(follow, infiniteReach());
    // The game moved the whole world down; the ground the eye grades against is the root's own.
    world.position.y = DROP;
    world.updateMatrixWorld(true);

    // A camera four metres over that ground, and inside the package's one 60 m gate of the follow
    // point, so the eye is the follow point itself: local y 0, whatever the root's offset is.
    world.update(undefined, levelCamera(DROP + 4));
    const graded = eye.mock.calls.at(-1) as [number, number, number];
    expect(graded[1]).toBeCloseTo(0, 4);

    // And the same with no move at all: an unmoved root is the frame this always was.
    follow.position.y = 0;
    world.position.y = 0;
    world.updateMatrixWorld(true);
    world.update(undefined, levelCamera(4));
    expect((eye.mock.calls.at(-1) as [number, number, number])[1]).toBeCloseTo(0, 4);
    world.dispose();
  });

  it("keeps a square the root-frame frustum covers when the root is moved", async () => {
    stubManifestFetch();
    // The volume the cull tests is one 64 m cell widened by 8 m of pad (`MAIN_CULL_PAD_METRES`), so
    // this root is moved far enough that a world-frame frustum is unambiguously under it: the frame
    // is the subject, not the number.
    const DEEP = -60;
    const follow = { position: { ...cellCentre(0, 1), y: 0 } };
    const world = await loadWorld(follow);
    world.update();
    await flushed(world);
    const mesh = mainMesh(world);

    // A camera standing on the world's own ground and looking along +X: the squares its frustum
    // covers, and the one in front of it holding trees.
    world.update(undefined, levelCamera(0));
    const unmoved = mesh.count;
    expect(draws(mesh, "1,1")).toBe(true);

    // The same world, the same local camera, drawn 60 m lower by a game that moved its root. The
    // window is the same squares: the frustum moved with the placements, not with the origin.
    follow.position.y = DEEP;
    world.position.y = DEEP;
    world.updateMatrixWorld(true);
    world.update(undefined, levelCamera(DEEP));
    expect(mesh.count).toBe(unmoved);
    expect(draws(mesh, "1,1")).toBe(true);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });
});
