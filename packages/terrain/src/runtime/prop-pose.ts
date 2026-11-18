import { type IBaseRing, baseRingGap, footprintGap, staticLowestY } from "@threenative/core/world";
import { type BufferGeometry, type Material, Matrix4, Quaternion, Vector3 } from "three";
import type { IPlacement, IPlacementOverride } from "../core/types.js";

/** The ground under a placement: the height at the query, and the authored offset to add. */
export type PropGroundQuery = (
  placement: IPlacement,
  position: [number, number, number],
) => { height: number | null; offset: number };

/** One placed prop: the pose the game draws and the clearance it reports to the editor. */
export interface IPropInstance {
  material: Material;
  onTransform?: (transform: IPlacementOverride | undefined) => void;
  placement: IPlacement;
  pose: Matrix4;
  geometry: BufferGeometry;
  grounding: boolean;
  clearance: number | null;
  cragBaseClearance?: number;
  cragRingSamples?: number;
}

/** The pose a baked package record carries: the quaternion the bake authored for the placement. */
export interface IPropPoseOverride {
  readonly quaternion: readonly [number, number, number, number];
}

/** The result of grounding one prop: its matrix, and what the ground left underneath it. */
export interface IPropPose {
  readonly matrix: Matrix4;
  readonly grounding: boolean;
  readonly clearance: number | null;
  readonly cragBaseClearance?: number;
  readonly cragRingSamples?: number;
}

/**
 * How far a placement's own geometry sinks below the snapped surface, per asset family.
 *
 * The pose steps are mechanism (a lowest point meets the ground, a slope's downhill lip closes), but
 * which assets bury — and how deep — is the game's: a boulder is a rock that is part buried, a crag
 * collar is measured at its rim, and a flat footprint sinks on its downhill side. The package asks
 * these rules for each placement and applies them in one order.
 */
export interface IPropGroundRules {
  /** The share of its own height a placement sinks after the ground snap, or undefined to skip. */
  readonly burial?: (
    placement: IPlacement,
  ) => { readonly share: number; readonly crag: boolean } | undefined;
  /** True for a flat-footed placement whose downhill footprint is buried too. */
  readonly footprint?: (placement: IPlacement) => boolean;
  /** The gap, in metres, the footprint search may close. */
  readonly footprintThreshold?: number;
  /** True for a crag whose base ring is measured, so a buried stem cannot hold a hanging collar. */
  readonly baseRing?: (placement: IPlacement) => boolean;
  /** Clearance, in metres, a crag's measured rim keeps above the ground under it. */
  readonly baseRingClearance?: number;
}

/**
 * The quaternion a placement's own scatter numbers describe: the normal tilt, then the yaw.
 *
 * @requires npm i -D @threenative/terrain
 * @situation compose a placement's authored rotation before grounding it
 * @example const quaternion = authoredQuaternion(placement);
 */
export function authoredQuaternion(
  placement: IPlacement,
): readonly [number, number, number, number] {
  const up = new Vector3(0, 1, 0);
  const quaternion = new Quaternion();
  if (placement.alignToNormal)
    quaternion.setFromUnitVectors(up, new Vector3().fromArray(placement.normal));
  quaternion.multiply(new Quaternion().setFromAxisAngle(up, placement.rotation));
  return quaternion.toArray();
}

/**
 * A placement as a package record stores it: the authored pose becomes its transform, at one scale.
 *
 * A record holds position, quaternion and one uniform scale, so an edited placement's own transform
 * is folded down to the scale its record carries. The shape that scale removed is `propKey`'s ratio,
 * and the drawable model that ratio names carries it instead.
 *
 * @requires npm i -D @threenative/terrain
 * @situation fold an authored placement into the record transform the bake stores
 * @example const record = withAuthoredPose(placement);
 */
export function withAuthoredPose(placement: IPlacement): IPlacement {
  const scale = placement.transform?.scale ?? [placement.scale, placement.scale, placement.scale];
  const scalar = scale[0] === 0 ? 1 : scale[0];
  return {
    ...placement,
    transform: {
      grounding: placement.transform?.grounding ?? true,
      position: placement.transform?.position ?? placement.position,
      quaternion: (placement.transform?.quaternion ?? authoredQuaternion(placement)) as [
        number,
        number,
        number,
        number,
      ],
      scale: [scalar, scalar, scalar],
    },
  };
}

