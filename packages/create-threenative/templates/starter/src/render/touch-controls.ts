import {
  CircleGeometry,
  type ColorRepresentation,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  RingGeometry,
  Vector2,
} from "three";
import { palette } from "./palette.js";

const MOVE_RADIUS = 72;
const BUTTON_RADIUS = 62;
const EDGE = 36;

/** The knob's next point: `update` runs every frame, so it uses one instance. */
const knobPosition = new Vector2();

export interface ITouchPointer {
  readonly position: Vector2;
}

export interface ITouchViewport {
  readonly height: number;
  readonly width: number;
}

export interface ITouchInput {
  readonly jumpPressed: boolean;
  readonly move: Vector2;
}

function overlayMaterial(color: ColorRepresentation, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    opacity,
    transparent: true,
  });
}

function ringMesh(radius: number, material: MeshBasicMaterial): Mesh {
  return new Mesh(new RingGeometry(radius - 5, radius, 32), material);
}

function place(mesh: Mesh, point: Vector2): void {
  mesh.position.set(point.x, point.y, 0);
}

function controlPoint(size: ITouchViewport, name: "jump" | "move"): Vector2 {
  if (name === "move") return new Vector2(MOVE_RADIUS + EDGE, size.height - MOVE_RADIUS - EDGE);
  return new Vector2(size.width - BUTTON_RADIUS - EDGE, size.height - BUTTON_RADIUS - EDGE);
}

export class TouchControls {
  readonly root = new Group();
  readonly object = this.root;
  #camera: PerspectiveCamera;
  #input: { jumpPressed: boolean; move: Vector2 } = {
    jumpPressed: false,
    move: new Vector2(),
  };
  #wasJump = false;
  #moveAnchor = new Vector2();
  #resting = new Vector2();
  #jumpCenter = new Vector2();
  #hasMoveAnchor = false;
  #lastWidth = -1;
  #lastHeight = -1;
  #moveBase: Mesh;
  #moveKnob: Mesh;
  #jump: Mesh;
  #idleMaterial: MeshBasicMaterial;
  #activeMaterial: MeshBasicMaterial;

  constructor(camera: PerspectiveCamera) {
    this.#camera = camera;
    // The idle rings read against grass and sand, so they take the sky's own light tone: a green
    // ring vanishes into the island, and the pressed accent is the one colour nothing else uses.
    this.#idleMaterial = overlayMaterial(palette.skyHigh, 0.34);
    this.#activeMaterial = overlayMaterial(palette.accent, 0.6);
    this.#moveBase = ringMesh(MOVE_RADIUS, this.#idleMaterial);
    this.#moveKnob = new Mesh(new CircleGeometry(28, 24), this.#activeMaterial);
    this.#jump = ringMesh(BUTTON_RADIUS, this.#idleMaterial);
    this.root.add(this.#moveBase, this.#moveKnob, this.#jump);
    this.root.renderOrder = 10_001;
    camera.add(this.root);
  }

  update(pointers: ReadonlyMap<number, ITouchPointer>, size: ITouchViewport): ITouchInput {
    this.#ensureLayout(size);
    const jump = this.#at(pointers, this.#jumpCenter, BUTTON_RADIUS);
    let movement: ITouchPointer | undefined;
    for (const pointer of pointers.values()) {
      if (pointer.position.x < size.width * 0.5) {
        movement = pointer;
        break;
      }
    }

    if (movement === undefined) {
      this.#hasMoveAnchor = false;
      this.#input.move.set(0, 0);
    } else {
      if (!this.#hasMoveAnchor) {
        this.#moveAnchor.copy(movement.position);
        this.#hasMoveAnchor = true;
      }
      this.#input.move.set(
        MathUtils.clamp((movement.position.x - this.#moveAnchor.x) / MOVE_RADIUS, -1, 1),
        MathUtils.clamp((this.#moveAnchor.y - movement.position.y) / MOVE_RADIUS, -1, 1),
      );
    }

    const center = this.#hasMoveAnchor ? this.#moveAnchor : this.#resting;
    knobPosition.set(
      center.x + this.#input.move.x * MOVE_RADIUS,
      center.y - this.#input.move.y * MOVE_RADIUS,
    );
    place(this.#moveKnob, knobPosition);
    this.#jump.material = jump ? this.#activeMaterial : this.#idleMaterial;
    this.#input.jumpPressed = jump && !this.#wasJump;
    this.#wasJump = jump;
    this.#layout(size);
    return this.#input;
  }

  debug(): Record<string, unknown> {
    return { jump: this.#wasJump, move: this.#input.move.toArray() };
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const child of this.root.children) {
      if (child instanceof Mesh) child.geometry.dispose();
    }
    this.#idleMaterial.dispose();
    this.#activeMaterial.dispose();
  }

  #ensureLayout(size: ITouchViewport): void {
    if (size.width === this.#lastWidth && size.height === this.#lastHeight) return;
    this.#lastWidth = size.width;
    this.#lastHeight = size.height;
    this.#resting.copy(controlPoint(size, "move"));
    this.#jumpCenter.copy(controlPoint(size, "jump"));
  }

  #layout(size: ITouchViewport): void {
    const worldHeight = 2 * Math.tan(MathUtils.degToRad(this.#camera.fov / 2));
    const pixels = worldHeight / Math.max(1, size.height);
    this.root.position.set(-(size.width * pixels) / 2, worldHeight / 2, -1);
    this.root.scale.set(pixels, -pixels, 1);
    place(this.#moveBase, this.#hasMoveAnchor ? this.#moveAnchor : this.#resting);
    place(this.#jump, this.#jumpCenter);
  }

  #at(pointers: ReadonlyMap<number, ITouchPointer>, center: Vector2, radius: number): boolean {
    const radiusSquared = radius * radius;
    for (const pointer of pointers.values()) {
      if (pointer.position.distanceToSquared(center) <= radiusSquared) return true;
    }
    return false;
  }
}
