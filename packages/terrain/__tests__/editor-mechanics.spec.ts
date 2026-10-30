import {
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Vector3,
} from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { describe, expect, it, vi } from "vitest";
import type { IPlacementOverride } from "../src/core/types.js";
import type { Layer } from "../src/core/types.js";
import { landformPose, transformedLandform } from "../src/editor/landforms.js";
import {
  editorPlacementCenter,
  editorPointToClient,
  editorSurfaceHeight,
  pickEditorPlacement,
  pickEditorSurface,
} from "../src/editor/picking.js";
import { createEditorSelection } from "../src/editor/selection.js";
import type { IEditorSnapshot } from "../src/editor/server.js";

describe("editor heightfield picking", () => {
  it("subtracts the viewport offset and keeps the caller's target order", () => {
    const raycast = vi.fn<Parameters<typeof editorSurfaceHeight>[0]["raycast"]>();
    const renderer = {
      domElement: { getBoundingClientRect: () => ({ left: 90, top: 40 }) },
    };
    const targets = [new Mesh(), new Mesh()];
    expect(pickEditorSurface({ renderer, raycast }, targets, 120, 60)).toBeUndefined();
    const query = raycast.mock.calls[0]?.[0];
    expect(query?.screen?.toArray()).toEqual([30, 20]);
    expect(query?.targets).toBe(targets);
  });

  it("uses the rendered surface and returns undefined outside it", () => {
    const mesh = new Mesh(new BoxGeometry(10, 4, 10));
    const ray = new Raycaster();
    const raycast: Parameters<typeof editorSurfaceHeight>[0]["raycast"] = (query) => {
      if (!query?.origin || !query.direction) throw new Error("Missing downward ray");
      ray.set(query.origin, query.direction);
      return ray.intersectObject(mesh)[0];
    };
    expect(editorSurfaceHeight({ raycast }, mesh, 0, 0)).toBe(2);
    expect(editorSurfaceHeight({ raycast }, mesh, 20, 0)).toBeUndefined();
    expect(editorSurfaceHeight({ raycast }, mesh, 0, 0, 10000)).toBe(2);
    mesh.geometry.dispose();
  });
});

describe("landform gizmo math", () => {
  const layer: Layer = {
    id: "stamp-1",
    type: "stamp",
    params: { at: [10, 20], radius: [8, 9], offset: 3, scale: 2, rotation: 90 },
  };

  it("round-trips the terrain rotation convention and removes the surface anchor", () => {
    const pose = landformPose(layer, 100, 120);
    expect(pose).toBeDefined();
    if (!pose) throw new Error("Missing landform pose");
    const next = transformedLandform(
      layer,
      new Vector3(...pose.position).add(new Vector3(0, 7, 0)),
      pose.quaternion,
      new Vector3(...pose.scale),
      7,
    );
    expect(next.params).toMatchObject({ at: [10, 20], radius: [8, 9], offset: 3, scale: 2 });
    expect((next.params as typeof layer.params & { rotation: number }).rotation).toBeCloseTo(90);
  });

  it("writes heightmap half extents as full size and keeps unrelated parameters", () => {
    const heightmap: Layer = {
      id: "map",
      type: "heightmap",
      params: { blend: "replace", data: { width: 2, height: 2, values: [0, 0, 0, 0] } },
    };
    expect(landformPose(heightmap, 100, 120)?.scale).toEqual([50, 1, 50]);
    const next = transformedLandform(
      heightmap,
      new Vector3(5, 8, 6),
      new Quaternion(),
      new Vector3(4, 2, 3),
      5,
    );
    expect(next.params).toMatchObject({ size: [8, 6], at: [5, 6], offset: 3, blend: "replace" });
  });

  it("rejects overhangs, nonfinite coordinates and nonpositive scales", () => {
    const transform = (position: Vector3, rotation: Quaternion, scale: Vector3) =>
      transformedLandform(layer, position, rotation, scale, 0);
    expect(() =>
      transform(new Vector3(), new Quaternion(0.1, 0, 0, 1), new Vector3(1, 1, 1)),
    ).toThrow("overhanging");
    expect(() =>
      transform(new Vector3(Number.NaN, 0, 0), new Quaternion(), new Vector3(1, 1, 1)),
    ).toThrow("finite");
    expect(() => transform(new Vector3(), new Quaternion(), new Vector3(1, 0, 1))).toThrow(
      "positive",
    );
  });
});

