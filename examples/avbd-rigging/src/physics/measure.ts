import { fromSolverPoint } from "./frame.js";
import type { IRiggingModel } from "./model.js";
import type { IRiggingTopology } from "./topology.js";
import type { Rigid } from "./vendor/avbd3d/ref/body.js";
import { type IRawContact, collide } from "./vendor/avbd3d/ref/collide.js";
import { dot, mat3, rotate, rotateInv, sub3, transform, vec3 } from "./vendor/avbd3d/ref/math.js";
import { requiredAt } from "./vendor/required-at.js";

export function riggingPositions(model: IRiggingModel, bodies: Float32Array): Float32Array {
  const expected = model.solver.bodies.length * 40;
  if (!(bodies instanceof Float32Array) || bodies.length !== expected)
    throw new Error(`TN_AVBD_MEASUREMENT: body floats ${bodies?.length}, expected ${expected}.`);
  const positions = new Float32Array(model.bodyIndices.length * 3);
  const local = vec3();
  const rotated = vec3();
  for (let vertex = 0; vertex < model.bodyIndices.length; vertex++) {
    const body = requiredAt(model.bodyIndices, vertex) * 40;
    const q = bodies.subarray(body + 4, body + 8);
    if (q.length !== 4 || !q.every(Number.isFinite) || Math.abs(Math.hypot(...q) - 1) > 1e-3)
      throw new Error(`TN_AVBD_MEASUREMENT: invalid body quaternion at vertex ${vertex}.`);
    local.set(model.localPositions.subarray(vertex * 3, vertex * 3 + 3));
    rotate(rotated, q, local);
    for (let axis = 0; axis < 3; axis++) {
      const value = requiredAt(bodies, body + axis) + requiredAt(rotated, axis);
      if (!Number.isFinite(value))
        throw new Error(`TN_AVBD_MEASUREMENT: nonfinite vertex ${vertex} axis ${axis}.`);
      rotated[axis] = value;
    }
    positions.set(
      fromSolverPoint([requiredAt(rotated, 0), requiredAt(rotated, 1), requiredAt(rotated, 2)]),
      vertex * 3,
    );
  }
  return positions;
}

function distance(positions: Float32Array, a: number, b: number): number {
  return Math.hypot(
    ...[0, 1, 2].map(
      (axis) => requiredAt(positions, a * 3 + axis) - requiredAt(positions, b * 3 + axis),
    ),
  );
}
function percentile(values: number[], fraction: number): number {
  if (values.length === 0 || !values.every(Number.isFinite))
    throw new Error("TN_RIGGING_MEASUREMENT: missing or nonfinite edge observations.");
  values.sort((a, b) => a - b);
  return requiredAt(values, Math.ceil(fraction * values.length) - 1);
}

/** The same authored sail edges are observed independently of either solver's spring/joint graph. */
export function measureSailPositions(
  topology: IRiggingTopology,
  positions: Float32Array,
): { sailStretchP95: number; sailEdgeErrorP95: number } {
  const sail = topology.ranges.find((range) => range.name === "sail");
  if (
    sail === undefined ||
    !(positions instanceof Float32Array) ||
    positions.length !== sail.count * 3 ||
    !positions.every(Number.isFinite)
  )
    throw new Error("TN_RIGGING_MEASUREMENT: missing or nonfinite sail observations.");
  const stretches: number[] = [];
  const errors: number[] = [];
  for (let edge = 0; edge < topology.restLengths.length; edge++) {
    const a = requiredAt(topology.edges, edge * 2);
    const b = requiredAt(topology.edges, edge * 2 + 1);
    if (a < sail.offset || a >= sail.offset + sail.count) continue;
    const strain =
      distance(positions, a - sail.offset, b - sail.offset) /
        requiredAt(topology.restLengths, edge) -
      1;
    stretches.push(Math.max(0, strain));
    errors.push(Math.abs(strain));
  }
  return {
    sailStretchP95: percentile(stretches, 0.95),
    sailEdgeErrorP95: percentile(errors, 0.95),
  };
}

/** End-point extension is measured only where ropes were actually simulated. */
export function measurePositions(
  model: IRiggingModel,
  positions: Float32Array,
): { sailStretchP95: number; sailEdgeErrorP95: number; ropeExtensionMaximum: number } {
  if (
    !(positions instanceof Float32Array) ||
    positions.length !== model.topology.positions.length ||
    !positions.every(Number.isFinite)
  )
    throw new Error("TN_RIGGING_MEASUREMENT: missing or nonfinite position observations.");
  const sail = model.topology.ranges.find((range) => range.name === "sail");
  if (sail === undefined) throw new Error("TN_RIGGING_MEASUREMENT: reference sail is missing.");
  const sailMeasures = measureSailPositions(
    model.topology,
    positions.subarray(sail.offset * 3, (sail.offset + sail.count) * 3),
  );
  let ropeExtensionMaximum = Number.NEGATIVE_INFINITY;
  for (const rope of model.topology.ranges.filter((range) => range.name.startsWith("rope-"))) {
    const a = rope.offset;
    const b = a + rope.count - 1;
    ropeExtensionMaximum = Math.max(
      ropeExtensionMaximum,
      Math.max(0, distance(positions, a, b) / distance(model.topology.positions, a, b) - 1),
    );
  }
  if (!Number.isFinite(ropeExtensionMaximum))
    throw new Error("TN_RIGGING_MEASUREMENT: reference ropes are missing.");
  return {
    ...sailMeasures,
    ropeExtensionMaximum,
  };
}