/**
 * The model a record draws: its asset, its variant, and the shape a non-uniform edit gave it.
 *
 * `WorldCells` names the model through the run the record sits in, so this key is what the container
 * stores. A placement with one uniform scale draws its variant as authored (`spruce:2`); a placement
 * the editor scaled unevenly draws a model of that shape (`spruce:2@1,0.5,0.5`), so the record stays
 * one uniform scale and the picture keeps the edit.
 *
 * @requires npm i -D @threenative/terrain
 * @situation name the model a baked or live placement record draws
 * @example const key = propKey(placement, 2);
 */
export function propKey(placement: IPlacement, variant: number): string {
  const key = `${placement.asset}:${variant}`;
  const scale = placement.transform?.scale ?? [placement.scale, placement.scale, placement.scale];
  const scalar = scale[0] === 0 ? 1 : scale[0];
  const ratio = scale.map((value) => value / scalar);
  const off = ratio.reduce((sum, value) => sum + (value - 1) ** 2, 0);
  return off < 1e-16 ? key : `${key}@${ratio.join(",")}`;
}

/**
 * The shape `propKey` wrote, so the loader scales the model the record's one scale cannot carry.
 *
 * @requires npm i -D @threenative/terrain
 * @situation scale a streamed model by the shape its record's single scale cannot carry
 * @example const ratio = propRatio("spruce:2@1,0.5,0.5");
 */
export function propRatio(key: string): [number, number, number] {
  const at = key.indexOf("@");
  if (at < 0) return [1, 1, 1];
  const ratio = key
    .slice(at + 1)
    .split(",")
    .map(Number);
  // A negative component is a mirror, which the renderer composes like any other shape.
  if (ratio.length !== 3 || ratio.some((value) => !Number.isFinite(value) || value === 0))
    throw new Error(`Prop key '${key}' does not name a usable shape.`);
  return [ratio[0] as number, ratio[1] as number, ratio[2] as number];
}

/**
 * The pose a prop draws at, grounded on the game's own height field.
 *
 * The record's quaternion, when present, replaces the rotation a live placement composes; every step
 * below it — the ground snap, the boulder burial, the flat-footprint sink and the crag base ring —
 * still runs, because the record is a pose and not an override of the pose. A placement with no
 * ground under it fails closed by its own id, so a streamed world cannot silently float.
 *
 * @requires npm i -D @threenative/terrain
 * @situation ground one baked prop record on the game's height field before streaming it
 * @constraint the burial, footprint and base-ring assets are the game's; the package applies them
 * @example const pose = preparePose(foot.geometry, material, record.placement, undefined, groundAt, rules);
 */
