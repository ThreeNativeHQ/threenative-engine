import type { IRiggingModel } from "./model.js";
import { MAX_COLORS, NO_COLOR } from "./vendor/avbd2d/gpu/layout.js";
import { requiredAt, requiredValue } from "./vendor/required-at.js";

/** Windward83b25's bounded joint coloring. Contacts here only join a dynamic piece to a static proxy. */
export function riggingColors(model: IRiggingModel): Uint32Array<ArrayBuffer> {
  const bodies = model.solver.bodies;
  const neighbours = bodies.map(() => new Set<number>());
  const index = new Map(bodies.map((body, i) => [body, i]));
  for (const force of model.solver.forces) {
    if (force.bodyA === null || force.bodyA.mass <= 0 || force.bodyB.mass <= 0) continue;
    const a = requiredValue(index.get(force.bodyA), "joint bodyA");
    const b = requiredValue(index.get(force.bodyB), "joint bodyB");
    requiredAt(neighbours, a).add(b);
    requiredAt(neighbours, b).add(a);
  }
  if (model.proxies.some((proxy) => proxy.body.mass !== 0))
    throw new Error("TN_AVBD_COLORING: changing dynamic contact topology requires a rebuild.");
  const colors = new Uint32Array(bodies.length).fill(NO_COLOR);
  const order = bodies
    .map((_, i) => i)
    .filter((i) => requiredAt(bodies, i).mass > 0)
    .sort((a, b) => requiredAt(neighbours, b).size - requiredAt(neighbours, a).size);
  for (const i of order) {
    const used = new Set([...requiredAt(neighbours, i)].map((j) => requiredAt(colors, j)));
    let color = 0;
    while (used.has(color)) color++;
    if (color >= MAX_COLORS)
      throw new Error(`TN_AVBD_COLORING: ${color + 1} colors exceeds ${MAX_COLORS}.`);
    colors[i] = color;
  }
  assertRiggingColors(model, colors);
  return colors;
}

/** Validate the exact uploaded colors; the donor's PENDING counter does not check fixed colors. */
export function assertRiggingColors(model: IRiggingModel, colors: Uint32Array): void {
  const bodies = model.solver.bodies;
  if (!(colors instanceof Uint32Array) || colors.length !== bodies.length)
    throw new Error("TN_AVBD_COLORING: fixed color count must match the bounded bodies.");
  for (const [i, body] of bodies.entries()) {
    const color = requiredAt(colors, i);
    if (body.mass > 0 ? color >= MAX_COLORS : color !== NO_COLOR)
      throw new Error(`TN_AVBD_COLORING: body[${i}] has invalid fixed color ${color}.`);
  }
  const indices = new Map(bodies.map((body, i) => [body, i]));
  for (const [i, force] of model.solver.forces.entries()) {
    if (force.bodyA === null || force.bodyA.mass <= 0 || force.bodyB.mass <= 0) continue;
    const a = requiredValue(indices.get(force.bodyA), "joint bodyA");
    const b = requiredValue(indices.get(force.bodyB), "joint bodyB");
    if (requiredAt(colors, a) === requiredAt(colors, b))
      throw new Error(
        `TN_AVBD_COLORING: joint[${i}] bodies ${a}/${b} share fixed color ${requiredAt(colors, a)}.`,
      );
  }
}
