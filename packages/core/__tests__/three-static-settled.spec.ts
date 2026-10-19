import { BoxGeometry, Euler, InstancedMesh, Quaternion } from "three";
import Bindings from "three/src/renderers/common/Bindings.js";
import Geometries from "three/src/renderers/common/Geometries.js";
import Renderer from "three/src/renderers/common/Renderer.js";
// @ts-expect-error Three's node manager has no public declarations.
import NodeManager from "three/src/renderers/common/nodes/NodeManager.js";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { NodeMaterialObserver, NodeUpdateType } from "three/webgpu";
import { describe, expect, it } from "vitest";

/** One render object per mesh, as the renderer holds it: its identity is what the observer keys. */
const renderObjects = new WeakMap<InstancedMesh, unknown>();

/** The Geometries manager, one per mesh: the settled snapshot it keeps has to survive the draws. */
const geometries = new WeakMap<InstancedMesh, object>();

/** Whether the renderer has already created this render object's bind groups, which it does once. */
const created = new WeakSet<InstancedMesh>();

/** The render call each draw belongs to: an attribute uploads once per call, not once per draw. */
const renderCalls = new WeakMap<InstancedMesh, number>();

/** The call the manager under test reads, which the manager outlives. */
const currentCall = { id: 0 };

/** The counters the manager under test writes, which the manager outlives. */
let currentCounts: ICounted | undefined;
/** The generation three gives a texture each time it re-creates the GPU texture behind it. */
let textureGeneration = 0;

/** The armed counters, failing closed: a draw before its test armed them is a broken test, not a zero. */
function liveCounts(): ICounted {
  if (currentCounts === undefined)
    throw new Error("a draw counted before its test armed the counters");
  return currentCounts;
}

/** The render object's own bind groups, which the renderer creates once and then keeps. */
const groups = new WeakMap<InstancedMesh, IGroup>();

/** A bind group, as the renderer keeps it: the layout it reads and the buffers it hands the GPU. */
interface IGroup {
  readonly bindings: object[];
}

interface IBackendData {
  buffer?: object;
  layout?: { layoutGPU: object };
  /** What `Bindings` records once it created the group, and what it reads to know it exists. */
  bindGroup?: object;
}

/** What the backend holds per bind group and per uniform buffer. */
const backendData = new WeakMap<object, IBackendData>();

/** The slice of a RenderObject that the observer reads, plus the counters the draws call through. */
interface ICounted {
  objectGroupWrites: number;
  objectNodeUpdates: number;
  frameNodeUpdates: number;
  attributeScans: number;
  /** The attributes whose upload this draw asked the backend for, by identity. */
  uploads: object[];
  layoutsBuilt: number;
  /** `backend.updateBindings` calls: a bind group was rebuilt over its current textures. */
  bindGroupsRebuilt: number;
}

function worldFor(mesh: InstancedMesh) {
  return {
    object: mesh,
    geometry: mesh.geometry,
    material: mesh.material,
    bundle: null as null,
    lightsNode: { getLights: () => [] },
    scene: { environmentIntensity: 1, environmentRotation: new Quaternion() },
  };
}

/** A real observer over a real lit node material, as a render object would hold. */
function observerFor(mesh: InstancedMesh) {
  return new NodeMaterialObserver({
    material: mesh.material,
    object: mesh,
    context: {},
  } as never) as unknown as {
    isSettled(renderObject: unknown): boolean;
    needsRefresh(renderObject: unknown, nodeFrame: unknown): boolean;
  };
}

/** The render object a previous draw cached for this mesh, primed once so it has a snapshot. */
function cachedWorld(mesh: InstancedMesh) {
  let world = renderObjects.get(mesh) as Record<string, unknown> | undefined;
  if (world === undefined) {
    world = { ...worldFor(mesh) };
    renderObjects.set(mesh, world);
  }
  return world as Record<string, never>;
}

