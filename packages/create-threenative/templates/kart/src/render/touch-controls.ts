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
import { C, palette } from "./palette.js";
import {
  BUTTON_RADIUS,
  type ITouchInput,
  type ITouchPointer,
  type ITouchViewport,
  MOVE_RADIUS,
  type TouchButton,
  touchControlPoint,
} from "./touch-layout.js";

export type { ITouchInput };

/** Flat overlay material: drawn over the scene, never occluded by it. */
function overlayMaterial(color: ColorRepresentation, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    opacity,
    transparent: true,
  });
}

/** The 5px-thick outline every control shares. */
function ringMesh(radius: number, material: MeshBasicMaterial): Mesh {
  return new Mesh(new RingGeometry(radius - 5, radius, 32), material);
}

const BUTTONS: readonly TouchButton[] = ["accel", "drift", "item"];

/**
 * A thumbstick anchored where the thumb lands, plus accelerate, drift and item buttons, drawn on a
 * plane in front of the camera. Pixel space in, `ITouchInput` out; `scenes/Race.ts` adds it to the keys.
 */
export class TouchControls {
  readonly root = new Group();
  readonly object = this.root;
  #camera: PerspectiveCamera;
  #input = { accelHeld: false, driftHeld: false, itemPressed: false, move: new Vector2() };
  readonly #held: Record<TouchButton, boolean> = { accel: false, drift: false, item: false };
  readonly #centres: Record<TouchButton, Vector2> = {
    accel: new Vector2(),
    drift: new Vector2(),
    item: new Vector2(),
  };
  readonly #rings: Record<TouchButton, Mesh>;
  #moveAnchor = new Vector2();
  #hasMoveAnchor = false;
  #resting = new Vector2();
  #lastWidth = -1;
  #lastHeight = -1;
  #moveBase: Mesh;
  #moveKnob: Mesh;
  #idleMaterial: MeshBasicMaterial;
  #activeMaterial: MeshBasicMaterial;

  constructor(camera: PerspectiveCamera) {
    this.#camera = camera;
    // Ink, not white: the course is bright grass and sky almost everywhere a thumb lands.
    this.#idleMaterial = overlayMaterial(C.ink, 0.3);
    this.#activeMaterial = overlayMaterial(palette.accent, 0.58);
    this.#moveBase = ringMesh(MOVE_RADIUS, this.#idleMaterial);
    this.#moveKnob = new Mesh(new CircleGeometry(28, 24), this.#activeMaterial);
    this.#rings = {
      accel: ringMesh(BUTTON_RADIUS, this.#idleMaterial),
      drift: ringMesh(BUTTON_RADIUS, this.#idleMaterial),
      item: ringMesh(BUTTON_RADIUS, this.#idleMaterial),
    };
    this.root.add(this.#moveBase, this.#moveKnob, ...Object.values(this.#rings));
    this.root.renderOrder = 10_001;
    camera.add(this.root);
  }

  update(pointers: ReadonlyMap<number, ITouchPointer>, size: ITouchViewport): ITouchInput {
    this.#ensureLayout(size);
    let left: ITouchPointer | undefined;
    for (const pointer of pointers.values()) {
      if (pointer.position.x < size.width * 0.5 && pointer.position.y > size.height * 0.4) {
        left = pointer;
        break;
      }
    }
    const move = this.#input.move;
    if (left === undefined) {
      this.#hasMoveAnchor = false;
      move.set(0, 0);
    } else {
      if (!this.#hasMoveAnchor) {
        this.#moveAnchor.copy(left.position);
        this.#hasMoveAnchor = true;
      }
      move.set(
        MathUtils.clamp((left.position.x - this.#moveAnchor.x) / MOVE_RADIUS, -1, 1),
        // Screen y grows downward and the game's move.y is +up.
        MathUtils.clamp((this.#moveAnchor.y - left.position.y) / MOVE_RADIUS, -1, 1),
      );
    }
    const centre = this.#hasMoveAnchor ? this.#moveAnchor : this.#resting;
    this.#moveKnob.position.set(
      centre.x + move.x * MOVE_RADIUS,
      centre.y - move.y * MOVE_RADIUS,
      0,
    );
    for (const name of BUTTONS) {
      const down = this.#at(pointers, this.#centres[name]);
      const pressed = down && !this.#held[name];
      this.#held[name] = down;
      this.#rings[name].material = down ? this.#activeMaterial : this.#idleMaterial;
      if (name === "accel") this.#input.accelHeld = down;
      else if (name === "drift") this.#input.driftHeld = down;
      else this.#input.itemPressed = pressed;
    }
    this.#layout(size);
    return this.#input;
  }

  debug(): Record<string, unknown> {
    return { ...this.#held, move: this.#input.move.toArray() };
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
    this.#resting.copy(touchControlPoint(size, "move"));
    for (const name of BUTTONS) this.#centres[name].copy(touchControlPoint(size, name));
  }

  #layout(size: ITouchViewport): void {
    const worldHeight = 2 * Math.tan(MathUtils.degToRad(this.#camera.fov / 2));
    const pixels = worldHeight / Math.max(1, size.height);
    this.root.position.set((-size.width * pixels) / 2, worldHeight / 2, -1);
    this.root.scale.set(pixels, -pixels, 1);
    const move = this.#hasMoveAnchor ? this.#moveAnchor : this.#resting;
    this.#moveBase.position.set(move.x, move.y, 0);
    for (const name of BUTTONS)
      this.#rings[name].position.set(this.#centres[name].x, this.#centres[name].y, 0);
  }

  #at(pointers: ReadonlyMap<number, ITouchPointer>, centre: Vector2): boolean {
    const radiusSquared = BUTTON_RADIUS * BUTTON_RADIUS;
    for (const pointer of pointers.values()) {
      if (pointer.position.distanceToSquared(centre) <= radiusSquared) return true;
    }
    return false;
  }
}
