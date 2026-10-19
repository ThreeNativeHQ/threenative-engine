import type { ICtx, IGeometryCaptureReport } from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import type { IGPUResources } from "./gpu-resources.js";
import { type ILifetimeSample, MEMORY_FIELDS } from "./lifecycle-driver.js";

function count(value: unknown, channel: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`TN_ANIMAL_LIFECYCLE_MISSING_${channel}`);
  return value;
}

/** Read the completed public render observation, never an authored estimate. */
export function takeLifecycleCensus(
  ctx: Pick<ICtx<Record<string, unknown>, IPhysicsContext>, "renderer" | "physics" | "entities">,
  gpu: IGPUResources,
  report: IGeometryCaptureReport,
): ILifetimeSample {
  if (
    report.status !== "captured" ||
    report.inspectionComplete !== true ||
    report.rowsTruncated !== false ||
    !Array.isArray(report.objects)
  )
    throw new Error("TN_ANIMAL_LIFECYCLE_MISSING_GEOMETRY");
  count(report.tick, "GEOMETRY_TICK");
  const info = ctx.renderer.info;
  if (typeof info !== "object" || info === null)
    throw new Error("TN_ANIMAL_LIFECYCLE_MISSING_INFO");
  const frame = count(Reflect.get(info, "frame"), "FRAME");
  const reportedMemory: unknown = Reflect.get(info, "memory");
  if (typeof reportedMemory !== "object" || reportedMemory === null)
    throw new Error("TN_ANIMAL_LIFECYCLE_MISSING_MEMORY");
  const memory: Record<string, number> = {};
  for (const field of MEMORY_FIELDS)
    memory[field] = count(Reflect.get(reportedMemory, field), `MEMORY_${field}`);
  const entities = Object.keys(ctx.entities.snapshot()).sort();
  const meshes = new Map(
    report.objects
      .flatMap((row) => row.meshes)
      .filter((mesh) => mesh.name.startsWith("wolf-surface-"))
      .map((mesh) => [mesh.id, mesh]),
  );
  const surfaces: string[] = [];
  const mainDraws: number[] = [];
  const shadowDraws: number[] = [];
  for (const mesh of [...meshes.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!mesh.visible || mesh.batchOwner !== undefined || (mesh.unavailable?.length ?? 0) !== 0)
      throw new Error("TN_ANIMAL_LIFECYCLE_UNCOUNTED_SURFACE");
    surfaces.push(mesh.name);
    // An inspected surface without a pass submission has an observed zero draws.
    mainDraws.push(count(mesh.submissions.main?.draws ?? 0, "MAIN_DRAWS"));
    shadowDraws.push(count(mesh.submissions.shadow?.draws ?? 0, "SHADOW_DRAWS"));
  }
  return {
    frame,
    gpu,
    memory,
    bodies: count(ctx.physics.numBodies(), "BODY_COUNT"),
    entities,
    surfaces,
    mainDraws,
    shadowDraws,
  };
}
