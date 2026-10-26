// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// On-screen controls for a touch screen, cloned from Fox Dash: a thumbstick that anchors where
// the thumb lands, and five buttons in a fan on the right — slash, roll, shield, target, use.
// Drawn as flat overlay meshes on the camera, so they exist on every target the scene does.
import {
  CircleGeometry,
  Group,
  MathUtils,
  Mesh,
  type MeshBasicMaterial,
  type PerspectiveCamera,
  RingGeometry,
  Vector2,
} from "three";
import { flat } from "./materials.js";
import { C, palette } from "./palette.js";

export const TOUCH_BUTTONS = ["attack", "action", "block", "target", "interact"] as const;
export type TouchButton = (typeof TOUCH_BUTTONS)[number];

export interface ITouchPointer {
  readonly position: Vector2;
}
export interface ITouchViewport {
  readonly height: number;
  readonly width: number;
}
export interface ITouchInput {
  readonly move: Vector2;
  readonly held: Readonly<Record<TouchButton, boolean>>;
  readonly pressed: Readonly<Record<TouchButton, boolean>>;
}

const STICK_RADIUS = 72;
const BUTTON_RADIUS = 46;
const EDGE = 36;

/** Where each button sits: a quarter-circle fan around the bottom-right corner. */
function buttonPoint(size: ITouchViewport, index: number): Vector2 {
  const cx = size.width - EDGE - BUTTON_RADIUS;
  const cy = size.height - EDGE - BUTTON_RADIUS;
  if (index === 0) return new Vector2(cx, cy);
  const angle = Math.PI + ((index - 1) / 3) * (Math.PI / 2);
  const reach = BUTTON_RADIUS * 3.1;
  return new Vector2(cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach);
}

const none = (): Record<TouchButton, boolean> => ({
  action: false,
  attack: false,
  block: false,
  interact: false,
  target: false,
});

export class TouchControls {
  readonly root = new Group();
  readonly object = this.root;
  readonly #camera: PerspectiveCamera;
  readonly #input = { held: none(), move: new Vector2(), pressed: none() };
  readonly #idle: MeshBasicMaterial;
  readonly #active: MeshBasicMaterial;
  readonly #stick: Mesh;
  readonly #knob: Mesh;
  readonly #buttons: Mesh[] = [];
  #anchor = new Vector2();
  #anchored = false;

  constructor(camera: PerspectiveCamera) {
    this.#camera = camera;
    this.#idle = flat(C.eye, 0.32, { depthTest: false });
    this.#active = flat(palette.accent, 0.6, { depthTest: false });
    this.#stick = new Mesh(new RingGeometry(STICK_RADIUS - 5, STICK_RADIUS, 32), this.#idle);
    this.#knob = new Mesh(new CircleGeometry(28, 24), this.#active);
    this.root.add(this.#stick, this.#knob);
    for (const _ of TOUCH_BUTTONS) {
      const button = new Mesh(new RingGeometry(BUTTON_RADIUS - 5, BUTTON_RADIUS, 28), this.#idle);
      this.#buttons.push(button);
      this.root.add(button);
    }
    this.root.renderOrder = 10_001;
    camera.add(this.root);
  }

  update(pointers: ReadonlyMap<number, ITouchPointer>, size: ITouchViewport): ITouchInput {
    const rest = new Vector2(STICK_RADIUS + EDGE, size.height - STICK_RADIUS - EDGE);
    let thumb: ITouchPointer | undefined;
    for (const pointer of pointers.values()) {
      if (pointer.position.x < size.width * 0.45 && pointer.position.y > size.height * 0.4) {
        thumb = pointer;
        break;
      }
    }
    const move = this.#input.move;
    if (thumb === undefined) {
      this.#anchored = false;
      move.set(0, 0);
    } else {
      if (!this.#anchored) this.#anchor.copy(thumb.position);
      this.#anchored = true;
      move.set(
        MathUtils.clamp((thumb.position.x - this.#anchor.x) / STICK_RADIUS, -1, 1),
        MathUtils.clamp((this.#anchor.y - thumb.position.y) / STICK_RADIUS, -1, 1),
      );
    }
    const centre = this.#anchored ? this.#anchor : rest;
    for (const [index, name] of TOUCH_BUTTONS.entries()) {
      const point = buttonPoint(size, index);
      let down = false;
      for (const pointer of pointers.values())
        if (pointer.position.distanceToSquared(point) <= BUTTON_RADIUS ** 2) down = true;
      this.#input.pressed[name] = down && !this.#input.held[name];
      this.#input.held[name] = down;
      const button = this.#buttons[index];
      if (button === undefined) continue;
      button.material = down ? this.#active : this.#idle;
      button.position.set(point.x, point.y, 0);
    }
    this.#stick.position.set(centre.x, centre.y, 0);
    this.#knob.position.set(centre.x + move.x * STICK_RADIUS, centre.y - move.y * STICK_RADIUS, 0);
    const worldHeight = 2 * Math.tan(MathUtils.degToRad(this.#camera.fov / 2));
    const pixels = worldHeight / Math.max(1, size.height);
    this.root.position.set((-size.width * pixels) / 2, worldHeight / 2, -1);
    this.root.scale.set(pixels, -pixels, 1);
    return this.#input;
  }

  debug(): Record<string, unknown> {
    return { held: { ...this.#input.held }, move: this.#input.move.toArray() };
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const child of this.root.children) if (child instanceof Mesh) child.geometry.dispose();
  }
}
