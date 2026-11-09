import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Points,
  Scene,
} from "three";
import { describe, expect, it } from "vitest";
import {
  GEOMETRY_ASSET_KEY,
  GeometryCapture,
  type IGeometryOwnership,
} from "../src/geometry-capture.js";
import type { IRenderPassSample } from "../src/render-pass-budget.js";

const material = new MeshBasicMaterial();

/** A triangle count that is easy to read back: `triangles * 3` positions, unindexed. */
function triangleGeometry(triangles: number): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(triangles * 9), 3));
  return geometry;
}

function indexedGeometry(triangles: number): BufferGeometry {
  const geometry = triangleGeometry(triangles * 2);
  geometry.setIndex(new BufferAttribute(new Uint16Array(triangles * 3), 1));
  return geometry;
}

function namedMesh(name: string, triangles: number): Mesh {
  const mesh = new Mesh(triangleGeometry(triangles), material);
  mesh.name = name;
  return mesh;
}

function defaultCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  return camera;
}

/** Invokes one submission exactly as three's renderer does. */
function submitOnce(object: Mesh | Points | LineSegments | InstancedMesh, group?: unknown): void {
  object.onBeforeRender(
    undefined as never,
    undefined as never,
    undefined as never,
    object.geometry as never,
    object.material as never,
    group as never,
  );
}