// At z=10 with a 90-degree camera, a +0.2 NDC X ray crosses z=0 at x=2.
describe("injected editor selection mechanics", () => {
  function setup() {
    const camera = new PerspectiveCamera(90, 1, 0.1, 100);
    camera.position.z = 10;
    camera.updateMatrixWorld(true);
    const scene = new Scene();
    const proxy = new Object3D();
    scene.add(proxy);
    const gizmo = new TransformControls(camera);
    scene.add(gizmo.getHelper());
    const snapshot: IEditorSnapshot = {
      revision: "base",
      diagnostic: null,
      document: {
        version: 1,
        recipe: { version: 1, config: { size: 100, resolution: 3, seed: 1 }, layers: [] },
      },
    };
    const commit = vi.fn<Parameters<typeof createEditorSelection>[0]["controller"]["commit"]>(
      async () => ({ ...snapshot, revision: "next" }),
    );
    const readSnapshot = vi.fn(async () => snapshot);
    const previewPlacement = vi.fn();
    const setNavigation = vi.fn();
    const message = vi.fn();
    const pose = {
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      grounding: true,
    } satisfies IPlacementOverride;
    const selection = createEditorSelection({
      gizmo,
      proxy,
      controller: { commit, snapshot: readSnapshot },
      grounding: () => true,
      surface: () => 7,
      defaultFootprintSize: 120,
      refreshPose: () => {
        const layer = selection.snapshot?.document.recipe.layers.find(
          (l) => l.id === selection.selectedLayer,
        );
        selection.applyPose(layer, pose);
      },
      drawFootprint: vi.fn(),
      restorePlacement: vi.fn(),
      previewPlacement,
      setSaving: vi.fn(),
      selectedChanged: vi.fn(),
      setNavigation,
      message,
    });
    selection.sync(snapshot, false);
    selection.setActive(true);
    selection.select("prop");
    function drag(x: number) {
      gizmo.axis = "X";
      scene.updateMatrixWorld(true);
      gizmo.pointerDown({ x: 0, y: 0, button: 0 } as PointerEvent);
      gizmo.pointerMove({ x, y: 0, button: -1 } as PointerEvent);
    }
    return {
      selection,
      snapshot,
      readSnapshot,
      gizmo,
      proxy,
      commit,
      previewPlacement,
      setNavigation,
      message,
      drag,
    };
  }

  it("blocks alternate pointers and detaches when disabled", () => {
    const f = setup();
    expect(f.selection.canPick({ button: 0, altKey: false })).toBe(true);
    expect(f.selection.canPick({ button: 2, altKey: false })).toBe(false);
    expect(f.selection.canPick({ button: 0, altKey: true })).toBe(false);
    f.selection.setActive(false);
    expect(f.selection.active).toBe(false);
    expect(f.gizmo.object).toBeUndefined();
    expect(f.selection.canPick({ button: 0, altKey: false })).toBe(false);
    f.selection.dispose();
  });

  it("reassigns orphan overrides atomically and refuses to overwrite a destination", async () => {
    const f = setup();
    const value: IPlacementOverride = {
      position: [1, 2, 3],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      grounding: false,
    };
    f.snapshot.document.placementOverrides = { orphan: value };
    await f.selection.reassign("orphan");
    expect(f.commit).toHaveBeenLastCalledWith({
      baseRevision: "base",
      document: { ...f.snapshot.document, placementOverrides: { prop: value } },
    });
    f.snapshot.document.placementOverrides.prop = value;
    await f.selection.reassign("orphan");
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.message).toHaveBeenLastCalledWith("Choose a placement without an existing override.");
    f.selection.dispose();
  });

  it("retains invalid or failed drafts and clears them explicitly", async () => {
    const f = setup();
    f.selection.applyFields([1, 2, 3, 0, 0, 0, 1, 0, 1], true);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.message.mock.calls.at(-1)?.[0]).toContain("scale");
    f.commit.mockRejectedValueOnce(new Error("stale revision"));
    f.selection.applyFields([1, 2, 3, 0, 0, 0, 1, 1, 1], true);
    await vi.waitFor(() => expect(f.selection.saving).toBe(false));
    expect(f.selection.draft?.transform.position).toEqual([1, 2, 3]);
    f.selection.clearDrafts();
    expect(f.selection.draft).toBeUndefined();
    f.selection.dispose();
  });

  it("undoes a placement only while its committed transform still matches", async () => {
    const f = setup();
    const value: IPlacementOverride = {
      position: [1, 2, 3],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      grounding: false,
    };
    await f.selection.save("prop", value);
    f.snapshot.document.placementOverrides = { prop: value };
    await f.selection.undo();
    expect(f.commit).toHaveBeenLastCalledWith({
      baseRevision: "base",
      document: { ...f.snapshot.document, placementOverrides: {} },
    });
    await f.selection.save("prop", value);
    f.snapshot.document.placementOverrides.prop = { ...value, position: [9, 9, 9] };
    await f.selection.undo();
    expect(f.commit).toHaveBeenCalledTimes(3);
    expect(f.message).toHaveBeenLastCalledWith(
      "Undo conflict: another actor changed this placement; their edit is retained.",
    );
    f.selection.dispose();
  });

  it("reports a failed recovery snapshot instead of rejecting the landform save", async () => {
    const f = setup();
    const layer: Layer = {
      id: "hill",
      type: "stamp",
      params: { at: [10, 20], offset: 3, radius: 8, amplitude: 40 },
    };
    f.snapshot.document.recipe.layers.push(layer);
    f.selection.selectLayer("hill");
    f.commit.mockRejectedValueOnce(new Error("stale revision"));
    // The commit failed, then the snapshot that rebases the retained draft failed too.
    f.readSnapshot.mockRejectedValueOnce(new Error("socket closed"));
    f.selection.applyFields([12, 5, 22, 0, 0, 0, 6, 2, 7], true);
    await vi.waitFor(() => expect(f.selection.saving).toBe(false));
    expect(f.message).toHaveBeenLastCalledWith("Connection interrupted · landform draft retained.");
    expect(f.selection.layerDraft?.id).toBe("hill");
    f.selection.dispose();
  });

  it("commits landform fields and undoes only footprint parameters", async () => {
    const f = setup();
    const layer: Layer = {
      id: "hill",
      type: "stamp",
      params: { at: [10, 20], offset: 3, radius: 8, amplitude: 40 },
    };
    f.snapshot.document.recipe.layers.push(layer);
    f.selection.selectLayer("hill");
    expect(f.selection.selectedLayer).toBe("hill");
    expect(f.selection.selected).toBeUndefined();
    f.selection.applyFields([12, 5, 22, 0, 90, 0, 6, 2, 7], true);
    await vi.waitFor(() => expect(f.selection.saving).toBe(false));
    const request = f.commit.mock.calls[0]?.[0];
    if (!request || !("commands" in request)) throw new Error("Missing landform request");
    const command = request.commands[0];
    if (!command || command.op !== "upsert") throw new Error("Missing landform upsert");
    expect(command.layer.params).toMatchObject({
      at: [12, 22],
      offset: 5,
      radius: [6, 7],
      scale: 2,
      amplitude: 40,
    });
    f.snapshot.document.recipe.layers = [
      { ...command.layer, params: { ...command.layer.params, amplitude: 90 } } as Layer,
    ];
    await f.selection.undo();
    const undoRequest = f.commit.mock.calls[1]?.[0];
    if (!undoRequest || !("commands" in undoRequest)) throw new Error("Missing undo request");
    const undo = undoRequest.commands[0];
    if (!undo || undo.op !== "upsert") throw new Error("Missing landform undo");
    expect(undo.layer.params).toEqual({ ...layer.params, amplitude: 90 });
    f.selection.dispose();
  });

  it("restricts landform rotation and removes gesture listeners on disposal", () => {
    const f = setup();
    f.snapshot.document.recipe.layers.push({ id: "hill", type: "stamp", params: { radius: 8 } });
    f.selection.selectLayer("hill");
    f.gizmo.setMode("rotate");
    f.selection.applyPose(f.snapshot.document.recipe.layers[0]);
    expect(f.gizmo.showX).toBe(false);
    expect(f.gizmo.showZ).toBe(false);
    f.gizmo.axis = "X";
    f.gizmo.dispatchEvent({ type: "mouseDown", mode: "rotate" });
    expect(f.selection.drag).toBeUndefined();
    expect(f.message).toHaveBeenLastCalledWith(
      "Only Y rotation is supported: a heightfield cannot overhang.",
    );
    f.selection.dispose();
    f.setNavigation.mockClear();
    f.gizmo.dispatchEvent({ type: "dragging-changed", value: true });
    expect(f.setNavigation).not.toHaveBeenCalled();
  });

  it("turns a known axis ray into a two-metre delta and commits once on release", async () => {
    const f = setup();
    f.drag(0.2);
    expect(f.previewPlacement.mock.calls[0]?.[1].position[0]).toBeCloseTo(2);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.setNavigation).toHaveBeenLastCalledWith(false);
    f.gizmo.pointerUp(null);
    await Promise.resolve();
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.setNavigation).toHaveBeenLastCalledWith(true);
    f.selection.dispose();
  });

  it("preserves injected translation snapping", () => {
    const f = setup();
    f.gizmo.setTranslationSnap(1);
    f.drag(0.26);
    expect(f.previewPlacement.mock.calls[0]?.[1].position).toEqual([3, 0, 0]);
    f.selection.cancel();
    expect(f.commit).not.toHaveBeenCalled();
    f.selection.dispose();
  });

  it("preserves injected axis clamping", () => {
    const f = setup();
    f.gizmo.maxX = 1.5;
    f.drag(0.2);
    expect(f.previewPlacement.mock.calls[0]?.[1].position).toEqual([1.5, 0, 0]);
    f.selection.cancel();
    f.selection.dispose();
  });

  it("retains the selection during a drag and cancels without saving", () => {
    const f = setup();
    f.drag(0.2);
    f.selection.select("other");
    expect(f.selection.selected).toBe("prop");
    expect(f.selection.canPick({ button: 0, altKey: false })).toBe(false);
    f.selection.cancel();
    f.gizmo.pointerUp(null);
    expect(f.selection.draft).toBeUndefined();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.message).toHaveBeenLastCalledWith("Drag cancelled · no transaction");
    f.selection.dispose();
  });

  it("applies form values with validation and anchors landform poses", async () => {
    const f = setup();
    f.selection.applyFields([1, 2, 3, 0, 0, 0, 2, 3, 4], false);
    expect(f.previewPlacement).toHaveBeenCalledWith("prop", {
      position: [1, 2, 3],
      quaternion: [0, 0, 0, 1],
      scale: [2, 3, 4],
      grounding: false,
    });
    await Promise.resolve();
    const layer: Layer = {
      id: "hill",
      type: "stamp",
      params: { at: [10, 20], offset: 3, radius: 8 },
    };
    expect(f.selection.applyPose(layer)).toEqual([10, 3, 20, 0, 0, 0, 8, 1, 8]);
    expect(f.selection.anchor).toBe(4);
    expect(f.proxy.position.toArray()).toEqual([10, 7, 20]);
    f.selection.dispose();
  });
});