export interface IRiggingSampleChecks {
  readback: boolean;
  ropeExtension: boolean;
  sailStretch: boolean;
  penetrationMaximum: boolean;
  fresh: boolean;
}

/** Numeric phase bounds remain the original PRD bounds; an unmeasured phase never passes. */
export function riggingSampleChecks(sample: {
  ropeExtensionMaximum: number;
  sailStretchP95: number;
  penetrationMaximum: number;
  readbackBytes: number;
  staleTicks: number;
}): IRiggingSampleChecks {
  if (
    ![sample.ropeExtensionMaximum, sample.sailStretchP95, sample.penetrationMaximum].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) ||
    ![sample.readbackBytes, sample.staleTicks].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("TN_AVBD_MEASUREMENT: invalid sampled acceptance bounds.");
  const observed = sample.readbackBytes > 0;
  return {
    readback: observed,
    ropeExtension: observed && sample.ropeExtensionMaximum <= 0.03,
    sailStretch: observed && sample.sailStretchP95 <= 0.05,
    penetrationMaximum: observed && sample.penetrationMaximum <= 0.02,
    fresh: observed && sample.staleTicks <= 120,
  };
}

interface IContactBodyWitness {
  position: number[];
  rotation: number[];
  fullSize: number[];
  sampledFullSize: number[];
  /** Uint32 aliases preserve packed metadata bits even when their float alias is NaN. */
  words: number[];
}
export interface IProxyContactWitness {
  contactSource: "pinned CPU box SAT reconstructed on sampled GPU poses";
  bodyIndex: number;
  proxyIndex: number;
  proxyName: string;
  topologyVertexIndices: number[];
  contactIndex: number;
  feature: number;
  contactKind: "faceA" | "faceB" | "edge";
  /** Clipped polygon index for face contacts, not an authored mesh vertex. */
  clipVertexIndex: number | null;
  featureAxes: { reference: number; incident: number } | { body: number; proxy: number };
  body: IContactBodyWitness;
  proxy: IContactBodyWitness;
  normal: number[];
  localA: number[];
  localB: number[];
  worldA: number[];
  worldB: number[];
  authoredWorldA: [number, number, number];
  authoredWorldB: [number, number, number];
  separation: number;
  penetration: number;
  /** Analytic point/OBB distances, not the GPU's cached manifold or contact margin. */
  signedDistances: {
    worldAOnBody: number;
    worldAOnProxy: number;
    worldBOnBody: number;
    worldBOnProxy: number;
  };
}

function boxSignedDistance(point: ArrayLike<number>, body: Rigid): number {
  if (!body.size.every((value) => Number.isFinite(value) && value > 0))
    throw new Error("TN_AVBD_MEASUREMENT: invalid contact body extent.");
  const local = rotateInv(vec3(), body.positionAng, sub3(vec3(), point, body.positionLin));
  const q = Array.from(local, (value, axis) => Math.abs(value) - requiredAt(body.size, axis) / 2);
  const result = Math.hypot(...q.map((value) => Math.max(value, 0))) + Math.min(Math.max(...q), 0);
  if (!Number.isFinite(result))
    throw new Error("TN_AVBD_MEASUREMENT: nonfinite box signed distance.");
  return result;
}
function contactBodyWitness(body: Rigid, index: number, bodies: Float32Array): IContactBodyWitness {
  return {
    position: Array.from(body.positionLin),
    rotation: Array.from(body.positionAng),
    fullSize: Array.from(body.size),
    sampledFullSize: Array.from(bodies.subarray(index * 40 + 16, index * 40 + 19)),
    words: Array.from(new Uint32Array(bodies.buffer, bodies.byteOffset + index * 160, 40)),
  };
}

