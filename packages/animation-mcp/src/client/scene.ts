import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  Box3,
  Clock,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ANCHOR_SPECS, type AnchorId, type AnchorInfo, detectedAnchor } from "../ops/landmarks.js";
import { detachedMotionAt } from "./detached-motion.js";

// The landmarks are the ones `animation_inspect` reports: one list, so the view cannot offer a
// bone the tools do not name.
export type { AnchorId, AnchorInfo } from "../ops/landmarks.js";
export interface TransformValue {
  readonly position: [number, number, number];
  readonly rotation: [number, number, number];
  readonly scale: [number, number, number];
}
interface LiveAnchor extends AnchorInfo {
  readonly object: Object3D;
  readonly marker: Mesh;
}
export interface SceneCallbacks {
  animations(value: readonly { duration: number; name: string }[]): void;
  anchors(value: readonly AnchorInfo[]): void;
  error(reason: string): void;
  time(value: number): void;
  transform(value: TransformValue): void;
}

export class CalibrationScene {
  readonly #world = new Scene();
  readonly #camera = new PerspectiveCamera(40, 1, 0.001, 10_000);
  readonly #renderer: WebGLRenderer;
  readonly #orbit: OrbitControls;
  readonly #gizmo: TransformControls;
  readonly #loader = new GLTFLoader();
  readonly #clock = new Clock();
  readonly #callbacks: SceneCallbacks;
  readonly #observer: ResizeObserver;
  #host?: Group;
  #hostMeshes: Object3D[] = [];
  #attached?: Group;
  #anchors: LiveAnchor[] = [];
  #activeAnchor?: LiveAnchor;
  #mixer?: AnimationMixer;
  #activeAction?: AnimationAction;
  #clips: AnimationClip[] = [];
  #activeClip?: AnimationClip;
  #playing = false;
  #detached = false;
  readonly #detachedReleasePosition = new Vector3();
  readonly #detachedReleaseQuaternion = new Quaternion();
  readonly #detachedDirection = new Vector3(1, 0, 0);
  #detachedReleaseTime = 0;
  #detachedElapsed = 0;
  #detachedFloorClearance = 0;
  #detachedHostHeight = 1;
  #hostBounds = new Box3();
  #hostHeight = 1;
  #attachedLength = 1;
  #attachedBaseScale = new Vector3(1, 1, 1);
  readonly #attachedLongAxis = new Vector3(1, 0, 0);
  #request = 0;
  #generation = 0;

