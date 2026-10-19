import { Quaternion, Vector3 } from "three";
import { toSolverPoint, toSolverRotation } from "./frame.js";
import {
  type IRiggingInput,
  type IRiggingLimits,
  type IRiggingTopology,
  buildRiggingTopology,
} from "./topology.js";
import { Rigid } from "./vendor/avbd3d/ref/body.js";
import { Joint } from "./vendor/avbd3d/ref/forces.js";
import { Solver } from "./vendor/avbd3d/ref/solver.js";
import { isSail, sail } from "./vendor/avbd3d/shapes.js";
import { requiredAt } from "./vendor/required-at.js";

export interface IRiggingProxy {
  readonly name: string;
  readonly size: [number, number, number];
  readonly position: [number, number, number];
}
export interface IRiggingModel {
  readonly topology: IRiggingTopology;
  readonly solver: Solver;
  readonly anchors: { slot: number; position: [number, number, number] }[];
  readonly proxies: { index: number; body: Rigid; name: string }[];
  readonly bodyIndices: Uint32Array;
  readonly localPositions: Float32Array;
  readonly secondaryCount: number;
}

function vector(name: string, value: readonly number[], positive = false): void {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !Array.from(value).every(
      (v) =>
        typeof v === "number" &&
        Number.isFinite(Math.fround(v)) &&
        (!positive || Math.fround(v) > 0),
    )
  )
    throw new Error(
      `Rigging.${name} requires three finite Float32 ${positive ? "positive dimensions" : "coordinates"}.`,
    );
}

function point(topology: IRiggingTopology, vertex: number): [number, number, number] {
  return [0, 1, 2].map((axis) => requiredAt(topology.positions, vertex * 3 + axis)) as [
    number,
    number,
    number,
  ];
}

