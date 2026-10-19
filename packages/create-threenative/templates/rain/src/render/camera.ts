// Generated for you. Framing is a game-owned decision.
//
// The rig, not the scene: everything that decides where the camera stands and what it looks at
// lives here, so the scene is left wiring lifecycle and publishing state.
import { Euler, MathUtils, type PerspectiveCamera, Vector3 } from "three";

/** The view the game opens on, and the one `resetCamera` returns to. */
export interface IHomeView {
  readonly pitch: number;
  readonly position: Vector3;
  readonly yaw: number;
}

export const HOME: IHomeView = {
  pitch: 0.21,
  position: new Vector3(1.8, 2.85, 18),
  yaw: -0.085,
};

const PITCH_RANGE: readonly [number, number] = [-0.7, 1.25];
const WALK_SPEED = 6;
const RUN_SPEED = 23;
const LOOK_SENSITIVITY = 0.0023;

/** How far the free camera may roam: the coast runs along -z, the sea is at +x. */
const BOUNDS = {
  maxX: 220,
  maxY: 110,
  maxZ: 90,
  minX: -100,
  minY: 1.65,
  minZ: -350,
} as const;

/**
 * What the rig needs from the engine's input. Structural on purpose: `src/render/` is ordinary
 * Three.js and must not import a package.
 */
export interface ICameraInput {
  pressed(name: string): boolean;
  raw: {
    readonly pointer: {
      readonly buttons: number;
      readonly down: boolean;
    };
  };
  /**
   * `move` is the key vector; `look` is the drag's motion since the last tick, in pixels — the
   * engine samples it at the tick, so the raw pointer's own counter is already spent.
   */
  vector(name: string): { x: number; y: number };
}

export interface ICameraRig {
  /** Camera-space forward, flat on the ground: what WASD walks along. */
  readonly forward: Vector3;
  readonly heading: number;
  readonly position: Vector3;
  readonly right: Vector3;
  readonly up: Vector3;
  /** True while a key or a drag is asking for the camera, which cancels the cinematic orbit. */
  readonly manual: boolean;
  reset(): void;
  update(dt: number, elapsed: number, input: ICameraInput, cinematic: boolean): void;
}

export function setupCamera(camera: PerspectiveCamera): void {
  camera.fov = 55;
  // Match the source projection/depth coefficients: 1.00012*d - 0.300018.
  camera.near = 0.15;
  camera.far = 2500;
  camera.position.copy(HOME.position);
  camera.updateProjectionMatrix();
}

const LEFT_MOUSE = 1;

export function createCameraRig(camera: PerspectiveCamera): ICameraRig {
  const position = HOME.position.clone();
  const rotation = new Euler(0, 0, 0, "YXZ");
  const forward = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  const worldUp = new Vector3(0, 1, 0);
  let yaw = HOME.yaw;
  let pitch = HOME.pitch;
  let manual = false;

  const orient = (): void => {
    // The rig stores yaw as the compass heading it publishes, so a reset and a drag agree on
    // sign instead of each carrying their own.
    rotation.set(pitch, -yaw, 0, "YXZ");
    camera.quaternion.setFromEuler(rotation);
    forward.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    right.crossVectors(forward, worldUp).normalize();
    up.crossVectors(right, forward);
  };

  const reset = (): void => {
    position.copy(HOME.position);
    yaw = HOME.yaw;
    pitch = HOME.pitch;
    orient();
  };

  reset();

  return {
    forward,
    get heading() {
      return Math.round(((yaw * 180) / Math.PI + 360) % 360);
    },
    get manual() {
      return manual;
    },
    position,
    reset,
    right,
    up,
    update(dt, elapsed, input, cinematic) {
      const move = input.vector("move");
      const altitude = Number(input.pressed("ascend")) - Number(input.pressed("descend"));
      const boost = input.pressed("boost");
      const dragging = input.raw.pointer.down && (input.raw.pointer.buttons & LEFT_MOUSE) !== 0;
      manual = move.x !== 0 || move.y !== 0 || altitude !== 0 || boost || dragging;
      if (cinematic && !manual) {
        // A slow orbit of the opening view: the coast stays in frame while the weather plays out.
        position.set(
          HOME.position.x + Math.sin(elapsed * 0.08) * 1.6,
          HOME.position.y + Math.sin(elapsed * 0.06) * 0.16,
          HOME.position.z + Math.cos(elapsed * 0.07) * 1.8,
        );
        yaw = HOME.yaw + Math.sin(elapsed * 0.045) * 0.12;
        pitch = HOME.pitch + Math.sin(elapsed * 0.06) * 0.027;
        orient();
        camera.position.copy(position);
        return;
      }
      if (dragging) {
        const look = input.vector("look");
        yaw += look.x * LOOK_SENSITIVITY;
        pitch = MathUtils.clamp(pitch - look.y * LOOK_SENSITIVITY, PITCH_RANGE[0], PITCH_RANGE[1]);
      }
      // Yaw only, so walking never climbs the hill the camera is standing on.
      const flatForward = new Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
      const flatRight = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
      const speed = dt * (boost ? RUN_SPEED : WALK_SPEED);
      position.addScaledVector(flatForward, speed * move.y);
      position.addScaledVector(flatRight, speed * move.x);
      position.y += speed * altitude;
      position.set(
        MathUtils.clamp(position.x, BOUNDS.minX, BOUNDS.maxX),
        MathUtils.clamp(position.y, BOUNDS.minY, BOUNDS.maxY),
        MathUtils.clamp(position.z, BOUNDS.minZ, BOUNDS.maxZ),
      );
      orient();
      camera.position.copy(position);
    },
  };
}
