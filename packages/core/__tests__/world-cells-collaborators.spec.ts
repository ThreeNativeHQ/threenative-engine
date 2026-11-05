/**
 * PRD-799 phase 1: the collaborator hosts `WorldCells` hands the two split passes.
 *
 * Both passes ask their world many times a frame, so the host is a read surface rather than a
 * snapshot: `parts()` answers with one object for the world's life, and `terrain` on that object is
 * the tiles the constructor builds after the host, so a copied value would read as no terrain at
 * all. The grid answer is fixed for a package's life, so a pass reads it once and never again.
 *
 * The specs capture each host at construction and ask it directly: object identity, the live
 * terrain, and how often the grid is read across passes and readiness scans that are already warm.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
} from "three";
import { describe, expect, it, vi } from "vitest";
import type { ICellReadinessHost } from "../src/world-cell-readiness.js";
import type { ICellResidencyHost } from "../src/world-cell-residency.js";
import { type IWorldCellsLoadOptions, WorldCells } from "../src/world.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");

/** The host object each split pass was constructed with, captured where the world builds it. */
const captured = vi.hoisted((): { readiness?: unknown; residency?: unknown } => ({}));

vi.mock("../src/world-cell-residency.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/world-cell-residency.js")>();
  return {
    ...actual,
    CellResidency: class extends actual.CellResidency {
      constructor(host: ICellResidencyHost) {
        super(host);
        captured.residency = host;
      }
    },
  };
});

vi.mock("../src/world-cell-readiness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/world-cell-readiness.js")>();
  return {
    ...actual,
    CellReadiness: class extends actual.CellReadiness {
      constructor(host: ICellReadinessHost) {
        super(host);
        captured.readiness = host;
      }
    },
  };
});

const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };
const surface = new MeshBasicMaterial();
/** The fixture's cell centre, as the admission spec asks for the same cell. */
const CELL_SIZE = 64;
const ORIGIN = -128;

interface IResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  arrayBuffer: () => Promise<ArrayBuffer>;
  json: () => Promise<unknown>;
}

function fileResponse(buffer: Buffer): IResponseLike {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    json: async () => JSON.parse(buffer.toString("utf8")),
  };
}

function stubFixtureFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<IResponseLike> => {
      const url = String(input);
      if (url.endsWith("world.json"))
        return fileResponse(readFileSync(path.join(fixture, "world.json")));
      if (url.endsWith("placements.bin"))
        return fileResponse(readFileSync(path.join(fixture, "placements.bin")));
      if (url.endsWith("heightmap.u16"))
        return fileResponse(readFileSync(path.join(fixture, "terrain", "heightmap.u16")));
      return {
        ok: false,
        status: 404,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({}),
      };
    }),
  );
}

function model(): Object3D {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

interface IWorldUnderTest {
  readonly follow: { position: { x: number; z: number } };
  readonly world: WorldCells;
}

/** A world over the committed package, with the terrain ring on and the follow point free to move. */
async function makeWorld(options: Partial<IWorldCellsLoadOptions> = {}): Promise<IWorldUnderTest> {
  stubFixtureFetch();
  const follow = { position: { x: 96, z: 96 } };
  const world = await WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    follow,
    freshMeshesPerUpdate: Number.MAX_SAFE_INTEGER,
    gpuScene: false,
    loadModel: async () => model(),
    ring: 4,
    surface,
    url: "/world/world.json",
    ...options,
  });
  new Group().add(world);
  return { follow, world };
}

/** Count the hosts' grid reads: the pass and the readiness scan each keep their own. */
function countExtent(host: { extent(): unknown }): () => number {
  let calls = 0;
  const read = host.extent.bind(host);
  host.extent = () => {
    calls += 1;
    return read();
  };
  return () => calls;
}

describe("the collaborator hosts a split world hands its passes", () => {
  it("answers parts() with one object, whose terrain is the ring built after the host", async () => {
    const { world } = await makeWorld();
    try {
      const host = captured.residency as ICellResidencyHost;
      const parts = host.parts();
      expect(host.parts()).toBe(parts);
      // The tiles are constructed after this host exists, so this only holds for a live read.
      expect(parts.terrain).toBeDefined();
      expect(host.parts().terrain).toBe(parts.terrain);
    } finally {
      world.dispose();
    }
  });

  it("reads the grid once across residency passes, not once per pass", async () => {
    const { follow, world } = await makeWorld();
    try {
      const calls = countExtent(captured.residency as ICellResidencyHost);
      for (let step = 1; step <= 4; step += 1) {
        // Past the half metre that settles a follow point, so every update runs a full pass.
        follow.position.x = step * 32;
        world.update();
      }
      expect(world.stats().residentCells, "passes admitted cells").toBeGreaterThan(0);
      expect(calls(), "grid reads").toBe(1);
    } finally {
      world.dispose();
    }
  });

  it("reads the grid once across readiness scans, not once per cached cell", async () => {
    const { world } = await makeWorld();
    try {
      const at = { x: ORIGIN + 1.5 * CELL_SIZE, z: ORIGIN + 1.5 * CELL_SIZE };
      const camera = new PerspectiveCamera(60, 1, 0.1, 500);
      camera.position.set(at.x, 20, at.z + 200);
      camera.lookAt(at.x, 0, at.z);
      // The first scan warms both the grid and the view cache; the second one answers from them.
      expect(world.readinessAt(camera).requiredCells).toBeGreaterThan(0);
      const calls = countExtent(captured.readiness as ICellReadinessHost);
      expect(world.readinessAt(camera).requiredCells).toBeGreaterThan(0);
      expect(calls(), "grid reads on a cached view").toBe(0);
    } finally {
      world.dispose();
    }
  });
});