/** Windward's thin rigid patches and endpoint-connected segments; all dimensions remain authored. */
export function buildRiggingModel(
  input: IRiggingInput,
  proxies: readonly IRiggingProxy[],
  overrides: Partial<IRiggingLimits> = {},
): IRiggingModel {
  const topology = buildRiggingTopology(input, overrides);
  if (!Array.isArray(proxies)) throw new Error("Rigging.colliders must be an array.");
  if (proxies.length > topology.limits.colliders)
    throw new Error(
      `Rigging.colliders count ${proxies.length} exceeds capacity ${topology.limits.colliders}.`,
    );
  const names = new Set(topology.ranges.map((r) => r.name));
  for (const proxy of proxies) {
    if (typeof proxy?.name !== "string" || proxy.name.trim() === "" || names.has(proxy.name))
      throw new Error(`Rigging duplicate or invalid proxy ${proxy?.name}.`);
    names.add(proxy.name);
    vector(`${proxy.name}.size`, proxy.size, true);
    vector(`${proxy.name}.position`, proxy.position);
  }
  const joints =
    topology.edges.length / 2 -
    input.ropes.length +
    input.patches.reduce((n, patch) => n + patch.pinned.length * 2, 0) +
    input.ropes.reduce((n, rope) => n + rope.pinned.length, 0);
  if (joints > topology.limits.constraints)
    throw new Error(
      `Rigging.constraints count ${joints} exceeds capacity ${topology.limits.constraints}.`,
    );
  const bodyCount = topology.masses.length - input.ropes.length + proxies.length;
  if (bodyCount > topology.limits.particles)
    throw new Error(
      `Rigging.bodies count ${bodyCount} exceeds capacity ${topology.limits.particles}.`,
    );
  const solver = new Solver();
  // Windward 83b25 uses alpha=.95; the PRD fixes this workload at 60Hz.
  Object.assign(solver, { dt: 1 / 60, gravity: -9.81, iterations: 12, alpha: 0.95 });
  const anchors: IRiggingModel["anchors"] = [];
  const bodyIndices = new Uint32Array(topology.masses.length);
  const localPositions = new Float32Array(topology.positions.length);
  const pin = (
    body: Rigid,
    position: [number, number, number],
    local: [number, number, number],
  ): void => {
    anchors.push({ slot: solver.forces.length, position });
    new Joint(solver, null, body, position, local, Number.POSITIVE_INFINITY, 0);
  };
  let offset = 0;
  for (const patch of input.patches) {
    const dx = patch.width / (patch.columns - 1);
    const dy = patch.height / (patch.rows - 1);
    const count = patch.columns * patch.rows;
    const size: [number, number, number] = [dx * 0.92, dy * 0.92, 0.035];
    for (let v = 0; v < count; v++) {
      bodyIndices[offset + v] = solver.bodies.length;
      sail(
        new Rigid(
          solver,
          size,
          patch.totalMass / count / (size[0] * size[1] * size[2]),
          0.3,
          point(topology, offset + v),
        ),
      );
    }
    for (let edge = 0; edge < topology.edges.length; edge += 2) {
      const a = requiredAt(topology.edges, edge);
      const b = requiredAt(topology.edges, edge + 1);
      if (a < offset || a >= offset + count) continue;
      const pa = point(topology, a);
      const pb = point(topology, b);
      const half = pa.map((p, axis) => (requiredAt(pb, axis) - p) * 0.5);
      new Joint(
        solver,
        requiredAt(solver.bodies, requiredAt(bodyIndices, a)),
        requiredAt(solver.bodies, requiredAt(bodyIndices, b)),
        half,
        half.map((v) => -v),
        Number.POSITIVE_INFINITY,
        0.3,
      );
    }
    for (const v of patch.pinned) {
      const body = requiredAt(solver.bodies, requiredAt(bodyIndices, offset + v));
      const center = point(topology, offset + v);
      for (const sign of [-1, 1]) {
        const local: [number, number, number] = [sign * dx * 0.25, 0, 0];
        pin(body, [center[0] + local[0], center[1], center[2]], local);
      }
    }
    offset += count;
  }
  const rotation = new Quaternion();
  for (const rope of input.ropes) {
    const direction = new Vector3(...rope.end).sub(new Vector3(...rope.start));
    const length = direction.length() / rope.segments;
    rotation.setFromUnitVectors(new Vector3(1, 0, 0), direction.normalize());
    let previous: Rigid | undefined;
    for (let segment = 0; segment < rope.segments; segment++) {
      const a = point(topology, offset + segment);
      const b = point(topology, offset + segment + 1);
      const middle = a.map((v, axis) => (v + requiredAt(b, axis)) * 0.5);
      bodyIndices[offset + segment] = solver.bodies.length;
      localPositions[(offset + segment) * 3] = -length * 0.5;
      const body = new Rigid(
        solver,
        [length, 0.025, 0.025],
        rope.totalMass / rope.segments / (length * 0.025 * 0.025),
        0.3,
        middle,
      );
      body.positionAng.set(rotation.toArray());
      if (previous !== undefined)
        new Joint(
          solver,
          previous,
          body,
          [length * 0.5, 0, 0],
          [-length * 0.5, 0, 0],
          Number.POSITIVE_INFINITY,
          0,
        );
      previous = body;
    }
    bodyIndices[offset + rope.segments] = solver.bodies.length - 1;
    localPositions[(offset + rope.segments) * 3] = length * 0.5;
    for (const v of rope.pinned) {
      const body = requiredAt(solver.bodies, requiredAt(bodyIndices, offset + v));
      pin(body, point(topology, offset + v), [requiredAt(localPositions, (offset + v) * 3), 0, 0]);
    }
    offset += rope.segments + 1;
  }
  const secondaryCount = solver.bodies.length;
  const proxyBodies = proxies.map((proxy) => ({
    index: solver.bodies.length,
    name: proxy.name,
    body: new Rigid(solver, proxy.size, 0, 0.3, proxy.position),
  }));
  // Rotate the entire physical model, including world joints, without changing local geometry.
  // The pinned shader's wind/gust frame is z-up; changing only params.up would leave wind in xy.
  for (const body of solver.bodies) {
    body.positionLin.set(
      toSolverPoint([
        requiredAt(body.positionLin, 0),
        requiredAt(body.positionLin, 1),
        requiredAt(body.positionLin, 2),
      ]),
    );
    body.positionAng.set(toSolverRotation(Array.from(body.positionAng)));
  }
  for (const force of solver.forces)
    if (force instanceof Joint && force.bodyA === null)
      force.rA.set(
        toSolverPoint([requiredAt(force.rA, 0), requiredAt(force.rA, 1), requiredAt(force.rA, 2)]),
      );
  for (const [i, body] of solver.bodies.entries()) {
    if (
      !body.size.every((v) => Number.isFinite(Math.fround(v)) && Math.fround(v) > 0) ||
      !Number.isFinite(Math.fround(body.radius))
    )
      throw new Error(`Rigging.body[${i}].size exceeds Float32 representation.`);
    if (
      i < secondaryCount &&
      (!Number.isFinite(Math.fround(body.mass)) ||
        Math.fround(body.mass) <= 0 ||
        !Number.isFinite(Math.fround(1 / Math.fround(body.mass))) ||
        !Number.isFinite(
          Math.fround(Math.fround(body.mass) / Math.fround(Math.fround(1 / 60) ** 2)),
        ) ||
        !body.moment.every(
          (v) =>
            Number.isFinite(Math.fround(v)) &&
            Math.fround(v) > 0 &&
            Number.isFinite(Math.fround(1 / Math.fround(v))) &&
            Number.isFinite(Math.fround(Math.fround(v) / Math.fround(Math.fround(1 / 60) ** 2))),
        ))
    )
      throw new Error(`Rigging.body[${i}].mass or inertia exceeds Float32 representation.`);
  }
  // Match the pinned shader's Float32 operation order, including intermediate products.
  for (const [i, body] of solver.bodies.entries()) {
    if (!isSail(body)) continue;
    const pressureArea = Math.fround(
      Math.fround(Math.fround(0.72) * Math.fround(requiredAt(body.size, 0))) *
        Math.fround(requiredAt(body.size, 1)),
    );
    if (!Number.isFinite(Math.fround(pressureArea / Math.fround(body.mass))))
      throw new Error(`Rigging.body[${i}].sail drag exceeds Float32 representation.`);
  }
  for (const [i, force] of solver.forces.entries()) {
    if (
      !(force instanceof Joint) ||
      !Number.isFinite(Math.fround(force.torqueArm)) ||
      !force.rA.every((v) => Number.isFinite(Math.fround(v))) ||
      !force.rB.every((v) => Number.isFinite(Math.fround(v)))
    )
      throw new Error(`Rigging.joint[${i}].layout exceeds Float32 representation.`);
  }
  return {
    topology,
    solver,
    anchors,
    proxies: proxyBodies,
    bodyIndices,
    localPositions,
    secondaryCount,
  };
}