/** The one question the renderer asks first on every draw, answered with no motion vectors. */
function prime(mesh: InstancedMesh, observer: ReturnType<typeof observerFor>): void {
  observer.needsRefresh(cachedWorld(mesh), { renderer: { getMRT: () => null } });
}

function litMesh(): InstancedMesh {
  const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardNodeMaterial(), 1);
  mesh.quaternion.copy(new Quaternion().setFromEuler(new Euler()));
  mesh.updateMatrixWorld();
  return mesh;
}

/** Creates a bind group and the buffers it hands the GPU, as `Bindings._createBindings` does. */
function createGroup(group: IGroup): void {
  // `bindGroup` is how `Bindings._update` knows this group is not one a node added after the fact.
  backendData.set(group, { layout: { layoutGPU: {} }, bindGroup: group });
  for (const binding of group.bindings)
    if ((binding as { isUniformBuffer?: boolean }).isUniformBuffer === true)
      backendData.set(binding, { buffer: {} });
}

/**
 * The draw-time call sites a settled object skips, counted through real three methods.
 *
 * `appears` is a bind group a node created after the render object's own bindings were - the
 * renderer has no layout or buffer for it, and only the update that walks its bindings builds them.
 */
function draw(mesh: InstancedMesh, observer: ReturnType<typeof observerFor>, appears?: IGroup[]) {
  const counts: ICounted = {
    objectGroupWrites: 0,
    objectNodeUpdates: 0,
    frameNodeUpdates: 0,
    attributeScans: 0,
    uploads: [],
    layoutsBuilt: 0,
    bindGroupsRebuilt: 0,
  };
  let renderObject = renderObjects.get(mesh) as Record<string, unknown> | undefined;
  renderObject ??= {};
  renderObjects.set(mesh, renderObject);
  Object.assign(renderObject, {
    ...worldFor(mesh),
    getMonitor: () => observer,
    getNodeBuilderState: () => ({
      updateNodes: [objectNode(counts), frameNode(counts)],
      updateBeforeNodes: [objectBeforeNode(counts)],
      updateAfterNodes: [],
    }),
  });
  const renderId = (renderCalls.get(mesh) ?? 1) + 1;
  renderCalls.set(mesh, renderId);
  currentCall.id = renderId;
  currentCounts = counts;
  const render = { renderId, frameId: renderId, renderer: { getMRT: () => null } };
  (renderObject as { frame?: unknown }).frame = render;
  const nodes = {
    isSettled: () => observer.isSettled(renderObject),
    getNodeFrameForRender: () => ({
      updateNode: (node: { update: () => void }) => node.update(),
      updateBeforeNode: (node: { updateBefore: () => void }) => node.updateBefore(),
      updateAfterNode: (node: { updateAfter: () => void }) => node.updateAfter(),
      ...render,
    }),
  };
  // A camera that moved between the frames: nothing about the object changed, so nothing it feeds
  // may go stale. The model-view product is built on the GPU out of the two per-object values the
  // settled path keeps, which is what makes the skip safe.
  // What the renderer asks first, on every draw: the refresh is still answered, and the
  // observer learns whether this frame produces motion vectors.
  observer.needsRefresh(renderObject, render);

  NodeManager.prototype.updateForRender.call(nodes, renderObject);
  NodeManager.prototype.updateBefore.call(nodes, renderObject);

  // The vertex attributes this draw reads, with the versions a writer bumps.
  const attributes = [mesh.geometry.getAttribute("position"), mesh.instanceMatrix];
  Object.assign(renderObject, { getAttributes: () => attributes });
  (renderObject as { index?: unknown }).index = mesh.geometry.index;

  let manager = geometries.get(mesh);
  if (manager === undefined) {
    manager = {
      attributeCall: new WeakMap(),
      wireframes: new WeakMap(),
      _settledAttributes: new WeakMap(),
      has: () => true,
      updateAttributes(this: object, target: unknown) {
        liveCounts().attributeScans += 1;
        return Geometries.prototype.updateAttributes.call(this, target);
      },
      updateAttribute: Geometries.prototype.updateAttribute,
      getIndex: Geometries.prototype.getIndex,
      attributesChanged: Geometries.prototype.attributesChanged,
      attributes: {
        update: (attribute: object) => {
          liveCounts().uploads.push(attribute);
        },
      },
      info: {
        render: {
          get calls() {
            return currentCall.id;
          },
        },
      },
    };
    geometries.set(mesh, manager);
  }
  // One manager per mesh, not per draw: the settled snapshot it keeps is the whole point, and a
  // manager rebuilt every draw would never see an unchanged attribute.
  Geometries.prototype.updateForRender.call(manager, renderObject);

  let mine = groups.get(mesh);
  if (mine === undefined) {
    mine = { bindings: [objectGroupBinding(), textureBinding()] };
    groups.set(mesh, mine);
  }
  const drawn = appears === undefined ? [mine] : [mine, ...appears];
  if (created.has(mesh) === false) {
    created.add(mesh);
    for (const group of [mine]) createGroup(group);
  }
  const entry = (key: object) => {
    let data = backendData.get(key);
    if (data === undefined) {
      data = {};
      backendData.set(key, data);
    }
    return data;
  };
  const backend = {
    get: entry,
    createUniformBuffer: (binding: object) => {
      entry(binding).buffer = {};
    },
    createBindings: (bindGroup: object) => {
      counts.layoutsBuilt += 1;
      entry(bindGroup).layout = { layoutGPU: {} };
    },
    updateBinding: () => undefined,
    updateBindings: () => {
      counts.bindGroupsRebuilt += 1;
    },
  };
  Bindings.prototype.updateForRender.call(
    {
      getForRender: () => drawn,
      nodes: {
        backend,
        isSettled: () => observer.isSettled(renderObject),
        updateGroup: NodeManager.prototype.updateGroup,
        groupsData: new Map(),
      },
      backend,
      get: (key: object) => backend.get(key),
      info: { createUniformBuffer: () => undefined },
      _createBindings: Bindings.prototype._createBindings,
      textures: {
        get: () => ({ generation: textureGeneration, bindGroups: new Set() }),
        updateTexture: () => undefined,
        needsMipmaps: () => false,
      },
      pipelines: {},
      _updateBindings: Bindings.prototype._updateBindings,
      _update: Bindings.prototype._update,
    },
    renderObject,
  );
  return { counts, settled: observer.isSettled(renderObject) };
}

