import { Box3, Vector3, type Camera, type Object3D, type Scene } from "three";

import type {
  IPlaytestCameraObservation,
  IPlaytestFogObservation,
  IPlaytestLightObservation,
  IPlaytestSceneObservation,
} from "../protocol.js";

/**
 * The room the game is played in, read off the scene graph.
 *
 * `doctor --url` listed lights, materials and camera framing under "not observed", so an agent
 * looking at a black or washed-out frame had nothing to read and went to screenshots — the one
 * instrument that cannot say *why*. Everything here is a count or a name taken from the objects
 * the renderer will use. It decides nothing about how the game looks.
 */

/**
 * Ceilings on the walk. A scene past either is described as far as the cap and says so; a count
 * silently capped would be read as a total, and a total nobody measured is exactly the confident
 * empty number this harness exists to prevent.
 */
export const SCENE_WALK_OBJECT_CAP = 20_000;
export const SCENE_LIGHT_CAP = 64;

interface IColorLike {
  getHexString(): string;
}

function isColorLike(value: unknown): value is IColorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { isColor?: unknown }).isColor === true &&
    typeof (value as { getHexString?: unknown }).getHexString === "function"
  );
}

function hexOf(value: unknown): string {
  return isColorLike(value) ? `#${value.getHexString()}` : "unobserved";
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function typeNameOf(value: object): string {
  const declared = (value as { type?: unknown }).type;
  if (typeof declared === "string" && declared.length > 0) return declared;
  const named = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof named === "string" && named.length > 0 ? named : "unobserved";
}

function backgroundOf(scene: Scene): string {
  const background: unknown = scene.background;
  if (background === null || background === undefined) return "none";
  if (isColorLike(background)) return `color:${hexOf(background)}`;
  return typeof background === "object" ? typeNameOf(background) : "unobserved";
}

function fogOf(scene: Scene): IPlaytestFogObservation | undefined {
  const fog: unknown = scene.fog;
  if (typeof fog !== "object" || fog === null) return undefined;
  const color = hexOf((fog as { color?: unknown }).color);
  const density = (fog as { density?: unknown }).density;
  if (typeof density === "number" && Number.isFinite(density))
    return { color, density, type: "exponential" };
  const near = (fog as { near?: unknown }).near;
  const far = (fog as { far?: unknown }).far;
  if (typeof near !== "number" || typeof far !== "number") return undefined;
  if (!Number.isFinite(near) || !Number.isFinite(far)) return undefined;
  return { color, far, near, type: "linear" };
}

function cameraObservation(camera: Camera): IPlaytestCameraObservation {
  const position = camera.getWorldPosition(new Vector3());
  const forward = camera.getWorldDirection(new Vector3());
  const perspective = camera as { far?: unknown; fov?: unknown; isPerspectiveCamera?: unknown; near?: unknown };
  const near = finite(perspective.near);
  const far = finite(perspective.far);
  const fov = finite(perspective.fov);
  return {
    ...(far === undefined ? {} : { far }),
    forward: [forward.x, forward.y, forward.z],
    ...(fov === undefined ? {} : { fov }),
    ...(near === undefined ? {} : { near }),
    position: [position.x, position.y, position.z],
    type: typeNameOf(camera),
  };
}

function lightObservation(object: Object3D): IPlaytestLightObservation {
  const light = object as { color?: unknown; intensity?: unknown };
  const intensity = finite(light.intensity);
  return {
    color: hexOf(light.color),
    ...(intensity === undefined ? {} : { intensity }),
    type: typeNameOf(object),
    visible: object.visible,
  };
}

function countMaterials(object: Object3D, counted: Set<string>, counts: Record<string, number>): void {
  const material: unknown = (object as { material?: unknown }).material;
  const entries = Array.isArray(material) ? material : [material];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const uuid = (entry as { uuid?: unknown }).uuid;
    const key = typeof uuid === "string" ? uuid : undefined;
    if (key !== undefined) {
      if (counted.has(key)) continue;
      counted.add(key);
    }
    const name = typeNameOf(entry);
    counts[name] = (counts[name] ?? 0) + 1;
  }
}

/**
 * Walk the scene once and report what is mounted in it.
 * @situation ask what lights, materials and framing a running game actually has
 * @constraint reports counts and names only; nothing here decides how the game looks
 * @constraint a walk that hits {@link SCENE_WALK_OBJECT_CAP} reports `truncated: true`
 * @example const room = observeSceneResources(ctx.scene, ctx.camera);
 */
export function observeSceneResources(scene: Scene, camera: Camera): IPlaytestSceneObservation {
  const lights: IPlaytestLightObservation[] = [];
  const materials: Record<string, number> = {};
  const countedMaterials = new Set<string>();
  let objects = 0;
  let truncated = false;
  // traverse() has no early exit, so the cap is enforced by refusing further work rather than by
  // stopping the walk. The count still tells the reader the scene is past the cap.
  scene.traverse((object) => {
    objects += 1;
    if (objects > SCENE_WALK_OBJECT_CAP) {
      truncated = true;
      return;
    }
    if ((object as { isLight?: unknown }).isLight === true) {
      if (lights.length < SCENE_LIGHT_CAP) lights.push(lightObservation(object));
      else truncated = true;
      return;
    }
    countMaterials(object, countedMaterials, materials);
  });
  const bounds = new Box3().setFromObject(scene);
  const fog = fogOf(scene);
  return {
    background: backgroundOf(scene),
    camera: cameraObservation(camera),
    ...(fog === undefined ? {} : { fog }),
    lights,
    materials,
    objects,
    truncated,
    ...(bounds.isEmpty()
      ? {}
      : {
          worldExtent: {
            max: [bounds.max.x, bounds.max.y, bounds.max.z] as [number, number, number],
            min: [bounds.min.x, bounds.min.y, bounds.min.z] as [number, number, number],
          },
        }),
  };
}