  constructor(canvas: HTMLCanvasElement, callbacks: SceneCallbacks) {
    this.#callbacks = callbacks;
    this.#renderer = new WebGLRenderer({ antialias: true, canvas });
    this.#renderer.outputColorSpace = SRGBColorSpace;
    this.#renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.#world.background = new Color(0x0b100e);
    this.#orbit = new OrbitControls(this.#camera, canvas);
    this.#orbit.enableDamping = true;
    this.#gizmo = new TransformControls(this.#camera, canvas);
    this.#gizmo.setSize(0.7);
    this.#gizmo.addEventListener("change", () => this.#reportTransform());
    this.#gizmo.addEventListener("dragging-changed", (event) => {
      this.#orbit.enabled = !(event as { value?: boolean }).value;
    });
    this.#world.add(this.#gizmo.getHelper());
    const sky = new HemisphereLight(0xe8f1e9, 0x1c2922, 2.5);
    const key = new DirectionalLight(0xffffff, 3.2);
    key.position.set(4, 7, 5);
    const rim = new DirectionalLight(0x78b9ff, 1.4);
    rim.position.set(-4, 2, -3);
    this.#world.add(sky, key, rim, new GridHelper(20, 40, 0x33433a, 0x1b2520));
    this.#observer = new ResizeObserver(() => this.#fitCanvas(canvas));
    this.#observer.observe(canvas);
    this.#fitCanvas(canvas);
    this.#draw();
  }

  async load(hostPath: string, attachedPath: string, preferred: AnchorId): Promise<void> {
    const generation = ++this.#generation;
    try {
      const [hostFile, attachedFile] = await Promise.all([
        this.#loader.loadAsync(`/api/model?path=${encodeURIComponent(hostPath)}`),
        this.#loader.loadAsync(`/api/model?path=${encodeURIComponent(attachedPath)}`),
      ]);
      if (generation !== this.#generation) return;
      this.#clear();
      this.#host = hostFile.scene;
      this.#host.traverse((object) => {
        if ((object as Mesh).isMesh === true) this.#hostMeshes.push(object);
      });
      this.#world.add(this.#host);
      this.groundHost();
      this.#hostHeight = this.#hostBounds.getSize(new Vector3()).y || 1;
      this.#clips = hostFile.animations;
      this.#mixer = new AnimationMixer(this.#host);
      this.#callbacks.animations(this.#clips.map(({ duration, name }) => ({ duration, name })));
      this.#findAnchors();
      this.#activeAnchor = this.#anchors.find(({ id }) => id === preferred) ?? this.#anchors[0];

      this.#attached = attachedFile.scene;
      this.#attachedBaseScale.copy(this.#attached.scale);
      const size = new Box3().setFromObject(this.#attached).getSize(new Vector3());
      this.#attachedLength = Math.max(size.x, size.y, size.z) || 1;
      this.#attachedLongAxis.set(
        size.x >= size.y && size.x >= size.z ? 1 : 0,
        size.y > size.x && size.y >= size.z ? 1 : 0,
        size.z > size.x && size.z > size.y ? 1 : 0,
      );
      this.#snap(true);
      this.#frameHost();
    } catch (error) {
      this.#callbacks.error(error instanceof Error ? error.message : String(error));
    }
  }

  selectAnchor(id: AnchorId): void {
    const next = this.#anchors.find((candidate) => candidate.id === id);
    if (next === undefined) return;
    this.#activeAnchor = next;
    this.#snap(false);
  }

  setMode(mode: "rotate" | "scale" | "translate"): void {
    this.#gizmo.setMode(mode);
  }

  setDetached(value: boolean): TransformValue | undefined {
    if (this.#attached === undefined || this.#activeAnchor === undefined) return undefined;
    if (value === this.#detached) return this.#transformValue();
    if (value) {
      this.#world.attach(this.#attached);
      this.#detachedReleasePosition.copy(this.#attached.position);
      this.#detachedReleaseQuaternion.copy(this.#attached.quaternion);
      const hostCenter = this.#hostBounds.getCenter(new Vector3());
      this.#detachedDirection
        .set(
          this.#detachedReleasePosition.x - hostCenter.x,
          0,
          this.#detachedReleasePosition.z - hostCenter.z,
        )
        .normalize();
      if (this.#detachedDirection.lengthSq() < 1e-8) this.#detachedDirection.set(1, 0, 0);
      this.#detachedReleaseTime = this.#activeAction?.time ?? 0;
      this.#detachedElapsed = 0;
      this.#detachedHostHeight = this.#hostHeight;
      this.#activeAction?.setLoop(LoopOnce, 1);
      if (this.#activeAction !== undefined) this.#activeAction.clampWhenFinished = true;
      const bounds = new Box3().setFromObject(this.#attached, true);
      this.#detachedFloorClearance = Math.max(0, this.#attached.position.y - bounds.min.y);
    } else {
      this.#activeAction?.setLoop(LoopRepeat, Number.POSITIVE_INFINITY);
      if (this.#activeAction !== undefined) this.#activeAction.clampWhenFinished = false;
      this.#activeAnchor.object.attach(this.#attached);
    }
    this.#detached = value;
    this.#gizmo.attach(this.#attached);
    this.#reportTransform();
    return this.#transformValue();
  }

  setEditable(value: boolean): void {
    this.#gizmo.enabled = value;
    this.#gizmo.getHelper().visible = value;
  }

  groundHost(): void {
    const host = this.#host;
    if (host === undefined || this.#hostMeshes.length === 0) return;
    const measure = (): Box3 => {
      host.updateWorldMatrix(true, true);
      const bounds = new Box3();
      for (const mesh of this.#hostMeshes) bounds.expandByObject(mesh, true);
      return bounds;
    };
    const bounds = this.#alignBottomToFloor(host, measure);
    if (bounds === undefined) return;
    this.#hostBounds.copy(bounds);
    this.#hostHeight = this.#hostBounds.getSize(new Vector3()).y || 1;
  }

  setTransform(value: TransformValue): void {
    if (this.#attached === undefined) return;
    this.#attached.position.fromArray(value.position);
    this.#attached.rotation.set(
      (value.rotation[0] * Math.PI) / 180,
      (value.rotation[1] * Math.PI) / 180,
      (value.rotation[2] * Math.PI) / 180,
    );
    this.#attached.scale.fromArray(value.scale);
    this.#reportTransform();
  }

  sizeToHost(ratio: number): void {
    if (this.#attached === undefined || this.#activeAnchor === undefined) return;
    const worldScale = this.#activeAnchor.object.getWorldScale(new Vector3());
    const parentScale = Math.max(
      Math.abs(worldScale.x),
      Math.abs(worldScale.y),
      Math.abs(worldScale.z),
    );
    if (parentScale < 1e-8) return;
    const scalar = (this.#hostHeight * ratio) / (this.#attachedLength * parentScale);
    this.#attached.scale.copy(this.#attachedBaseScale).multiplyScalar(scalar);
    this.#reportTransform();
  }

  useClip(name: string): void {
    this.#mixer?.stopAllAction();
    this.#activeAction = undefined;
    this.#activeClip = this.#clips.find((clip) => clip.name === name);
    if (this.#activeClip === undefined || this.#mixer === undefined) return;
    const action = this.#mixer.clipAction(this.#activeClip);
    this.#activeAction = action;
    action.play();
    action.paused = false;
    this.#mixer.setTime(0);
    action.paused = !this.#playing;
    this.groundHost();
  }

  play(value: boolean): void {
    this.#playing = value;
    if (this.#activeClip !== undefined && this.#mixer !== undefined)
      this.#mixer.clipAction(this.#activeClip).paused = !value;
  }

  seek(normalized: number): void {
    if (
      this.#activeClip !== undefined &&
      this.#activeAction !== undefined &&
      this.#mixer !== undefined
    ) {
      const wasPaused = this.#activeAction.paused;
      this.#activeAction.paused = false;
      this.#mixer.setTime(this.#activeClip.duration * normalized);
      this.#activeAction.paused = wasPaused;
      this.groundHost();
      this.#detachedElapsed = Math.max(0, this.#activeAction.time - this.#detachedReleaseTime);
      this.#updateDetachedMotion(this.#detachedElapsed);
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.#request);
    this.#observer.disconnect();
    this.#orbit.dispose();
    this.#gizmo.dispose();
    this.#renderer.dispose();
  }

  #findAnchors(): void {
    if (this.#host === undefined) return;
    const named: Object3D[] = [];
    this.#host.traverse((object) => {
      if (object.name) named.push(object);
    });
    const center = this.#hostBounds.getCenter(new Vector3());
    const size = this.#hostBounds.getSize(new Vector3());
    const estimates: Record<AnchorId, Vector3> = {
      head: new Vector3(center.x, this.#hostBounds.max.y, center.z),
      hips: new Vector3(center.x, this.#hostBounds.min.y + size.y * 0.52, center.z),
      "left-foot": new Vector3(center.x - size.x * 0.16, this.#hostBounds.min.y, center.z),
      "left-hand": new Vector3(
        this.#hostBounds.min.x,
        this.#hostBounds.min.y + size.y * 0.63,
        center.z,
      ),
      "right-foot": new Vector3(center.x + size.x * 0.16, this.#hostBounds.min.y, center.z),
      "right-hand": new Vector3(
        this.#hostBounds.max.x,
        this.#hostBounds.min.y + size.y * 0.63,
        center.z,
      ),
    };
    const geometry = new SphereGeometry(this.#hostHeight * 0.013, 12, 8);
    const names = named.map((candidate) => candidate.name);
    this.#anchors = ANCHOR_SPECS.map((spec) => {
      const detected = detectedAnchor(spec, names);
      let object = named.find((candidate) => candidate.name === detected);
      const source = object === undefined ? "estimated" : "detected";
      if (object === undefined) {
        object = new Group();
        object.name = `estimated-${spec.id}`;
        object.position.copy(
          this.#host?.worldToLocal(estimates[spec.id].clone()) ?? estimates[spec.id],
        );
        this.#host?.add(object);
      }
      const marker = new Mesh(
        geometry,
        new MeshBasicMaterial({ color: source === "detected" ? 0xb7f34a : 0x71b9ff }),
      );
      this.#world.add(marker);
      return { id: spec.id, label: spec.label, marker, node: object.name, object, source };
    });
    this.#callbacks.anchors(
      this.#anchors.map(({ object: _object, marker: _marker, ...info }) => info),
    );
  }

  #snap(autoSize: boolean): void {
    if (this.#attached === undefined || this.#activeAnchor === undefined) return;
    this.#attached.removeFromParent();
    this.#activeAnchor.object.add(this.#attached);
    this.#detached = false;
    this.#attached.position.set(0, 0, 0);
    this.#attached.rotation.set(0, 0, 0);
    if (autoSize) this.sizeToHost(0.5);
    this.#gizmo.attach(this.#attached);
    this.#reportTransform();
  }

  #reportTransform(): void {
    const value = this.#transformValue();
    if (value !== undefined) this.#callbacks.transform(value);
  }

  #transformValue(): TransformValue | undefined {
    if (this.#attached === undefined) return undefined;
    return {
      position: this.#attached.position.toArray(),
      rotation: [
        (this.#attached.rotation.x * 180) / Math.PI,
        (this.#attached.rotation.y * 180) / Math.PI,
        (this.#attached.rotation.z * 180) / Math.PI,
      ],
      scale: this.#attached.scale.toArray(),
    };
  }

  #frameHost(): void {
    const center = this.#hostBounds.getCenter(new Vector3());
    const size = this.#hostBounds.getSize(new Vector3());
    const distance = Math.max(size.x, size.y, size.z) * 1.6;
    this.#orbit.target.copy(center);
    this.#camera.position.copy(center).add(new Vector3(distance * 0.7, distance * 0.25, distance));
    this.#camera.far = distance * 30;
    this.#camera.updateProjectionMatrix();
  }

  #clear(): void {
    this.#gizmo.detach();
    this.#mixer?.stopAllAction();
    this.#activeAction = undefined;
    this.#host?.removeFromParent();
    this.#attached?.removeFromParent();
    for (const { marker } of this.#anchors) marker.removeFromParent();
    this.#anchors = [];
    this.#hostMeshes = [];
  }

  #fitCanvas(canvas: HTMLCanvasElement): void {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    this.#renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
  }

  #draw = (): void => {
    const delta = Math.min(this.#clock.getDelta(), 0.05);
    if (this.#playing && this.#activeClip !== undefined && this.#mixer !== undefined) {
      this.#mixer.update(delta);
      this.groundHost();
      if (this.#detached) this.#detachedElapsed += delta;
      this.#updateDetachedMotion(this.#detachedElapsed);
      this.#callbacks.time(
        this.#detached && this.#activeAction !== undefined
          ? this.#activeAction.time / this.#activeClip.duration
          : (this.#mixer.time % this.#activeClip.duration) / this.#activeClip.duration,
      );
    }
    for (const anchor of this.#anchors) {
      anchor.object.getWorldPosition(anchor.marker.position);
      anchor.marker.visible = anchor !== this.#activeAnchor;
    }
    this.#orbit.update();
    this.#renderer.render(this.#world, this.#camera);
    this.#request = requestAnimationFrame(this.#draw);
  };

  #updateDetachedMotion(elapsed: number): void {
    if (!this.#detached || this.#attached === undefined) return;
    const motion = detachedMotionAt(
      elapsed,
      this.#detachedFloorClearance,
      this.#detachedHostHeight,
    );
    const tangent = new Vector3(-this.#detachedDirection.z, 0, this.#detachedDirection.x);
    this.#attached.position
      .copy(this.#detachedReleasePosition)
      .addScaledVector(this.#detachedDirection, motion.x)
      .addScaledVector(tangent, motion.z);
    this.#attached.position.y += motion.y;
    const tumble = new Quaternion().setFromAxisAngle(
      new Vector3(1, 0.35, 0.7).normalize(),
      motion.elapsed * 5.4,
    );
    this.#attached.quaternion.copy(this.#detachedReleaseQuaternion).multiply(tumble);
    if (motion.landed) {
      const longAxis = this.#attachedLongAxis.clone().applyQuaternion(this.#attached.quaternion);
      const flatAxis = longAxis.clone().setY(0);
      if (flatAxis.lengthSq() < 1e-8) flatAxis.set(1, 0, 0);
      const settle = new Quaternion().setFromUnitVectors(
        longAxis.normalize(),
        flatAxis.normalize(),
      );
      this.#attached.quaternion.premultiply(settle);
    }
    this.#attached.updateWorldMatrix(true, true);
    const bounds = new Box3().setFromObject(this.#attached, true);
    if (motion.landed || bounds.min.y < 0) {
      this.#alignBottomToFloor(this.#attached, () => {
        this.#attached?.updateWorldMatrix(true, true);
        return this.#attached === undefined
          ? new Box3().makeEmpty()
          : new Box3().setFromObject(this.#attached, true);
      });
    }
  }

  #alignBottomToFloor(object: Object3D, measure: () => Box3): Box3 | undefined {
    const initial = measure();
    if (!Number.isFinite(initial.min.y)) return undefined;
    const initialY = object.position.y;
    const probe = Math.max(initial.getSize(new Vector3()).y * 0.0001, 0.000_001);
    object.position.y = initialY + probe;
    const probed = measure();
    const response = (probed.min.y - initial.min.y) / probe;
    object.position.y =
      initialY -
      initial.min.y / (Number.isFinite(response) && Math.abs(response) > 1e-8 ? response : 1);
    return measure();
  }
}