function objectNode(_counts: ICounted) {
  return {
    updateType: NodeUpdateType.OBJECT,
    getUpdateType: () => NodeUpdateType.OBJECT,
    update: () => {
      liveCounts().objectNodeUpdates += 1;
    },
  };
}

function objectBeforeNode(_counts: ICounted) {
  return {
    updateBeforeType: NodeUpdateType.OBJECT,
    getUpdateBeforeType: () => NodeUpdateType.OBJECT,
    updateBefore: () => {
      liveCounts().objectNodeUpdates += 1;
    },
  };
}

function frameNode(_counts: ICounted) {
  return {
    updateType: NodeUpdateType.FRAME,
    getUpdateType: () => NodeUpdateType.FRAME,
    update: () => {
      liveCounts().frameNodeUpdates += 1;
    },
  };
}

function objectGroupBinding() {
  return {
    isUniformBuffer: true,
    isBuffer: true,
    updateRanges: [],
    groupNode: { updateType: NodeUpdateType.OBJECT, version: 1 },
    update: () => {
      liveCounts().objectGroupWrites += 1;
      return true;
    },
  };
}

/** A sampled texture in an object group: three's default group for a `texture()` node. */
function objectGroupTexture() {
  return {
    isSampledTexture: true,
    isBuffer: true,
    updateRanges: [],
    generation: 0,
    groupNode: { updateType: NodeUpdateType.OBJECT, version: 1 },
    texture: { id: 9, version: 1 },
    update: () => true,
  };
}

