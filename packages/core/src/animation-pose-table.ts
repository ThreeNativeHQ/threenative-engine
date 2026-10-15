import {
  AnimationClip,
  AnimationMixer,
  Bone,
  type EulerOrder,
  Group,
  InterpolateLinear,
  type KeyframeTrack,
  LoopOnce,
  Matrix4,
  NormalAnimationBlendMode,
  type Object3D,
  PropertyBinding,
  type SkinnedMesh,
} from "three";

const ORDERS = ["XYZ", "YZX", "ZXY", "XZY", "YXZ", "ZYX"];

function animatedAncestor(root: Object3D): boolean {
  for (let node = root.parent; node !== null; node = node.parent)
    if (node.userData["threenative.animationRateState"] !== undefined) return true;
  return false;
}

interface IPoseBinding {
  readonly node: number;
  readonly track: KeyframeTrack;
  readonly suffix: string;
}

function localTransform(node: Object3D, euler: boolean, out: Float64Array, offset: number): void {
  node.position.toArray(out, offset);
  if (euler) {
    out[offset + 3] = node.rotation.x;
    out[offset + 4] = node.rotation.y;
    out[offset + 5] = node.rotation.z;
    out[offset + 6] = ORDERS.indexOf(node.rotation.order);
  } else node.quaternion.toArray(out, offset + 3);
  node.scale.toArray(out, offset + 7);
}

/** Internal bake inputs. Live references validate caller edits; canonical rest data permits phases to differ. */
export class PoseBasis {
  readonly #rest: Float64Array;
  readonly #scratch: Float64Array;
  readonly #parents: (Object3D | null)[];
  readonly #children: number[];
  readonly #names: string[];
  readonly #types: string[];
  readonly #inverses: Float64Array;
  readonly #skeleton;
  readonly #boneOrder: readonly Bone[];
  readonly #duration: number;
  readonly #blendMode;
  readonly #tracks;
  #evaluation = -1;
  readonly #observed: Float64Array;