export function preparePose(
  geometry: BufferGeometry,
  _material: Material,
  placement: IPlacement,
  transform: IPlacementOverride | undefined,
  groundAt: PropGroundQuery,
  rules: IPropGroundRules,
  pose?: IPropPoseOverride,
): IPropPose {
  // Plain math, not a Mesh: on the owned engine every Object3D is an engine object, and a detached
  // Mesh per placement cost 30 s of the forest's load (218,816 placements, 0.14 ms each).
  const model = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    scale: new Vector3(1, 1, 1),
    matrix: new Matrix4(),
    updateMatrix() {
      this.matrix.compose(this.position, this.quaternion, this.scale);
    },
  };
  model.position.fromArray(transform?.position ?? placement.position);
  if (transform) {
    model.quaternion.fromArray(transform.quaternion);
    model.scale.fromArray(transform.scale);
  } else {
    model.quaternion.fromArray(pose?.quaternion ?? authoredQuaternion(placement));
    model.scale.setScalar(placement.scale);
  }
  const grounding = transform?.grounding ?? true;
  const ground = groundAt(placement, model.position.toArray());
  // GroundSnap's rule: the lowest posed point meets the surface, then the authored offset applies.
  let clearance: number | null = null;
  if (ground.height === null) {
    if (grounding)
      throw new Error(
        `Missing terrain ground for '${placement.id}' at ${JSON.stringify(model.position.toArray())}`,
      );
  } else {
    model.updateMatrix();
    clearance = staticLowestY(geometry, model.matrix) - ground.height;
    if (grounding) {
      model.position.y += ground.offset - clearance;
      clearance = ground.offset;
    }
  }
  // A boulder is a rock that is part buried: GroundSnap puts its lowest point on the surface, and on a
  // slope the downhill side then hangs in the air. Sinking it by a share of its own height closes that.
  const burial = grounding && !transform ? rules.burial?.(placement) : undefined;
  if (burial && ground.height !== null) {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box) {
      model.updateMatrix();
      const height = burial.crag
        ? box.clone().applyMatrix4(model.matrix).getSize(new Vector3()).y
        : (box.max.y - box.min.y) * model.scale.y;
      model.position.y -= burial.share * height;
    }
  }
  // Bury the flat footprint on the downhill side too; a centre-only snap leaves a visible lip.
  if (grounding && !transform && rules.footprint?.(placement)) {
    model.updateMatrix();
    let gap: number;
    try {
      gap = footprintGap(
        geometry,
        model.matrix,
        (x, z) => groundAt(placement, [x, 0, z]).height,
        rules.footprintThreshold ?? 0.08,
      );
    } catch (error) {
      throw new Error(`Missing ground under rock '${placement.id}'`, { cause: error });
    }
    model.position.y -= gap;
  }
  let cragBaseClearance: number | undefined;
  let cragRingSamples: number | undefined;
  if (grounding && !transform && rules.baseRing?.(placement)) {
    // Lowest rim vertex per angular sector: a narrow buried stem must not support a wide scan
    // collar hanging above the downhill ground.
    if (!geometry.boundingBox) throw new Error(`Crag '${placement.id}' has no bounds`);
    model.updateMatrix();
    let ring: IBaseRing;
    try {
      ring = baseRingGap(geometry, model.matrix, (x, z) => groundAt(placement, [x, 0, z]).height);
    } catch (error) {
      throw new Error(`Missing ground under crag ring '${placement.id}'`, { cause: error });
    }
    const highestGap = ring.gap;
    cragRingSamples = ring.samples;
    if (cragRingSamples < 4) throw new Error(`Incomplete base ring for crag '${placement.id}'`);
    const sink = Math.max(0, highestGap + (rules.baseRingClearance ?? 0.5));
    model.position.y -= sink;
    cragBaseClearance = highestGap - sink;
  }
  model.updateMatrix();
  if (!new Float32Array(model.matrix.elements).every(Number.isFinite))
    throw new Error(`Transform exceeds the renderer range for '${placement.id}'`);
  return {
    matrix: model.matrix.clone(),
    grounding,
    clearance,
    cragBaseClearance,
    cragRingSamples,
  };
}

/**
 * The pose and the transform an editor edited, prepared together so one write reports both.
 *
 * @requires npm i -D @threenative/terrain
 * @situation re-pose one prop the editor edited and keep the transform it reported
 * @example const prepared = preparePropTransform(instance, transform, groundAt, rules);
 */
export function preparePropTransform(
  instance: IPropInstance,
  transform: IPlacementOverride | undefined,
  groundAt: PropGroundQuery,
  rules: IPropGroundRules,
) {
  return {
    ...preparePose(
      instance.geometry,
      instance.material,
      instance.placement,
      transform,
      groundAt,
      rules,
    ),
    transform,
  };
}

/**
 * Writes a prepared pose onto the instance, reporting the transform only when the pose changed.
 *
 * @requires npm i -D @threenative/terrain
 * @situation write an edited prop's prepared pose back onto its instance
 * @example writePropTransform(instance, prepared);
 */
export function writePropTransform(
  instance: IPropInstance,
  prepared: ReturnType<typeof preparePropTransform>,
): void {
  const changed =
    !instance.pose.equals(prepared.matrix) || instance.grounding !== prepared.grounding;
  instance.pose.copy(prepared.matrix);
  instance.grounding = prepared.grounding;
  instance.clearance = prepared.clearance;
  instance.cragBaseClearance = prepared.cragBaseClearance;
  instance.cragRingSamples = prepared.cragRingSamples;
  if (changed) instance.onTransform?.(prepared.transform);
}

/**
 * The transform an instance's current pose describes.
 *
 * @requires npm i -D @threenative/terrain
 * @situation read an edited prop's current pose for the scene format
 * @example const transform = readPropTransform(instance);
 */
export function readPropTransform(instance: IPropInstance): IPlacementOverride {
  const matrix = instance.pose;
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, quaternion, scale);
  return {
    position: position.toArray(),
    quaternion: quaternion.normalize().toArray(),
    scale: scale.toArray(),
    grounding: instance.grounding,
  };
}
