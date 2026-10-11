import { Terrain } from "@threenative/terrain";
import {
  type ISpatialReference,
  TerrainEditorController,
  inspectSpatial,
  probeTerrain,
} from "@threenative/terrain/editor";
import { TerrainEditorDocument, terrainEditor } from "@threenative/terrain/editor/server";
import { type ViteDevServer, createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const servers: ViteDevServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const GRADE_X = 0.05;
const GRADE_Z = 0.12;
const plane = (x: number, z: number) => 3 + GRADE_X * x + GRADE_Z * z;
const planeSlope = Math.atan(Math.hypot(GRADE_X, GRADE_Z)) * (180 / Math.PI);
const planeAspect = (Math.atan2(-GRADE_X, GRADE_Z) * (180 / Math.PI) + 360) % 360;

/** A plane with an exact analytic answer plus one curved stamp, so bilinear and triangle differ. */
function asymmetric() {
  const size = 128;
  const resolution = 65;
  const values: number[] = [];
  for (let z = 0; z < resolution; z++)
    for (let x = 0; x < resolution; x++)
      values.push(plane((x / (resolution - 1) - 0.5) * size, (z / (resolution - 1) - 0.5) * size));
  return new Terrain({ size, resolution, seed: 73 })
    .heightmap({ id: "tilt", data: { width: resolution, height: resolution, values } })
    .stamp({
      id: "bump",
      shape: "dune",
      at: [18, -14],
      radius: [22, 14],
      amplitude: 9,
      roughness: 0.8,
    })
    .toJSON();
}

async function api(document: unknown) {
  const root = makeTempDirSync("terrain-spatial-");
  const path = `${root}/world.json`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify(document));
  const editor = terrainEditor({ documentPath: path });
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      editor,
      {
        // The project supplies its editor page; this fixture tests the real middleware.
        name: "test-editor-page",
        configureServer(vite: ViteDevServer) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== "/terrain-editor/") return next();
            res.setHeader("content-type", "text/html");
            res.end("<html data-terrain-editor>Project editor</html>");
          });
        },
      },
    ],
  });
  servers.push(server);
  await server.listen();
  const activation = await editor.activate();
  const controller = new TerrainEditorController(activation.editorUrl);
  const inspect = async (query: unknown, baseRevision: string) => {
    const response = await fetch(new URL("inspect", controller.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision, query }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { path, controller, inspect, snapshot: () => controller.snapshot() };
}

/** Two fit controls plus one independent checkpoint displaced exactly 5 m, from a synthetic 0.5 m/px, 30° map. */
function syntheticMap(): ISpatialReference {
  const truth = (u: number, v: number): [number, number] => {
    const angle = (30 * Math.PI) / 180;
    return [
      0.5 * (u * Math.cos(angle) - v * Math.sin(angle)) + 40,
      0.5 * (u * Math.sin(angle) + v * Math.cos(angle)) - 25,
    ];
  };
  const displaced = truth(260, 380);
  return {
    id: "survey",
    kind: "top-down-map",
    hash: "a".repeat(64),
    source: "synthetic survey sheet",
    datum: null,
    toleranceMetres: 1,
    controls: [
      { id: "c1", image: [100, 100], world: truth(100, 100) },
      { id: "c2", image: [400, 260], world: truth(400, 260) },
    ],
    checkpoint: { id: "c3", image: [260, 380], world: [displaced[0] + 5, displaced[1]] },
  };
}

describe("embedded spatial inspection", () => {
  it("recovers exact point height, slope and aspect and separates bilinear from triangle values", () => {
    const terrain = Terrain.fromJSON(asymmetric());
    const state = terrain.evaluate();
    const revision = "b".repeat(64);
    const flat = probeTerrain(state, revision, [-40, 30]);
    expect(flat.revision).toBe(revision);
    expect(flat.units).toBe("metres");
    expect(flat.resolution).toBe(state.resolution);
    expect(flat.at).toEqual([-40, 30]);
    expect(flat.bilinear.height).toBeCloseTo(plane(-40, 30), 2);
    expect(flat.triangle.height).toBeCloseTo(plane(-40, 30), 2);
    expect(flat.bilinear.slopeDeg).toBeCloseTo(planeSlope, 1);
    expect(flat.triangle.slopeDeg).toBeCloseTo(planeSlope, 1);
    expect(flat.bilinear.aspectDeg).toBeCloseTo(planeAspect, 1);
    expect(flat.triangle.aspectDeg).toBeCloseTo(planeAspect, 1);
    expect(flat.datum).toBeNull();
    expect(flat.labels).toContain("unknown-datum");
    expect(Math.abs(flat.bilinear.height - plane(-40, 30))).toBeLessThanOrEqual(0.01);
    expect(Math.abs(flat.bilinear.slopeDeg - planeSlope)).toBeLessThanOrEqual(0.1);

    // Off-grid inside the dune, where bilinear and the rendered triangle genuinely disagree.
    const curved = probeTerrain(state, revision, [18.7, -14.6]);
    expect(curved.difference).not.toBe(0);
    expect(Math.abs(curved.triangle.height - curved.bilinear.height)).toBeGreaterThan(0.01);
    expect(curved.bilinear.source).toBe("bilinear-heightfield");
    expect(curved.triangle.source).toBe("evaluated-triangle");

    expect(() => probeTerrain(state, revision, [65, 0])).toThrow(/outside/iu);
    expect(() => probeTerrain(state, revision, [Number.NaN, 0])).toThrow(/finite/iu);
    expect(() => probeTerrain(state, revision, [64, 4, 0])).toThrow(/\[x, z\]/u);
  });

  it("profiles a transect with separate horizontal and surface distance", () => {
    const state = Terrain.fromJSON(asymmetric()).evaluate();
    const profile = inspectSpatial(state, "c".repeat(64), {
      kind: "profile",
      from: [-50, 40],
      to: [50, -40],
    });
    if (profile.kind !== "profile") throw new Error("Expected a profile observation");
    expect(profile.horizontalDistance).toBeCloseTo(Math.hypot(100, -80), 6);
    expect(profile.surfaceDistance).toBeGreaterThan(profile.horizontalDistance);
    expect(profile.samples.length).toBeGreaterThan(8);
    expect(profile.samples[0]?.distance).toBe(0);
    expect(profile.samples.at(-1)?.distance).toBeCloseTo(profile.horizontalDistance, 6);
    expect(profile.samples.every((sample) => Number.isFinite(sample.height))).toBe(true);
    expect(profile.maxGradeDeg).toBeGreaterThan(0);
    expect(() =>
      inspectSpatial(state, "c".repeat(64), { kind: "profile", from: [1, 1], to: [1, 1] }),
    ).toThrow(/degenerate/iu);
    expect(() =>
      inspectSpatial(state, "c".repeat(64), { kind: "profile", from: [-500, 0], to: [0, 0] }),
    ).toThrow(/outside/iu);
    expect(() =>
      inspectSpatial(state, "c".repeat(64), {
        kind: "profile",
        from: [0, 0],
        to: [10, 0],
        samples: 0,
      }),
    ).toThrow(/samples/iu);
  });

  it("fits a synthetic map from two controls and reports the displaced checkpoint residual", () => {
    const registration = syntheticMap();
    const result = inspectSpatial(Terrain.fromJSON(asymmetric()).evaluate(), "d".repeat(64), {
      kind: "reference",
      reference: registration,
    });
    if (result.kind !== "reference") throw new Error("Expected a reference observation");
    if (!result.fit) throw new Error("Expected a fitted reference");
    expect(result.fit.scaleMetresPerPixel).toBeCloseTo(0.5, 9);
    expect(result.fit.rotationDegrees).toBeCloseTo(30, 6);
    expect(result.fit.mirrored).toBe(false);
    expect(result.controlResidualMetres).toBeLessThan(1e-9);
    expect(result.checkpoint?.residualMetres).toBeCloseTo(5, 6);
    expect(result.checkpoint?.withinTolerance).toBe(false);
    expect(result.calibrated).toBe(false);
    expect(result.labels).toContain("unknown-datum");
    expect(result.landmarks).toHaveLength(3);
    expect(result.landmarks[2]?.horizontalResidualMetres).toBeCloseTo(5, 6);

    const uncalibrated = inspectSpatial(Terrain.fromJSON(asymmetric()).evaluate(), "d".repeat(64), {
      kind: "reference",
      reference: {
        ...registration,
        controls: registration.controls.slice(0, 1) as ISpatialReference["controls"],
        checkpoint: undefined,
      },
    });
    expect(uncalibrated.labels).toContain("uncalibrated");
    expect(uncalibrated.labels).toContain("unscaled");
    if (uncalibrated.kind !== "reference") throw new Error("Expected a reference observation");
    expect(uncalibrated.fit).toBeNull();

    const perspective = inspectSpatial(Terrain.fromJSON(asymmetric()).evaluate(), "d".repeat(64), {
      kind: "reference",
      reference: { ...registration, kind: "screenshot" },
    });
    if (perspective.kind !== "reference") throw new Error("Expected a reference observation");
    expect(perspective.labels).toContain("perspective");
    // A perspective view reference never yields a metric mapping, fitted or otherwise.
    expect(perspective.metric).toBe(false);
    expect(perspective.fit).toBeNull();

    const first = registration.controls[0];
    if (!first) throw new Error("The fixture needs a first control");
    expect(() =>
      inspectSpatial(Terrain.fromJSON(asymmetric()).evaluate(), "d".repeat(64), {
        kind: "reference",
        reference: { ...registration, controls: [first, first] },
      }),
    ).toThrow(/distinct/iu);
  });

  it("keeps a saved registration across reload and answers GUI and headless queries identically", async () => {
    const registration = syntheticMap();
    const context = await api({ version: 1, recipe: asymmetric(), references: [registration] });
    const snapshot = await context.snapshot();
    const reloaded = new TerrainEditorDocument(context.path).snapshot();
    expect(reloaded.revision).toBe(snapshot.revision);
    expect(reloaded.document.references).toEqual([registration]);

    const query = { kind: "profile", from: [-40, 20], to: [30, -25] } as const;
    const remote = await context.inspect(query, snapshot.revision);
    expect(remote.status).toBe(200);
    // The GUI evaluates its own preview state through the same dispatch, as app.js does.
    const gui = inspectSpatial(
      Terrain.fromJSON(snapshot.document.recipe).evaluate(),
      snapshot.revision,
      query,
    );
    expect(remote.body.result).toEqual(gui);
    expect(await context.controller.inspect(query, snapshot.revision)).toEqual({
      result: gui,
    });
    expect((await context.inspect(query, "e".repeat(64))).status).toBe(409);
    expect((await context.inspect({ kind: "point", at: [900, 0] }, snapshot.revision)).status).toBe(
      400,
    );

    const reference = await context.inspect(
      { kind: "reference", reference: registration },
      snapshot.revision,
    );
    expect(reference.status).toBe(200);
    expect(reference.body.result.landmarks).toHaveLength(3);
  });

  it("keeps references and debug overlays out of the evaluated world and the GLB", async () => {
    const context = await api({ version: 1, recipe: asymmetric(), references: [syntheticMap()] });
    const snapshot = await context.snapshot();
    const plain = Terrain.fromJSON(snapshot.document.recipe).evaluate();
    const { bakeMesh } = await import("@threenative/terrain");
    const { encodeGLB } = await import("@threenative/terrain");
    const glb = encodeGLB(bakeMesh(plain));
    const json = new TextDecoder().decode(
      glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true)),
    );
    expect(JSON.parse(json).nodes).toHaveLength(1);
    expect(json).not.toMatch(/survey|"c[123]"|reference/iu);
    expect(plain.instances).toEqual([]);
    expect(plain.waters).toEqual([]);
    expect(JSON.stringify(snapshot.document.recipe)).not.toMatch(/survey/iu);
    expect(JSON.stringify(plain)).not.toMatch(/survey/iu);
  });
});