  constructor(
    readonly root: Object3D,
    readonly rig: SkinnedMesh,
    readonly clip: AnimationClip,
    readonly nodes: readonly Object3D[],
    readonly bindings: readonly IPoseBinding[],
    readonly mask: readonly boolean[],
    readonly euler: readonly boolean[],
  ) {
    this.#skeleton = rig.skeleton;
    this.#boneOrder = rig.skeleton.bones.slice();
    this.#duration = clip.duration;
    this.#blendMode = clip.blendMode;
    this.#tracks = clip.tracks.map((track) => ({
      track,
      name: track.name,
      factory: Reflect.get(track, "createInterpolant") as unknown,
      timesRef: track.times,
      valuesRef: track.values,
      times: Array.from(track.times),
      values: Array.from(track.values),
    }));
    this.#rest = new Float64Array(nodes.length * 10);
    this.#scratch = new Float64Array(this.#rest.length);
    this.#observed = new Float64Array(this.#rest.length);
    this.#parents = nodes.map((node) => node.parent);
    this.#children = nodes.map((node) => node.children.length);
    this.#names = nodes.map((node) => node.name);
    this.#types = nodes.map((node) => node.type);
    for (let index = 1; index < nodes.length; index += 1)
      localTransform(nodes[index] as Object3D, euler[index] === true, this.#rest, index * 10);
    for (let index = 0; index < mask.length; index += 1) if (mask[index]) this.#rest[index] = 0;
    this.#inverses = new Float64Array(rig.skeleton.bones.length * 16);
    rig.skeleton.boneInverses.forEach((matrix, index) =>
      matrix.toArray(this.#inverses, index * 16),
    );
  }

  /** Animated components may change on evaluation, but public edits between evaluations decline lookup. */
  observed(evaluation: number): boolean {
    for (let index = 1; index < this.nodes.length; index += 1)
      localTransform(
        this.nodes[index] as Object3D,
        this.euler[index] === true,
        this.#scratch,
        index * 10,
      );
    if (this.#evaluation === evaluation) {
      for (let at = 10; at < this.#scratch.length; at += 1)
        if (this.#scratch[at] !== this.#observed[at]) return false;
    }
    this.#evaluation = evaluation;
    this.#observed.set(this.#scratch);
    return true;
  }

  /** A public local-pose edit happened after the logical tick; flushing must not overwrite it. */
  restoreEdits(evaluation: number): void {
    if (this.#evaluation !== evaluation) return;
    for (let index = 1; index < this.nodes.length; index += 1) {
      const node = this.nodes[index] as Object3D;
      const at = index * 10;
      for (let component = 0; component < 10; component += 1) {
        const value = this.#scratch[at + component] as number;
        if (value === this.#observed[at + component]) continue;
        if (component < 3) node.position.setComponent(component, value);
        else if (component >= 7) node.scale.setComponent(component - 7, value);
        else if (this.euler[index]) {
          if (component === 6) node.rotation.order = ORDERS[value] as EulerOrder;
          else Reflect.set(node.rotation, "xyz"[component - 3] as string, value);
        } else Reflect.set(node.quaternion, "xyzw"[component - 3] as string, value);
      }
    }
  }

  current(): boolean {
    if (animatedAncestor(this.root)) return false;
    if (
      this.clip.duration !== this.#duration ||
      this.clip.blendMode !== this.#blendMode ||
      this.clip.tracks.length !== this.#tracks.length
    )
      return false;
    for (let index = 0; index < this.#tracks.length; index += 1) {
      const previous = this.#tracks[index];
      const track = this.clip.tracks[index];
      if (previous === undefined || track === undefined) return false;
      if (
        track !== previous.track ||
        track.name !== previous.name ||
        Reflect.get(track, "createInterpolant") !== previous.factory ||
        track.times !== previous.timesRef ||
        track.values !== previous.valuesRef ||
        track.times.length !== previous.times.length ||
        track.values.length !== previous.values.length ||
        track.times.some((value, at) => value !== previous.times[at]) ||
        track.values.some((value, at) => value !== previous.values[at])
      )
        return false;
    }
    if (this.rig.skeleton !== this.#skeleton || this.rig.bindMode !== "attached") return false;
    for (let at = 0; at < 16; at += 1)
      if (this.rig.bindMatrix.elements[at] !== (at % 5 === 0 ? 1 : 0)) return false;
    for (let index = 0; index < this.nodes.length; index += 1) {
      const node = this.nodes[index] as Object3D;
      if (
        node.name !== this.#names[index] ||
        node.type !== this.#types[index] ||
        node.children.length !== this.#children[index] ||
        (index > 0 &&
          (node.parent !== this.#parents[index] ||
            !node.matrixAutoUpdate ||
            !node.matrixWorldAutoUpdate ||
            node.pivot !== null))
      )
        return false;
      if (index === 0) continue;
      localTransform(node, this.euler[index] === true, this.#scratch, index * 10);
      for (let at = index * 10; at < (index + 1) * 10; at += 1)
        if (
          !this.mask[at] &&
          (!Number.isFinite(this.#scratch[at]) || this.#scratch[at] !== this.#rest[at])
        )
          return false;
    }
    if (
      this.#skeleton.bones.length * 16 !== this.#inverses.length ||
      this.#skeleton.boneInverses.length !== this.#skeleton.bones.length
    )
      return false;
    for (let bone = 0; bone < this.#skeleton.bones.length; bone += 1) {
      if (this.#skeleton.bones[bone] !== this.#boneOrder[bone]) return false;
      const elements = (this.#skeleton.boneInverses[bone] as Matrix4).elements;
      for (let at = 0; at < 16; at += 1)
        if (!Number.isFinite(elements[at]) || elements[at] !== this.#inverses[bone * 16 + at])
          return false;
    }
    return true;
  }

  compatible(other: PoseBasis): boolean {
    if (
      !this.current() ||
      !other.current() ||
      this.clip !== other.clip ||
      this.nodes.length !== other.nodes.length ||
      this.#inverses.length !== other.#inverses.length
    )
      return false;
    for (let index = 0; index < this.nodes.length; index += 1) {
      if (
        this.#names[index] !== other.#names[index] ||
        this.#types[index] !== other.#types[index] ||
        this.nodes.indexOf(this.#parents[index] as Object3D) !==
          other.nodes.indexOf(other.#parents[index] as Object3D) ||
        this.euler[index] !== other.euler[index]
      )
        return false;
    }
    for (let at = 0; at < this.#rest.length; at += 1)
      if (this.#rest[at] !== other.#rest[at] || this.mask[at] !== other.mask[at]) return false;
    for (let at = 0; at < this.#inverses.length; at += 1)
      if (this.#inverses[at] !== other.#inverses[at]) return false;
    for (let bone = 0; bone < this.#skeleton.bones.length; bone += 1)
      if (
        this.nodes.indexOf(this.#skeleton.bones[bone] as Bone) !==
        other.nodes.indexOf(other.#skeleton.bones[bone] as Bone)
      )
        return false;
    return true;
  }
}

export function preparePoseBasis(
  root: Object3D,
  rig: SkinnedMesh,
  clip: AnimationClip,
): PoseBasis | undefined {
  if (animatedAncestor(root) || clip.blendMode !== NormalAnimationBlendMode) return undefined;
  if ((root as Bone).isBone || clip.tracks.length === 0 || rig.bindMode !== "attached")
    return undefined;
  for (let at = 0; at < 16; at += 1)
    if (rig.bindMatrix.elements[at] !== (at % 5 === 0 ? 1 : 0)) return undefined;
  const allowed = new Set<Object3D>(rig.skeleton.bones);
  for (const start of [rig, ...rig.skeleton.bones]) {
    let node: Object3D | null = start;
    while (node !== null && node !== root) {
      if ((node as Bone).isBone && !rig.skeleton.bones.includes(node as Bone)) return undefined;
      allowed.add(node);
      node = node.parent;
    }
    if (node !== root) return undefined;
  }
  allowed.add(root);
  const nodes: Object3D[] = [];
  root.traverse((node) => nodes.push(node));
  if (
    nodes.some((node) => !allowed.has(node)) ||
    rig.skeleton.bones.length === 0 ||
    rig.skeleton.boneInverses.length !== rig.skeleton.bones.length
  )
    return undefined;
  const mask = new Array<boolean>(nodes.length * 10).fill(false);
  mask.fill(true, 0, 10);
  const euler = new Array<boolean>(nodes.length).fill(false);
  const quaternion = new Set<number>();
  const bindings: IPoseBinding[] = [];
  for (const track of clip.tracks) {
    // Discrete discontinuities and smooth repeat endings cannot use linear LoopOnce samples.
    if (track.getInterpolation() !== InterpolateLinear) return undefined;
    let parsed: ReturnType<typeof PropertyBinding.parseTrackName>;
    try {
      parsed = PropertyBinding.parseTrackName(track.name);
    } catch {
      return undefined;
    }
    if (parsed.objectName !== undefined) return undefined;
    const target = PropertyBinding.findNode(root, parsed.nodeName) as Object3D | null;
    const index = target === null ? -1 : nodes.indexOf(target);
    if (index <= 0 || !(target as Bone).isBone) return undefined;
    const property = parsed.propertyName;
    const component = parsed.propertyIndex;
    let offset: number;
    let size: number;
    if (property === "position") {
      offset = 0;
      size = 3;
    } else if (property === "scale") {
      offset = 7;
      size = 3;
    } else if (property === "quaternion") {
      offset = 3;
      size = 4;
      quaternion.add(index);
    } else if (property === "rotation" && component !== undefined) {
      offset = 3;
      size = 3;
      euler[index] = true;
    } else return undefined;
    const axis = component === undefined ? undefined : "xyzw".indexOf(component);
    if (
      (axis !== undefined && (axis < 0 || axis >= size)) ||
      track.getValueSize() !== (axis === undefined ? size : 1) ||
      !track.times.every(Number.isFinite) ||
      !track.values.every(Number.isFinite)
    )
      return undefined;
    for (let at = 0; at < size; at += 1)
      if (axis === undefined || at === axis) mask[index * 10 + offset + at] = true;
    bindings.push({
      node: index,
      track,
      suffix: `.${property}${component === undefined ? "" : `[${component}]`}`,
    });
  }
  if (euler.some((enabled, index) => enabled && quaternion.has(index))) return undefined;
  const basis = new PoseBasis(root, rig, clip, nodes, bindings, mask, euler);
  return basis.current() ? basis : undefined;
}

/** One isolated asset evaluation; no live mixer, geometry, material or userData is cloned or changed. */
export function bakePoseTable(
  basis: PoseBasis,
  step: number,
  maxBytes: number,
): { readonly data: Float32Array; readonly segments: number } | undefined {
  if (!Number.isFinite(step) || step <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("Pose table requires a positive finite step and safe byte limit.");
  const duration = basis.clip.duration;
  const segments = Math.max(1, Math.ceil(duration / step));
  const floats = (segments + 1) * basis.rig.skeleton.bones.length * 16;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isSafeInteger(floats) ||
    segments > 16_777_215 ||
    floats * 4 > maxBytes ||
    !basis.current()
  )
    return undefined;
  const copies = basis.nodes.map((node) => {
    const clone = (node as Bone).isBone ? new Bone() : new Group();
    clone.name = node.name;
    if (node !== basis.root) {
      clone.position.copy(node.position);
      clone.quaternion.copy(node.quaternion);
      clone.scale.copy(node.scale);
      if (basis.euler[basis.nodes.indexOf(node)]) clone.rotation.copy(node.rotation);
    }
    return clone;
  });
  for (let index = 1; index < copies.length; index += 1)
    (
      copies[basis.nodes.indexOf((basis.nodes[index] as Object3D).parent as Object3D)] as Object3D
    ).add(copies[index] as Object3D);
  const tracks = basis.bindings.map(({ node, track, suffix }) => {
    const clone = track.clone();
    clone.name = `${(copies[node] as Object3D).uuid}${suffix}`;
    return clone;
  });
  const clip = new AnimationClip(basis.clip.name, duration, tracks, basis.clip.blendMode);
  const root = copies[0] as Object3D;
  const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const data = new Float32Array(floats);
  const matrix = new Matrix4();
  try {
    for (let frame = 0; frame <= segments; frame += 1) {
      mixer.setTime((frame * duration) / segments);
      root.updateMatrixWorld(true);
      basis.rig.skeleton.bones.forEach((bone, index) => {
        matrix.multiplyMatrices(
          (copies[basis.nodes.indexOf(bone)] as Object3D).matrixWorld,
          basis.rig.skeleton.boneInverses[index] as Matrix4,
        );
        matrix.toArray(data, (frame * basis.rig.skeleton.bones.length + index) * 16);
      });
    }
  } finally {
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
  }
  return data.every(Number.isFinite) ? { data, segments } : undefined;
}
