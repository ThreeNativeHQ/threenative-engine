import type { ISceneJson } from "./gi.js";

const EPS = 1e-4;
const AXES = [0, 1, 2] as const;

type Scene = Pick<ISceneJson, "meshes" | "poses">;

/**
 * Two axis-aligned slabs whose faces lie in one plane, look the same way and overlap, with a pose
 * camera on the side they face. The overlap is a depth tie, and each engine settles it its own way:
 * the `cornell` floor and the side walls both ended at the open front, and Unreal drew the floor on
 * top of the four corner squares where ThreeNative drew the wall (PRD-646). A turned or tilted mesh
 * and a model instance cannot tie this way, so they are skipped.
 */
export function depthTies(scene: Scene): string[] {
  const slabs = scene.meshes.flatMap((m) => {
    const turn = (((m.rotationYDeg % 180) + 180) % 180) / 90;
    if (!Array.isArray(m.size) || Math.abs(turn - Math.round(turn)) > EPS) return [];
    if (Math.abs(m.rotationXDeg ?? 0) > EPS) return [];
    const [x, y, z] = m.size;
    const size: [number, number, number] = Math.round(turn) === 1 ? [z, y, x] : [x, y, z];
    return [{ name: m.name, at: m.position, size }];
  });
  const ties: string[] = [];
  for (const [i, a] of slabs.entries())
    for (const b of slabs.slice(i + 1))
      for (const axis of AXES)
        for (const sign of [-1, 1]) {
          const plane = a.at[axis] + (sign * a.size[axis]) / 2;
          if (Math.abs(plane - (b.at[axis] + (sign * b.size[axis]) / 2)) > EPS) continue;
          const area = AXES.filter((k) => k !== axis).reduce((product, k) => {
            const lo = Math.max(a.at[k] - a.size[k] / 2, b.at[k] - b.size[k] / 2);
            const hi = Math.min(a.at[k] + a.size[k] / 2, b.at[k] + b.size[k] / 2);
            return product * Math.max(0, hi - lo);
          }, 1);
          const seenBy = scene.poses
            .filter((p) => sign * (p.position[axis] - plane) > EPS)
            .map((p) => p.name);
          if (area > EPS && seenBy.length > 0)
            ties.push(
              `${a.name} / ${b.name} share the ${"xyz"[axis]}${sign > 0 ? "+" : "-"} face at ${plane.toFixed(3)} m (${area.toFixed(3)} m2), seen from ${seenBy.slice(0, 3).join(", ")}`,
            );
        }
  return ties;
}

/** The lines the gate prints under a failing scene: its depth ties, the first thing to rule out. */
export function depthTieNotes(scenes: readonly string[], read: (name: string) => Scene): string[] {
  return scenes.flatMap((name) =>
    depthTies(read(name)).map((tie) => `possible cause, ${name}: ${tie}`),
  );
}
