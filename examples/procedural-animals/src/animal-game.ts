import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { rapier } from "@threenative/physics";
import type { IPhysicsContext } from "@threenative/physics";
import { type AnimalMode, Animals, type IAnimalsState } from "./Animals.js";
import { makeAnimalPerformanceGame } from "./performance-game.js";

export function makeAnimalGame(mode: AnimalMode) {
  if (mode !== "qualification") return makeAnimalPerformanceGame(mode);
  class Workload extends Animals {
    constructor() {
      super(mode);
    }
  }
  return defineGame<IAnimalsState, IPhysicsContext>({
    assets: { basePath: "" },
    input: { probe: { keys: ["KeyP"] }, advance: { keys: ["KeyN"] }, outside: { keys: ["KeyF"] } },
    plugins: [
      rapier(),
      playtest(),
      {
        setup(ctx, runtime) {
          if (!runtime?.geometryCapture) throw new Error("TN_ANIMAL_GEOMETRY_CAPTURE_UNAVAILABLE");
          const capture = runtime.geometryCapture;
          const expected = 32;
          let live = true;
          let pending = false;
          let visible = false;
          let outside = false;
          const remove = ctx.beforeRender(() => {
            if (ctx.startup.phase !== "ready" || pending) return;
            const offFrustum = ctx.state.getState().phase === "off-frustum";
            if (offFrustum ? outside : visible) return;
            pending = true;
            void capture({ limit: 500 })
              .then((report) => {
                if (!live) return;
                if (
                  report.status !== "captured" ||
                  report.inspectionComplete !== true ||
                  report.rowsTruncated ||
                  !report.objects
                )
                  throw new Error("TN_ANIMAL_GEOMETRY_CAPTURE_INCOMPLETE");
                const surfaces = new Map(
                  report.objects
                    .flatMap((row) => row.meshes)
                    .filter((mesh) => mesh.name.startsWith("wolf-surface-"))
                    .map((mesh) => [mesh.id, mesh]),
                );
                if (surfaces.size !== expected)
                  throw new Error(
                    `TN_ANIMAL_GEOMETRY_MISSING_SURFACES: ${surfaces.size}/${expected}`,
                  );
                let main = 0;
                let shadow = 0;
                for (const mesh of surfaces.values()) {
                  if (!mesh.visible || mesh.batchOwner !== undefined)
                    throw new Error("TN_ANIMAL_GEOMETRY_UNCOUNTED_SURFACE");
                  main += mesh.submissions.main?.draws ?? 0;
                  shadow += mesh.submissions.shadow?.draws ?? 0;
                  if (!offFrustum && mesh.submissions.main?.draws !== 1)
                    throw new Error("TN_ANIMAL_VISIBLE_SURFACE_NOT_SUBMITTED");
                }
                if (offFrustum) {
                  if (main !== 0) throw new Error("TN_ANIMAL_OFF_FRUSTUM_SUBMITTED");
                  outside = true;
                  ctx.state.set({ offFrustumCaptured: true, offFrustumMainDraws: main });
                } else {
                  visible = true;
                  ctx.state.set({
                    visibleCaptured: true,
                    visibleMainDraws: main,
                    visibleShadowDraws: shadow,
                  });
                  if (mode !== "qualification") remove();
                }
              })
              .catch((error) => {
                if (live) console.error(error);
              })
              .finally(() => {
                pending = false;
              });
          });
          return () => {
            live = false;
            remove();
          };
        },
      },
    ],
    render: { preferWebGPU: true },
    frameBudget: { reportEvery: 300 },
    scenes: { animals: Workload },
    start: "animals",
    seed: 7,
  });
}
