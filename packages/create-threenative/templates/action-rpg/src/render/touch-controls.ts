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
const BUTTON_RADIUS = 58;
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
  readonly abilityPressed: boolean;
  readonly attackPressed: boolean;
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

function controlPoint(size: ITouchViewport, name: "ability" | "attack" | "move"): Vector2 {
  if (name === "move") return new Vector2(MOVE_RADIUS + EDGE, size.height - MOVE_RADIUS - EDGE);
  const yOffset = name === "ability" ? BUTTON_RADIUS * 2 + EDGE : 0;
  return new Vector2(
    size.width - BUTTON_RADIUS - EDGE,
    size.height - BUTTON_RADIUS - EDGE - yOffset,
  );
}

export class TouchControls {
  readonly root = new Group();
  readonly object = this.root;
  #camera: PerspectiveCamera;
  #input: { abilityPressed: boolean; attackPressed: boolean; move: Vector2 } = {
    abilityPressed: false,
    attackPressed: false,
    move: new Vector2(),
  };
  #wasAbility = false;
  #wasAttack = false;
  #moveAnchor = new Vector2();
  #resting = new Vector2();
  #abilityCenter = new Vector2();
  #attackCenter = new Vector2();
  #hasMoveAnchor = false;
  #lastWidth = -1;
  #lastHeight = -1;
  #moveBase: Mesh;
  #moveKnob: Mesh;
  #ability: Mesh;
  #attack: Mesh;
  #idleMaterial: MeshBasicMaterial;
  #activeMaterial: MeshBasicMaterial;

  constructor(camera: PerspectiveCamera) {
    this.#camera = camera;
    this.#idleMaterial = overlayMaterial(palette.structure, 0.35);
    this.#activeMaterial = overlayMaterial(palette.accent, 0.6);
    this.#moveBase = ringMesh(MOVE_RADIUS, this.#idleMaterial);
    this.#moveKnob = new Mesh(new CircleGeometry(28, 24), this.#activeMaterial);
    this.#ability = ringMesh(BUTTON_RADIUS, this.#idleMaterial);
    this.#attack = ringMesh(BUTTON_RADIUS, this.#idleMaterial);
    this.root.add(this.#moveBase, this.#moveKnob, this.#ability, this.#attack);
    this.root.renderOrder = 10_001;
    camera.add(this.root);
  }

  update(pointers: ReadonlyMap<number, ITouchPointer>, size: ITouchViewport): ITouchInput {
    this.#ensureLayout(size);
    const attack = this.#at(pointers, this.#attackCenter, BUTTON_RADIUS);
    const ability = this.#at(pointers, this.#abilityCenter, BUTTON_RADIUS);
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
    this.#ability.material = ability ? this.#activeMaterial : this.#idleMaterial;
    this.#attack.material = attack ? this.#activeMaterial : this.#idleMaterial;
    this.#input.abilityPressed = ability && !this.#wasAbility;
    this.#input.attackPressed = attack && !this.#wasAttack;
    this.#wasAbility = ability;
    this.#wasAttack = attack;
    this.#layout(size);
    return this.#input;
  }

  debug(): Record<string, unknown> {
    return {
      ability: this.#wasAbility,
      attack: this.#wasAttack,
      move: this.#input.move.toArray(),
    };
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
    this.#abilityCenter.copy(controlPoint(size, "ability"));
    this.#attackCenter.copy(controlPoint(size, "attack"));
  }

  #layout(size: ITouchViewport): void {
    const worldHeight = 2 * Math.tan(MathUtils.degToRad(this.#camera.fov / 2));
    const pixels = worldHeight / Math.max(1, size.height);
    this.root.position.set(-(size.width * pixels) / 2, worldHeight / 2, -1);
    this.root.scale.set(pixels, -pixels, 1);
    place(this.#moveBase, this.#hasMoveAnchor ? this.#moveAnchor : this.#resting);
    place(this.#ability, this.#abilityCenter);
    place(this.#attack, this.#attackCenter);
  }

  #at(pointers: ReadonlyMap<number, ITouchPointer>, center: Vector2, radius: number): boolean {
    const radiusSquared = radius * radius;
    for (const pointer of pointers.values()) {
      if (pointer.position.distanceToSquared(center) <= radiusSquared) return true;
    }
    return false;
  }
}