describe("placement picking and projection", () => {
  it("resolves instance world matrices and respects terrain occlusion", () => {
    const terrain = new Mesh();
    const mesh = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 1);
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(2, 0, 0));
    mesh.position.set(10, 3, 4);
    mesh.updateMatrixWorld(true);
    const placements = [
      { pose: new Matrix4().makeTranslation(12, 3, 4), placement: { id: "tree" } },
    ];
    const hit = { object: mesh, instanceId: 0, point: new Vector3(12, 3, 4), distance: 1 };
    const raycast = vi.fn<Parameters<typeof pickEditorSurface>[0]["raycast"]>(() => hit);
    const ctx = {
      renderer: { domElement: { getBoundingClientRect: () => ({ left: 10, top: 20 }) } },
      raycast,
    };
    expect(pickEditorPlacement(ctx, terrain, [mesh], placements, 30, 50)).toBe("tree");
    expect(raycast.mock.calls[0]?.[0].targets).toEqual([terrain, mesh]);
    expect(pickEditorPlacement(ctx, terrain, [mesh], [], 30, 50)).toBeUndefined();
    const occluded = {
      ...ctx,
      raycast: () => ({ object: terrain, point: new Vector3(), distance: 0.5 }),
    };
    expect(pickEditorPlacement(occluded, terrain, [mesh], placements, 30, 50)).toBeUndefined();
    mesh.geometry.dispose();
    mesh.material.dispose();
  });

  it("transforms the measured geometry centre with scale, rotation and translation", () => {
    const pose: IPlacementOverride = {
      position: [10, 3, 4],
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).toArray(),
      scale: [2, 3, 4],
      grounding: false,
    };
    const center = editorPlacementCenter(new Vector3(1, 2, 3), pose);
    expect(center.x).toBeCloseTo(22);
    expect(center.y).toBeCloseTo(9);
    expect(center.z).toBeCloseTo(2);
  });

  it("projects a known world point through the caller's viewport offset", () => {
    const camera = new PerspectiveCamera(90, 1, 0.1, 100);
    camera.position.z = 10;
    camera.updateMatrixWorld(true);
    const pixel = editorPointToClient(new Vector3(2, 0, 0), camera, {
      left: 10,
      top: 20,
      width: 200,
      height: 100,
    });
    expect(pixel[0]).toBeCloseTo(130);
    expect(pixel[1]).toBeCloseTo(70);
  });
});
