import type { Camera, Mesh, Scene } from "three";
import type { AnimalPerformanceCollector } from "./performance-collector.js";

interface IDrawInfo {
  frame: number;
  update(object: unknown, count: number, instanceCount: number): void;
}
function infoOf(renderer: unknown): IDrawInfo {
  const info = (renderer as { info?: Partial<IDrawInfo> } | undefined)?.info;
  if (
    !info ||
    !Number.isSafeInteger(info.frame) ||
    (info.frame ?? -1) < 0 ||
    typeof info.update !== "function"
  )
    throw new Error("TN_ANIMAL_PERFORMANCE_RENDER_INFO_UNAVAILABLE");
  return info as IDrawInfo;
}
/** Public callbacks label passes; the backend's public info.update confirms an actual draw. */
export function observeAnimalSubmissions(
  scene: Scene,
  camera: Camera,
  surfaces: readonly Mesh[],
  collector: AnimalPerformanceCollector,
  armed: () => boolean,
): () => void {
  if (surfaces.length !== collector.wolves || new Set(surfaces).size !== surfaces.length)
    throw new Error("TN_ANIMAL_PERFORMANCE_SURFACES");
  const identities = new Map(
    surfaces.map((surface, wolf) => {
      const count = surface.geometry.index?.count ?? surface.geometry.attributes.position?.count;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0)
        throw new Error("TN_ANIMAL_PERFORMANCE_SURFACE_GEOMETRY");
      return [surface, { wolf, count, shadowDepth: 0, drawCameras: [] as Camera[] }];
    }),
  );
  let live = true;
  let world: number | undefined;
  let installedInfo: IDrawInfo | undefined;
  const restorers: (() => void)[] = [];
  const installInfo = (info: IDrawInfo) => {
    if (installedInfo) {
      if (installedInfo !== info) throw new Error("TN_ANIMAL_PERFORMANCE_RENDER_INFO_CHANGED");
      return;
    }
    const priorUpdate = info.update;
    const observedUpdate: IDrawInfo["update"] = function (
      this: IDrawInfo,
      object,
      count,
      instanceCount,
    ) {
      priorUpdate.call(this, object, count, instanceCount);
      const identity = identities.get(object as Mesh);
      if (!live || world === undefined || !identity) return;
      if (
        info.frame !== world ||
        !Number.isSafeInteger(count) ||
        count !== identity.count ||
        instanceCount !== 1
      )
        throw new Error("TN_ANIMAL_PERFORMANCE_DRAW_INCOMPLETE");
      if (identity.shadowDepth > 0) collector.submitted(world, identity.wolf, "shadow");
      else if (identity.drawCameras.at(-1) === camera)
        collector.submitted(world, identity.wolf, "main");
      else throw new Error("TN_ANIMAL_PERFORMANCE_DRAW_PASS_UNAVAILABLE");
    };
    info.update = observedUpdate;
    installedInfo = info;
    restorers.push(() => {
      if (info.update !== observedUpdate)
        throw new Error("TN_ANIMAL_PERFORMANCE_INFO_HOOK_OWNERSHIP");
      info.update = priorUpdate;
    });
  };
  const before = scene.onBeforeRender;
  const after = scene.onAfterRender;
  const beforeObserved: Scene["onBeforeRender"] = function (this: Scene, ...args) {
    before.apply(this, args);
    if (!live || !armed() || args[2] !== camera) return;
    const info = infoOf(args[0]);
    installInfo(info);
    collector.beginWorld(info.frame);
    world = info.frame;
  };
  const afterObserved: Scene["onAfterRender"] = function (this: Scene, ...args) {
    after.apply(this, args);
    if (!live || args[2] !== camera || world === undefined) return;
    try {
      collector.endWorld(infoOf(args[0]).frame);
    } finally {
      world = undefined;
    }
  };
  scene.onBeforeRender = beforeObserved;
  scene.onAfterRender = afterObserved;
  restorers.push(
    () => {
      if (scene.onBeforeRender !== beforeObserved)
        throw new Error("TN_ANIMAL_PERFORMANCE_SCENE_HOOK_OWNERSHIP");
      scene.onBeforeRender = before;
    },
    () => {
      if (scene.onAfterRender !== afterObserved)
        throw new Error("TN_ANIMAL_PERFORMANCE_SCENE_HOOK_OWNERSHIP");
      scene.onAfterRender = after;
    },
  );
  for (const [surface, identity] of identities) {
    const priorBefore = surface.onBeforeShadow;
    const priorAfter = surface.onAfterShadow;
    const priorBeforeDraw = surface.onBeforeRender;
    const priorAfterDraw = surface.onAfterRender;
    const beforeShadow: Mesh["onBeforeShadow"] = function (this: Mesh, ...args) {
      identity.shadowDepth += 1;
      priorBefore.apply(this, args);
    };
    const afterShadow: Mesh["onAfterShadow"] = function (this: Mesh, ...args) {
      priorAfter.apply(this, args);
      identity.shadowDepth -= 1;
      if (identity.shadowDepth < 0) throw new Error("TN_ANIMAL_PERFORMANCE_SHADOW_ORDER");
    };
    const beforeDraw: Mesh["onBeforeRender"] = function (this: Mesh, ...args) {
      identity.drawCameras.push(args[2]);
      priorBeforeDraw.apply(this, args);
    };
    const afterDraw: Mesh["onAfterRender"] = function (this: Mesh, ...args) {
      let popped: Camera | undefined;
      try {
        priorAfterDraw.apply(this, args);
      } finally {
        popped = identity.drawCameras.pop();
      }
      if (popped !== args[2]) throw new Error("TN_ANIMAL_PERFORMANCE_DRAW_ORDER");
    };
    surface.onBeforeShadow = beforeShadow;
    surface.onAfterShadow = afterShadow;
    surface.onBeforeRender = beforeDraw;
    surface.onAfterRender = afterDraw;
    restorers.push(
      () => {
        if (surface.onBeforeShadow !== beforeShadow)
          throw new Error("TN_ANIMAL_PERFORMANCE_MESH_HOOK_OWNERSHIP");
        surface.onBeforeShadow = priorBefore;
      },
      () => {
        if (surface.onAfterShadow !== afterShadow)
          throw new Error("TN_ANIMAL_PERFORMANCE_MESH_HOOK_OWNERSHIP");
        surface.onAfterShadow = priorAfter;
      },
      () => {
        if (surface.onBeforeRender !== beforeDraw)
          throw new Error("TN_ANIMAL_PERFORMANCE_MESH_HOOK_OWNERSHIP");
        surface.onBeforeRender = priorBeforeDraw;
      },
      () => {
        if (surface.onAfterRender !== afterDraw)
          throw new Error("TN_ANIMAL_PERFORMANCE_MESH_HOOK_OWNERSHIP");
        surface.onAfterRender = priorAfterDraw;
      },
    );
  }
  return () => {
    if (!live) return;
    live = false;
    world = undefined;
    const errors: unknown[] = [];
    for (const restore of restorers.reverse()) {
      try {
        restore();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "TN_ANIMAL_PERFORMANCE_HOOK_RESTORE");
  };
}