function textureBinding() {
  return {
    isSampledTexture: true,
    isBuffer: true,
    updateRanges: [],
    groupNode: { updateType: NodeUpdateType.RENDER, version: 2 },
    texture: { id: 7, version: 3 },
    update: () => {
      liveCounts().objectGroupWrites += 1;
      return true;
    },
  };
}

describe("a settled static object skips the per-object draw work", () => {
  it("settles on the second draw and keeps the frame-scoped updates", () => {
    const mesh = litMesh();
    mesh.static = true;
    const observer = observerFor(mesh);

    const first = draw(mesh, observer);
    expect(first.settled).toBe(false);
    expect(first.counts).toMatchObject({
      objectGroupWrites: 2,
      objectNodeUpdates: 2,
      frameNodeUpdates: 1,
      attributeScans: 1,
    });

    // The first settled draw is the one that records which attribute versions it holds, so it
    // pays for the scan it then compares against; every settled draw after it is quiet.
    const second = draw(mesh, observer);
    expect(second.settled).toBe(true);
    expect(second.counts).toMatchObject({
      objectGroupWrites: 1,
      objectNodeUpdates: 0,
      frameNodeUpdates: 1,
      attributeScans: 1,
    });

    const third = draw(mesh, observer);
    expect(third.counts).toMatchObject({
      objectGroupWrites: 1,
      objectNodeUpdates: 0,
      frameNodeUpdates: 1,
      attributeScans: 0,
    });
  });

  it("builds a group a node adds after the object's first draw", () => {
    // "No bind group set at group index 1": a node can add a group to an object that has been drawn
    // already, so the one draw that creates this object's groups is not the last one that matters.
    // The pipeline reads every group's layout, so a group this draw skipped is a layout that was
    // never built - the error this whole settled path was reverted for three times.
    const mesh = litMesh();
    mesh.static = true;
    const observer = observerFor(mesh);
    draw(mesh, observer);
    expect(draw(mesh, observer).settled).toBe(true);

    const late: IGroup = { bindings: [objectGroupBinding()] };
    const settled = draw(mesh, observer, [late]);
    expect(settled.settled, "a settled draw is still a draw").toBe(true);
    expect(settled.counts.layoutsBuilt, "the late group is built").toBe(1);
    expect(backendData.get(late)?.layout?.layoutGPU, "a group with no layout").toBeDefined();
    // Never seen before, so never written: a settled draw writes the group it just created.
    expect(settled.counts.objectGroupWrites, "texture binding + the new group").toBe(2);
  });

  it("rebuilds a settled static object's bind group when its sampled texture is re-created", () => {
    // The output pass samples the frame buffer target. A resolution-scale change makes three destroy
    // that GPU texture and give the target a new generation; a settled object that skips the
    // texture binding keeps the old bind group, and every submit after it fails with "Destroyed
    // texture used in a submit" until the scale changes back.
    const mesh = litMesh();
    mesh.static = true;
    const observer = observerFor(mesh);
    draw(mesh, observer);
    expect(draw(mesh, observer).settled).toBe(true);

    textureGeneration = 0;
    const sampled: IGroup = { bindings: [objectGroupTexture()] };
    createGroup(sampled);
    const steady = draw(mesh, observer, [sampled]);
    expect(steady.settled).toBe(true);
    expect(steady.counts.bindGroupsRebuilt, "same texture generation: nothing to rebuild").toBe(0);

    textureGeneration = 1;
    const resized = draw(mesh, observer, [sampled]);
    textureGeneration = 0;
    expect(resized.settled, "a settled draw is still a draw").toBe(true);
    // Two groups hold a sampled texture: the object's own render-group one, which always follows,
    // and the object-group one this test adds, which a settled draw must not skip.
    expect(resized.counts.bindGroupsRebuilt, "the new texture reaches both bind groups").toBe(2);
  });

  it("runs every step of a draw that answered 'no refresh'", () => {
    // The failure three rounds ran: a settled draw went down a path that created no groups, so a
    // group a node added later was never built and the pipeline read a layout that did not exist.
    // Nothing here may be gated on the refresh answer again - each step decides for itself.
    const steps: string[] = [];
    const mesh = litMesh();
    mesh.static = true;
    const record = (name: string) => () => void steps.push(name);
    const renderer = {
      _currentRenderBundle: null,
      _objects: {
        get: () => ({ drawRange: mesh.geometry.drawRange, group: null, bundle: null }),
      },
      _nodes: {
        // What a settled object answers: no refresh, and its own work skipped from the inside.
        needsRefresh: () => false,
        updateBefore: record("before"),
        updateForRender: record("nodes"),
        updateAfter: record("after"),
      },
      _geometries: { updateForRender: record("geometries") },
      _bindings: { updateForRender: record("bindings") },
      _pipelines: { updateForRender: record("pipelines"), isReady: () => true },
      backend: { draw: record("draw") },
      info: {},
    };

    // @ts-expect-error Three's per-draw path is private.
    Renderer.prototype._renderObjectDirect.call(
      renderer as never,
      mesh,
      mesh.material,
      worldFor(mesh).scene,
      {} as never,
      {} as never,
      null,
      null,
      undefined,
    );

    expect(steps).toEqual([
      "before",
      "geometries",
      "nodes",
      "bindings",
      "pipelines",
      "draw",
      "after",
    ]);
  });

  it("a static object's first draw creates and writes its object group", () => {
    // `WebGPUPipelineUtils.createRenderPipeline` reads every bind group's layout, and the group is
    // created by the first draw that goes through the bindings. Skipping that draw is what leaves
    // the pipeline a `layoutGPU` of undefined.
    const mesh = litMesh();
    mesh.static = true;
    const observer = observerFor(mesh);
    const first = draw(mesh, observer);
    expect(first.settled).toBe(false);
    expect(first.counts.objectGroupWrites).toBe(2);
    const drawnGroup = groups.get(mesh);
    if (drawnGroup === undefined) throw new Error("a draw left no group to read the layout off");
    expect(backendData.get(drawnGroup)?.layout?.layoutGPU, "a group with no layout").toBeDefined();
  });

  it("never skips a static object's first draw, nor one that moved", () => {
    // The renderer's first question on every draw. `object.static` is set before the object has
    // ever been drawn, so answering from it alone skips the draw that creates this object's bind
    // groups - and the pipeline then reads a layout that was never built.
    const mesh = litMesh();
    mesh.static = true;
    const observer = observerFor(mesh) as ReturnType<typeof observerFor> & {
      hasNode: boolean;
      hasAnimation: boolean;
    };
    observer.hasNode = false;
    observer.hasAnimation = false;
    const world = cachedWorld(mesh);
    const frame = (renderId: number) =>
      ({
        renderId,
        renderer: { getMRT: () => null },
      }) as never;

    // The renderer asks once per draw and the frame's id is the same for every object in it.
    expect(observer.needsRefresh(world, frame(1))).toBe(true);
    expect(observer.needsRefresh(world, frame(1))).toBe(false);

    // A static object that moved has to refresh like any other: the object uniforms it skipped
    // are the ones its world matrix feeds.
    mesh.position.x = 4;
    mesh.updateMatrixWorld();
    expect(observer.needsRefresh(world, frame(2))).toBe(true);
    expect(observer.needsRefresh(world, frame(2))).toBe(false);
  });

  it("uploads an instance write on a settled static InstancedMesh", () => {
    const mesh = litMesh();
    mesh.static = true;
    const observer = observerFor(mesh);
    draw(mesh, observer);
    expect(draw(mesh, observer).settled).toBe(true);

    // A streaming batch: the records moved, the mesh did not, and the mesh stays settled - the
    // draw still has to see the records, because `instanceMatrix.needsUpdate` is the only thing
    // that says so.
    mesh.instanceMatrix.needsUpdate = true;
    const written = draw(mesh, observer);
    expect(written.settled).toBe(true);
    expect(written.counts.attributeScans).toBe(1);
    expect(written.counts.uploads).toContain(mesh.instanceMatrix);

    // Spent: the next settled draw has nothing new to upload.
    const quiet = draw(mesh, observer);
    expect(quiet.settled).toBe(true);
    expect(quiet.counts.attributeScans).toBe(0);
    expect(quiet.counts.uploads).toEqual([]);
  });

  it("refreshes a static object that moved, and settles again once it stops", () => {
    const mesh = litMesh();
    mesh.static = true;
    const observer = observerFor(mesh);
    expect(draw(mesh, observer).settled).toBe(false);
    expect(draw(mesh, observer).settled).toBe(true);

    mesh.position.x = 4;
    mesh.updateMatrixWorld();
    const moved = draw(mesh, observer);
    expect(moved.settled).toBe(false);
    expect(moved.counts).toMatchObject({
      objectGroupWrites: 2,
      objectNodeUpdates: 2,
      attributeScans: 1,
    });

    expect(draw(mesh, observer).settled).toBe(true);
  });

  it("refreshes a static object whose material or geometry was edited", () => {
    const mesh = litMesh();
    mesh.static = true;
    const observer = observerFor(mesh);
    draw(mesh, observer);
    expect(draw(mesh, observer).settled).toBe(true);

    (mesh.material as { version: number }).version += 1;
    expect(draw(mesh, observer).settled).toBe(false);
    expect(draw(mesh, observer).settled).toBe(true);

    (mesh.geometry as unknown as { version: number }).version += 1;
    expect(draw(mesh, observer).settled).toBe(false);
  });

  it("refreshes a static object the scene environment changed under", () => {
    const mesh = litMesh();
    mesh.static = true;
    const observer = observerFor(mesh);
    draw(mesh, observer);
    draw(mesh, observer);
    const world = cachedWorld(mesh);
    expect(observer.isSettled(world)).toBe(true);
    // The slice the observer reads, which `worldFor` built and only a test changes.
    const scene = world.scene as unknown as {
      environmentIntensity: number;
      environmentRotation: Euler;
    };

    // The scene's environment is not the object's, but its value lands in the object's uniforms.
    scene.environmentIntensity = 0.5;
    prime(mesh, observer);
    expect(observer.isSettled(world)).toBe(false);

    // Re-armed: the object settles again on the state it was last seen in.
    prime(mesh, observer);
    expect(observer.isSettled(world)).toBe(true);
    scene.environmentRotation.set(0, 0.5, 0);
    prime(mesh, observer);
    expect(observer.isSettled(world)).toBe(false);
  });

  it("never settles a moving object, and never settles while motion vectors render", () => {
    const mesh = litMesh();
    const observer = observerFor(mesh);
    for (let frame = 0; frame < 3; frame += 1) {
      mesh.position.x = frame;
      mesh.updateMatrixWorld();
      prime(mesh, observer);
      expect(observer.isSettled(cachedWorld(mesh))).toBe(false);
    }

    mesh.static = true;
    prime(mesh, observer);
    expect(observer.isSettled(cachedWorld(mesh))).toBe(false);
    prime(mesh, observer);
    expect(observer.isSettled(cachedWorld(mesh))).toBe(true);

    // A render that produces motion vectors needs every frame's values, static or not.
    const world = cachedWorld(mesh);
    (world as { frame?: unknown }).frame = { renderer: { getMRT: () => ({ has: () => true }) } };
    observer.needsRefresh(world, world.frame);
    expect(observer.isSettled(world)).toBe(false);
  });
});
