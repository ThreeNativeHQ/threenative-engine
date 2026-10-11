import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Terrain, TerrainEvaluator } from "@threenative/terrain";
import {
  type ISavedCamera,
  TerrainEditorController,
  focusCamera,
} from "@threenative/terrain/editor";
import { TerrainEditorDocument, terrainEditor } from "@threenative/terrain/editor/server";
import { type Camera, OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import { type ViteDevServer, createServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const servers: ViteDevServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

function recipe() {
  return new Terrain({ size: 256, resolution: 65, seed: 73 })
    .noise({ id: "hills", amplitude: 12 })
    .toJSON();
}

async function api(document: unknown = { version: 1, recipe: recipe() }) {
  const root = makeTempDirSync("terrain-cameras-");
  const path = join(root, "world.json");
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
  const operate = async (operation: unknown, baseRevision?: string) => {
    const current = baseRevision ?? (await controller.snapshot()).revision;
    const response = await fetch(new URL("cameras", controller.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: current, operation }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { path, controller, operate, snapshot: () => controller.snapshot() };
}

const survey: ISavedCamera = {
  id: "survey",
  name: "Survey ridge",
  position: [60, 40, 70],
  target: [0, 10, 0],
  up: [0, 1, 0],
  projection: "perspective",
  fov: 50,
  near: 0.5,
  far: 900,
};

describe("editor camera operations", () => {
  it("round-trips CRUD through the public middleware and survives a document reload", async () => {
    const context = await api();
    const created = await context.operate({ op: "create", camera: survey });
    expect(created.status).toBe(200);
    expect(created.body.camera).toEqual(survey);
    expect(created.body.activeCamera).toBeNull();
    expect(created.body.fallback).toBeNull();

    const listed = await context.operate({ op: "list" });
    expect(listed.body.cameras).toEqual([survey]);
    expect((await context.operate({ op: "get", id: "survey" })).body.camera).toEqual(survey);

    const moved = { position: [12, 90, -30] };
    const updated = await context.operate({ op: "update", id: "survey", patch: moved });
    expect(updated.body.camera).toEqual({ ...survey, ...moved });
    expect((await context.snapshot()).document.cameras).toEqual([{ ...survey, ...moved }]);

    // Both the camera and which one is live are saved with the document, not with the session.
    const activated = await context.operate({ op: "activate", id: "survey" });
    expect(activated.body.activeCamera).toBe("survey");
    const reloaded = new TerrainEditorDocument(context.path).snapshot();
    expect(reloaded.document.cameras).toEqual([{ ...survey, ...moved }]);
    expect(reloaded.document.activeCamera).toBe("survey");

    // Aspect is measured from the live viewport, so a document never carries one.
    expect(JSON.stringify(reloaded.document)).not.toMatch(/aspect/iu);
    const deleted = await context.operate({ op: "delete", id: "survey" });
    expect(deleted.body.cameras).toEqual([]);
    expect(new TerrainEditorDocument(context.path).snapshot().document.cameras).toEqual([]);
  });

  it("rejects invalid and stale camera writes without evaluating terrain or changing the document", async () => {
    const evaluate = vi.spyOn(TerrainEvaluator.prototype, "evaluate");
    const context = await api();
    await context.operate({ op: "create", camera: survey });
    const before = await context.snapshot();
    const cameraWrites = [
      { op: "update", id: "survey", patch: { position: [Number.NaN, 1, 2] } },
      { op: "update", id: "survey", patch: { position: [0, 10, 0] } },
      { op: "update", id: "survey", patch: { up: [0, 0, 0] } },
      { op: "update", id: "survey", patch: { fov: 200 } },
      { op: "update", id: "survey", patch: { fov: 0 } },
      { op: "update", id: "survey", patch: { near: 5, far: 1 } },
      { op: "update", id: "survey", patch: { name: "" } },
      { op: "update", id: "survey", patch: { aspect: 1.7 } },
      { op: "update", id: "survey", patch: { zoom: 0 } },
      { op: "create", camera: { ...survey, id: "survey" } },
      { op: "create", camera: { ...survey, id: "second", projection: "orthographic" } },
      { op: "get", id: "missing" },
      { op: "delete", id: "missing" },
      { op: "activate", id: "missing" },
    ];
    for (const operation of cameraWrites) {
      const rejected = await context.operate(operation, before.revision);
      expect(rejected.status, JSON.stringify(operation)).toBe(400);
      expect(rejected.body.error).toBeTruthy();
    }
    const stale = await context.operate({ op: "activate", id: "survey" }, "e".repeat(64));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/stale/iu);
    const after = await context.snapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.document.cameras).toEqual([survey]);
    expect(evaluate).not.toHaveBeenCalled();

    const accepted = await context.operate({ op: "activate", id: "survey" });
    expect(accepted.body.activeCamera).toBe("survey");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("falls back to the ordinary editor camera when the live camera is deleted", async () => {
    const context = await api();
    await context.operate({ op: "create", camera: survey });
    await context.operate({ op: "activate", id: "survey" });
    const deleted = await context.operate({ op: "delete", id: "survey" });
    expect(deleted.body).toMatchObject({ activeCamera: null, fallback: "editor-camera" });
    expect((await context.snapshot()).document.activeCamera).toBeNull();
  });

  it("switches a saved camera to orthographic and back through one update", async () => {
    const context = await api();
    await context.operate({ op: "create", camera: survey });
    const orthogonal = await context.operate({
      op: "update",
      id: "survey",
      patch: { projection: "orthographic", extent: 120, zoom: 2 },
    });
    expect(orthogonal.body.camera).toMatchObject({
      projection: "orthographic",
      extent: 120,
      zoom: 2,
    });
    expect(orthogonal.body.camera.fov).toBeUndefined();
    const perspective = await context.operate({
      op: "update",
      id: "survey",
      patch: { projection: "perspective", fov: 35 },
    });
    expect(perspective.body.camera).toMatchObject({ projection: "perspective", fov: 35 });
    expect(perspective.body.camera.extent).toBeUndefined();
  });
});

/** A real Three.js camera built from a saved pose, exactly as the live view builds it. */
function liveCamera(saved: ISavedCamera, aspect: number): Camera {
  if (saved.projection === "perspective") {
    const camera = new PerspectiveCamera(saved.fov, aspect, saved.near, saved.far);
    camera.position.fromArray(saved.position);
    camera.up.fromArray(saved.up);
    camera.lookAt(new Vector3().fromArray(saved.target));
    camera.updateProjectionMatrix();
    // The view's own render loop refreshes these; a measurement must not read a stale eye.
    camera.updateMatrixWorld(true);
    return camera;
  }
  const halfHeight = saved.extent * saved.zoom;
  const camera = new OrthographicCamera(
    -halfHeight * aspect,
    halfHeight * aspect,
    halfHeight,
    -halfHeight,
    saved.near,
    saved.far,
  );
  camera.position.fromArray(saved.position);
  camera.up.fromArray(saved.up);
  camera.lookAt(new Vector3().fromArray(saved.target));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

const bounds = { min: [-3, 10, -4] as const, max: [5, 26, 6] as const };
const corners = Array.from(
  { length: 8 },
  (_, index) =>
    new Vector3(
      index & 1 ? bounds.max[0] : bounds.min[0],
      index & 2 ? bounds.max[1] : bounds.min[1],
      index & 4 ? bounds.max[2] : bounds.min[2],
    ),
);
/** Screen extent of the framed target in the [-1, 1] clip square; the safe frame is inside 1. */
function clipExtent(camera: Camera, points: readonly Vector3[] = corners) {
  const projected = points.map((corner) => corner.clone().project(camera));
  return {
    x: Math.max(...projected.map((point) => Math.abs(point.x))),
    y: Math.max(...projected.map((point) => Math.abs(point.y))),
    z: projected.every((point) => point.z > -1 && point.z < 1),
  };
}

describe("editor camera focus framing", () => {
  it("frames a prop inside the safe frame at two viewport aspects and derives the clip range", () => {
    for (const aspect of [16 / 9, 4 / 3, 9 / 16]) {
      const outcome = focusCamera(
        survey,
        { target: { kind: "prop", id: "pine-7" }, aspect, direction: [0.6, 0.5, 1] },
        (target) => (target.id === "pine-7" ? bounds : undefined),
      );
      expect(outcome.diagnostic).toBeNull();
      const camera = outcome.camera;
      const framing = outcome.framing;
      if (!camera || !framing) throw new Error("Expected a framed camera");
      expect(camera.projection).toBe("perspective");
      if (camera.projection !== "perspective") throw new Error("Expected a perspective framing");
      expect(camera.fov).toBe(survey.fov);
      expect(camera.target).toEqual([1, 18, 1]);
      const heading = new Vector3(0.6, 0.5, 1).normalize().multiplyScalar(framing.distanceMetres);
      expect(camera.position).toEqual([1 + heading.x, 18 + heading.y, 1 + heading.z]);
      expect(framing.aspect).toBe(aspect);
      expect(camera.near).toBe(framing.near);
      expect(camera.far).toBe(framing.far);
      expect(camera.near).toBeGreaterThan(0);
      expect(camera.far).toBeGreaterThan(camera.near);
      const clip = clipExtent(liveCamera(camera, aspect));
      expect(clip.x, `aspect ${aspect}`).toBeLessThan(0.9);
      expect(clip.y, `aspect ${aspect}`).toBeLessThan(0.9);
      expect(clip.z, `aspect ${aspect}`).toBe(true);
    }
  });

  it("frames an orthographic map view for the same target at any aspect", () => {
    const map: ISavedCamera = {
      id: "map",
      name: "Map",
      position: [1, 200, 1],
      target: [1, 18, 1],
      up: [0, 0, -1],
      projection: "orthographic",
      extent: 120,
      zoom: 2,
      near: 0.5,
      far: 900,
    };
    const extents: number[] = [];
    for (const aspect of [16 / 9, 1]) {
      const outcome = focusCamera(
        map,
        { target: { kind: "region", id: "valley" }, aspect, direction: [0, -1, 0], margin: 1.2 },
        () => bounds,
      );
      const camera = outcome.camera;
      const framing = outcome.framing;
      if (!camera || !framing || camera.projection !== "orthographic")
        throw new Error("Expected an orthographic framing");
      expect(camera.zoom).toBe(2);
      extents.push(camera.extent);
      const clip = clipExtent(liveCamera(camera, aspect));
      expect(clip.x, `aspect ${aspect}`).toBeLessThan(0.85);
      expect(clip.y, `aspect ${aspect}`).toBeLessThan(0.85);
      expect(camera.near).toBeGreaterThan(0);
    }
    // A wide viewport needs no extra world height, so the extent does not grow with the aspect.
    expect(extents[1]).toBeGreaterThanOrEqual((extents[0] as number) * 0.999);
  });

  it("returns a named diagnostic and no camera for an unknown focus target", () => {
    const outcome = focusCamera(
      survey,
      { target: { kind: "prop", id: "ghost" }, aspect: 1.5 },
      () => undefined,
    );
    expect(outcome.camera).toBeNull();
    expect(outcome.framing).toBeNull();
    expect(outcome.diagnostic).toBe("No focus target for prop 'ghost'");
    const point = focusCamera(
      survey,
      { target: { kind: "point", at: [7, 11, -3] }, aspect: 1.5 },
      () => undefined,
    );
    expect(point.diagnostic).toBeNull();
    expect(point.framing?.centre).toEqual([7, 11, -3]);
    // A point has no size, and the framing still has to sit between the clipping planes.
    if (!point.camera) throw new Error("Expected a framed camera");
    const at = new Vector3(7, 11, -3);
    const clip = clipExtent(liveCamera(point.camera, 1.5), [at]);
    expect(clip.z, "a framed point must be between the near and far planes").toBe(true);
    expect(clip.x).toBeLessThan(0.01);
    expect(point.camera.near).toBeLessThan(point.framing?.distanceMetres as number);
  });
});