describe("GeometryCapture", () => {
  it("counts an indexed mesh by its index and an unindexed mesh by its positions", async () => {
    const scene = new Scene();
    const indexed = new Mesh(indexedGeometry(12), material);
    indexed.name = "indexed";
    const direct = namedMesh("direct", 7);
    scene.add(indexed, direct);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    const camera = defaultCamera();
    camera.updateMatrixWorld(true);
    collector.beginFrame({
      camera,
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(indexed);
    submitOnce(direct);
    collector.finishFrame([]);
    const report = await pending;

    expect(report.status).toBe("captured");
    const rows = new Map((report.objects ?? []).map((row) => [row.name, row]));
    expect(rows.get("indexed")?.submittedTriangles).toBe(12);
    expect(rows.get("direct")?.submittedTriangles).toBe(7);
  });

  it("narrows the count by draw range and by material group, never past the buffer", async () => {
    const scene = new Scene();
    const ranged = namedMesh("ranged", 10);
    ranged.geometry.setDrawRange(0, 12);
    const grouped = namedMesh("grouped", 10);
    const overclaimed = namedMesh("overclaimed", 4);
    scene.add(ranged, grouped, overclaimed);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(ranged);
    submitOnce(grouped, { count: 6, start: 0 });
    submitOnce(overclaimed, { count: 9_000, start: 0 });
    collector.finishFrame([]);
    const report = await pending;

    const rows = new Map((report.objects ?? []).map((row) => [row.name, row]));
    expect(rows.get("ranged")?.submittedTriangles).toBe(4);
    expect(rows.get("grouped")?.submittedTriangles).toBe(2);
    expect(rows.get("overclaimed")?.submittedTriangles).toBe(4);
  });

  it("multiplies an instanced mesh's triangles by its active instances", async () => {
    const scene = new Scene();
    const instanced = new InstancedMesh(triangleGeometry(5), material, 40);
    instanced.name = "rocks";
    scene.add(instanced);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(instanced);
    collector.finishFrame([]);
    const report = await pending;

    const row = (report.objects ?? [])[0];
    expect(row?.submittedTriangles).toBe(200);
    expect(row?.instances).toBe(40);
    expect(row?.draws).toBe(1);
  });

  it("charges points and lines a draw and no triangles", async () => {
    const scene = new Scene();
    const points = new Points(triangleGeometry(30), material);
    points.name = "sparks";
    const lines = new LineSegments(triangleGeometry(30), material);
    lines.name = "rails";
    scene.add(points, lines);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(points);
    submitOnce(lines);
    collector.finishFrame([{ draws: 2, kind: "main", triangles: 0 }]);
    const report = await pending;

    for (const row of report.objects ?? []) {
      expect(row.draws).toBe(1);
      expect(row.submittedTriangles).toBe(0);
    }
    const main = (report.passes ?? []).find((pass) => pass.kind === "main");
    expect(main?.unattributedTriangles).toBe(0);
    expect(main?.unattributedDraws).toBe(0);
  });

  it("reports an object the renderer never submitted as not submitted, and charges it nothing", async () => {
    const scene = new Scene();
    const drawn = namedMesh("drawn", 3);
    const skipped = namedMesh("skipped", 900);
    scene.add(drawn, skipped);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(drawn);
    collector.finishFrame([{ draws: 1, kind: "main", triangles: 3 }]);
    const report = await pending;

    const rows = new Map((report.objects ?? []).map((row) => [row.name, row]));
    expect(rows.get("skipped")?.visibility).toBe("notSubmitted");
    expect(rows.get("skipped")?.draws).toBe(0);
    expect(rows.get("drawn")?.visibility).toBe("submitted");
    const main = (report.passes ?? []).find((pass) => pass.kind === "main");
    expect(main?.attributedTriangles).toBe(3);
    expect(main?.unattributedTriangles).toBe(0);
  });

  // The native V8 player's render() records the frame and draws it after the frame callback, so the
  // engine runs onBeforeRender then. Removing the hooks at finishFrame counted no submission at all.
  it("keeps the hooks until a host that draws after the frame has drawn it", async () => {
    const scene = new Scene();
    const drawn = namedMesh("drawn", 3);
    scene.add(drawn);
    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    collector.finishFrame([{ draws: 1, kind: "main", triangles: 3 }], { drawsAfterFrame: true });
    submitOnce(drawn); // the host's deferred draw
    collector.settleDeferred();
    const report = await pending;
    const row = (report.objects ?? []).find((candidate) => candidate.name === "drawn");
    expect(row?.visibility).toBe("submitted");
    expect(row?.draws).toBe(1);
    expect(Object.hasOwn(drawn, "onBeforeRender")).toBe(false);
  });

  it("attributes a submission to the pass that was running", async () => {
    const scene = new Scene();
    const caster = namedMesh("caster", 4);
    scene.add(caster);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    let kind: "main" | "shadow" = "shadow";
    collector.beginFrame({
      activePassKind: () => kind,
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(caster);
    kind = "main";
    submitOnce(caster);
    collector.finishFrame([
      { draws: 1, kind: "shadow", triangles: 4 },
      { draws: 1, kind: "main", triangles: 4 },
    ]);
    const report = await pending;

    const row = (report.objects ?? [])[0];
    expect(row?.submissions.shadow).toEqual({ draws: 1, triangles: 4 });
    expect(row?.submissions.main).toEqual({ draws: 1, triangles: 4 });
    expect(row?.submittedTriangles).toBe(8);
  });

  it("reports the remainder a frame's rows do not account for", async () => {
    const scene = new Scene();
    const known = namedMesh("known", 150);
    scene.add(known);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(known);
    submitOnce(known);
    collector.finishFrame([{ draws: 4, kind: "main", triangles: 500 }]);
    const report = await pending;

    const main = (report.passes ?? []).find((pass) => pass.kind === "main");
    expect(main?.attributedTriangles).toBe(300);
    expect(main?.attributedDraws).toBe(2);
    expect(main?.unattributedTriangles).toBe(200);
    expect(main?.unattributedDraws).toBe(2);
  });

  it("charges a batch's single draw once however many sources it folded", async () => {
    const scene = new Scene();
    const batch = new Mesh(triangleGeometry(30), material);
    batch.name = "curbs-batch";
    scene.add(batch);
    const sources = [namedMesh("curb-a", 10), namedMesh("curb-b", 10), namedMesh("curb-c", 10)];
    for (const source of sources) scene.add(source);
    const ownership = new Map([
      [batch as object, { kind: "instancedBatch", sources } as IGeometryOwnership],
    ]);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      ownership: ownership as never,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(batch);
    collector.finishFrame([{ draws: 1, kind: "main", triangles: 30 }]);
    const report = await pending;

    const rows = (report.objects ?? []).filter((row) => row.name.startsWith("curb-"));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.submittedTriangles).toBe(10);
      expect(row.draws).toBe(0);
      expect(row.batch?.owner).toBe("curbs-batch");
      expect(row.batch?.perMemberDrawsAvailable).toBe(false);
    }
    const main = (report.passes ?? []).find((pass) => pass.kind === "main");
    expect(main?.attributedDraws).toBe(1);
    expect(main?.attributedTriangles).toBe(30);
    expect(main?.unattributedDraws).toBe(0);
  });

  it("ranks the whole inspected scope before slicing the requested rows", async () => {
    const scene = new Scene();
    const meshes = [1, 50, 7, 900, 3].map((triangles, index) =>
      namedMesh(`mesh-${String(index)}`, triangles),
    );
    for (const mesh of meshes) scene.add(mesh);

    const collector = new GeometryCapture();
    const pending = collector.request({ limit: 2 });
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    for (const mesh of meshes) submitOnce(mesh);
    collector.finishFrame([]);
    const report = await pending;

    expect(report.matched).toBe(5);
    expect(report.returned).toBe(2);
    expect(report.rowsTruncated).toBe(true);
    expect(report.partialRanking).toBe(true);
    expect((report.objects ?? []).map((row) => row.submittedTriangles)).toEqual([900, 50]);
  });

  it("sorts an unknown cost after every measured one", async () => {
    const scene = new Scene();
    const measured = namedMesh("measured", 2);
    const unknown = new Mesh(new BufferGeometry(), material);
    unknown.name = "unknown";
    scene.add(measured, unknown);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(measured);
    submitOnce(unknown);
    collector.finishFrame([]);
    const report = await pending;

    const names = (report.objects ?? []).map((row) => row.name);
    expect(names).toEqual(["measured", "unknown"]);
    const unknownRow = (report.objects ?? [])[1];
    expect(unknownRow?.submittedTriangles).toBeUndefined();
    expect(unknownRow?.unavailable).toContain("TN_GEOMETRY_NO_POSITION_COUNT");
  });

  it("answers a report that survives the JSON transport with no undefined values", async () => {
    const scene = new Scene();
    const mesh = namedMesh("subject", 6);
    scene.add(mesh);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      backend: "WebGPUBackend",
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      tick: 42,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(mesh);
    collector.finishFrame([{ draws: 1, kind: "main", triangles: 6 }]);
    const report = await pending;

    // The playtest transport fails closed on any key whose value is not JSON, and an explicit
    // `undefined` is exactly that. A round trip loses those keys, so equality proves there are
    // none: this took a real browser run down before the report omitted them instead.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.frame).toBeUndefined();
    expect(report.tick).toBe(42);
    expect(report.backend).toBe("WebGPUBackend");
  });

  it("throws on a malformed request instead of choosing a scope the caller did not ask for", () => {
    const collector = new GeometryCapture();
    expect(() => collector.request({ limit: 0 })).toThrow(/TN_GEOMETRY_CAPTURE_LIMIT/u);
    expect(() => collector.request({ limit: 501 })).toThrow(/limit/u);
    expect(() => collector.request({ limit: 1.5 })).toThrow(/limit/u);
    expect(() => collector.request({ sort: "size" as never })).toThrow(/TN_GEOMETRY_CAPTURE_SORT/u);
    expect(() => collector.request({ timeoutMs: 0 })).toThrow(/timeoutMs/u);
  });

  it("answers unavailable when no frame arrives, never the previous capture", async () => {
    const scene = new Scene();
    const mesh = namedMesh("first", 5);
    scene.add(mesh);
    const collector = new GeometryCapture();

    const first = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    submitOnce(mesh);
    collector.finishFrame([]);
    expect((await first).objects).toHaveLength(1);

    const second = await collector.request({ timeoutMs: 20 });
    expect(second.status).toBe("unavailable");
    expect(second.reason).toMatch(/TN_GEOMETRY_CAPTURE_NO_FRAME/u);
    expect(second.objects).toBeUndefined();
  });

  it("resolves a pending capture as unavailable when it is cancelled", async () => {
    const collector = new GeometryCapture();
    const pending = collector.request();
    collector.cancel("TN_GEOMETRY_CAPTURE_SCENE_EXIT: the scene changed mid-capture.");
    const report = await pending;
    expect(report.status).toBe("unavailable");
    expect(report.reason).toMatch(/SCENE_EXIT/u);
  });

  it("installs no hook while idle and hands a game's own callback back untouched", async () => {
    const scene = new Scene();
    const plain = namedMesh("plain", 1);
    const owned = namedMesh("owned", 1);
    let ownCalls = 0;
    const own = (): void => {
      ownCalls += 1;
    };
    owned.onBeforeRender = own as never;
    scene.add(plain, owned);

    expect(Object.hasOwn(plain, "onBeforeRender")).toBe(false);
    const collector = new GeometryCapture();
    expect(collector.armed()).toBe(false);

    const pending = collector.request();
    expect(collector.armed()).toBe(true);
    expect(Object.hasOwn(plain, "onBeforeRender")).toBe(false);

    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    expect(Object.hasOwn(plain, "onBeforeRender")).toBe(true);
    submitOnce(plain);
    submitOnce(owned);
    expect(ownCalls).toBe(1);
    collector.finishFrame([]);
    await pending;

    expect(Object.hasOwn(plain, "onBeforeRender")).toBe(false);
    expect(owned.onBeforeRender).toBe(own);
    expect(collector.armed()).toBe(false);
  });

  it("estimates projected size honestly for distance, orthographic cameras and a camera inside the bounds", async () => {
    const near = await sizeOf(4);
    const far = await sizeOf(400);
    expect(near).toBeGreaterThan(far as number);

    const orthographic = new OrthographicCamera(-10, 10, 6, -6, 0.1, 1000);
    orthographic.position.set(0, 0, 20);
    orthographic.lookAt(0, 0, 0);
    const ortho = await sizeOf(20, orthographic);
    expect(Number.isFinite(ortho as number)).toBe(true);
    expect(ortho).toBeGreaterThan(0);

    // A camera at the object cannot resolve a projected size; the conservative answer is large.
    const inside = await sizeOf(0);
    expect(inside).toBeGreaterThanOrEqual(720);
  });

  it("groups rows by the asset a loader stamped, and never merges two assets by name", async () => {
    const scene = new Scene();
    const first = new Group();
    first.name = "hornet";
    first.userData[GEOMETRY_ASSET_KEY] = "models/hornet.glb";
    first.add(namedMesh("fuselage", 10));
    const second = new Group();
    second.name = "hornet";
    second.userData[GEOMETRY_ASSET_KEY] = "models/hornet-b.glb";
    second.add(namedMesh("fuselage", 20));
    const third = new Group();
    third.name = "hornet";
    third.userData[GEOMETRY_ASSET_KEY] = "models/hornet.glb";
    third.add(namedMesh("fuselage", 10));
    const procedural = namedMesh("terrain", 5);
    scene.add(first, second, third, procedural);

    const collector = new GeometryCapture();
    const pending = collector.request();
    scene.updateMatrixWorld(true);
    collector.beginFrame({
      camera: defaultCamera(),
      generation: 1,
      root: scene,
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    for (const group of [first, second, third]) {
      submitOnce(group.children[0] as Mesh);
    }
    submitOnce(procedural);
    collector.finishFrame([]);
    const report = await pending;

    const assets = new Map((report.assets ?? []).map((row) => [row.asset, row]));
    expect(assets.get("models/hornet.glb")?.objects).toBe(2);
    expect(assets.get("models/hornet-b.glb")?.objects).toBe(1);
    expect(assets.get("unattributed")?.objects).toBe(1);
  });
});

/** The projected diameter a 1-unit mesh reports at `distance`, for one camera. */
async function sizeOf(
  distance: number,
  camera: PerspectiveCamera | OrthographicCamera = defaultCamera(),
): Promise<number | undefined> {
  const scene = new Scene();
  const mesh = namedMesh("subject", 2);
  mesh.geometry.computeBoundingSphere();
  mesh.geometry.boundingSphere?.set(mesh.geometry.boundingSphere.center, 1);
  mesh.position.set(0, 0, -distance);
  scene.add(mesh);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  scene.updateMatrixWorld(true);

  const collector = new GeometryCapture();
  const pending = collector.request();
  collector.beginFrame({
    camera,
    generation: 1,
    root: scene,
    viewportHeight: 720,
    viewportWidth: 1280,
  });
  submitOnce(mesh);
  collector.finishFrame([]);
  const report = await pending;
  return (report.objects ?? [])[0]?.projectedPixels;
}