/** Box/box SAT contacts on the actual simulated thin panels/segments, excluding self-collision. */
export function measureProxyPenetration(
  model: IRiggingModel,
  bodies: Float32Array,
  peak?: { previousMaximum: number; capture: (witness: IProxyContactWitness) => void },
): number {
  if (
    peak !== undefined &&
    (!Number.isFinite(peak.previousMaximum) ||
      peak.previousMaximum < 0 ||
      typeof peak.capture !== "function")
  )
    throw new Error("TN_AVBD_MEASUREMENT: invalid previous penetration maximum.");
  if (
    !(bodies instanceof Float32Array) ||
    bodies.length !== model.solver.bodies.length * 40 ||
    model.proxies.length === 0
  )
    throw new Error("TN_AVBD_MEASUREMENT: proxy/body observations are missing.");
  for (const [i, body] of model.solver.bodies.entries()) {
    const pose = bodies.subarray(i * 40, i * 40 + 8);
    const rotation = pose.subarray(4, 8);
    if (!pose.every(Number.isFinite) || Math.abs(Math.hypot(...rotation) - 1) > 1e-3)
      throw new Error(`TN_AVBD_MEASUREMENT: invalid proxy collision pose at body ${i}.`);
    body.positionLin.set(bodies.subarray(i * 40, i * 40 + 3));
    body.positionAng.set(bodies.subarray(i * 40 + 4, i * 40 + 8));
  }
  let deepest = 0;
  let winner:
    | {
        bodyIndex: number;
        proxyIndex: number;
        proxyName: string;
        contactIndex: number;
        contact: IRawContact;
        normal: number[];
        separation: number;
      }
    | undefined;
  const basis = mat3();
  const a = vec3();
  const b = vec3();
  const difference = vec3();
  for (let index = 0; index < model.secondaryCount; index++) {
    const body = requiredAt(model.solver.bodies, index);
    for (const proxy of model.proxies) {
      for (const [contactIndex, contact] of collide(body, proxy.body, basis).entries()) {
        transform(a, body.positionLin, body.positionAng, contact.rA);
        transform(b, proxy.body.positionLin, proxy.body.positionAng, contact.rB);
        const separation = dot(sub3(difference, a, b), basis.subarray(0, 3));
        if (!Number.isFinite(separation))
          throw new Error("TN_AVBD_MEASUREMENT: nonfinite proxy contact.");
        if (peak !== undefined && -separation > Math.max(deepest, peak.previousMaximum))
          winner = {
            bodyIndex: index,
            proxyIndex: proxy.index,
            proxyName: proxy.name,
            contactIndex,
            contact,
            normal: Array.from(basis.subarray(0, 3)),
            separation,
          };
        deepest = Math.max(deepest, -separation);
      }
    }
  }
  if (winner !== undefined && peak !== undefined) {
    const body = requiredAt(model.solver.bodies, winner.bodyIndex);
    const proxy = requiredAt(model.solver.bodies, winner.proxyIndex);
    transform(a, body.positionLin, body.positionAng, winner.contact.rA);
    transform(b, proxy.positionLin, proxy.positionAng, winner.contact.rB);
    const featureKind = winner.contact.feature >>> 24;
    if (featureKind > 2) throw new Error("TN_AVBD_MEASUREMENT: unknown contact feature.");
    peak.capture({
      contactSource: "pinned CPU box SAT reconstructed on sampled GPU poses",
      bodyIndex: winner.bodyIndex,
      proxyIndex: winner.proxyIndex,
      proxyName: winner.proxyName,
      topologyVertexIndices: Array.from(model.bodyIndices.entries())
        .filter(([, index]) => index === winner.bodyIndex)
        .map(([vertex]) => vertex),
      contactIndex: winner.contactIndex,
      feature: winner.contact.feature,
      contactKind: featureKind === 0 ? "faceA" : featureKind === 1 ? "faceB" : "edge",
      clipVertexIndex: featureKind === 2 ? null : winner.contact.feature & 255,
      featureAxes:
        featureKind === 2
          ? { body: (winner.contact.feature >>> 8) & 255, proxy: winner.contact.feature & 255 }
          : {
              reference: (winner.contact.feature >>> 16) & 255,
              incident: (winner.contact.feature >>> 8) & 255,
            },
      body: contactBodyWitness(body, winner.bodyIndex, bodies),
      proxy: contactBodyWitness(proxy, winner.proxyIndex, bodies),
      normal: winner.normal,
      localA: Array.from(winner.contact.rA),
      localB: Array.from(winner.contact.rB),
      worldA: Array.from(a),
      worldB: Array.from(b),
      authoredWorldA: fromSolverPoint([requiredAt(a, 0), requiredAt(a, 1), requiredAt(a, 2)]),
      authoredWorldB: fromSolverPoint([requiredAt(b, 0), requiredAt(b, 1), requiredAt(b, 2)]),
      separation: winner.separation,
      penetration: deepest,
      signedDistances: {
        worldAOnBody: boxSignedDistance(a, body),
        worldAOnProxy: boxSignedDistance(a, proxy),
        worldBOnBody: boxSignedDistance(b, body),
        worldBOnProxy: boxSignedDistance(b, proxy),
      },
    });
  }
  return deepest;
}
