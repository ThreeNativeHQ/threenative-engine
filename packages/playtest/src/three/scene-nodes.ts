import { Box3, Frustum, Matrix4, Vector3, type Camera, type Object3D, type Scene } from "three";
import { typeNameOf } from "./scene-observation.js";

import type {
  IPlaytestSceneNodeMaterial,
  IPlaytestSceneNodeObservation,
  IPlaytestSceneNodeSelector,
  IPlaytestSceneNodesObservation,
} from "../protocol.js";

/**
 * The scene graph, node by node, so an agent can ask about one object instead of photographing
 * all of them.
 *
 * `observeSceneResources` reports the room as counts — how many lights, how many materials of
 * each constructor name. That answers *is anything lit* and cannot answer *is the crate on
 * screen*, *did the seal plate's texture load*, *is this mesh inside the wall*, *is the character
 * actually animating*. Those are the questions a screenshot gets taken for, and a screenshot is
 * the one instrument that cannot say why.
 *
 * Every value here is read off the object the renderer will draw. Nothing is inferred, nothing is
 * defaulted, and a fact the scene does not carry is absent rather than zero.
 */

/**
 * Ceilings on the walk. A selector past either reports `truncated: true` with `matched` still
 * counting every match, because a floor read as a total is the confident empty number this
 * package exists to refuse.
 */
export const SCENE_NODE_WALK_CAP = 50_000;
export const SCENE_NODE_DEFAULT_LIMIT = 50;
export const SCENE_NODE_MAX_LIMIT = 500;
export const SCENE_NODE_MAX_SELECTORS = 16;

/**
 * Materials that read scene lighting, so an unlit scene renders everything wearing one black.
 * Kept identical to `LIT_MATERIAL_PATTERN` in `runner/sceneRoom.ts`; the two answer the same
 * question and an operator must never be told two different stories about one material.
 */
const LIT_MATERIAL_PATTERN = /standard|physical|lambert|phong|toon/iu;

/**
 * Texture slots worth reporting. Three.js has no runtime list of a material's map properties, so
 * this is enumerated rather than discovered — a slot missing from here is unreported, never
 * reported as absent.
 */
const MATERIAL_MAP_SLOTS = [
  "alphaMap",
  "anisotropyMap",
  "aoMap",
  "bumpMap",
  "clearcoatMap",
  "displacementMap",
  "emissiveMap",
  "envMap",
  "iridescenceMap",
  "lightMap",
  "map",
  "metalnessMap",
  "normalMap",
  "roughnessMap",
  "sheenColorMap",
  "specularMap",
  "transmissionMap",
] as const;

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

function hexOf(value: unknown): string | undefined {
  return isColorLike(value) ? `#${value.getHexString()}` : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


export function sceneNodePath(object: Object3D): string {
  const parts: string[] = [];
  let current: Object3D | null = object;
  while (current !== null) {
    // The uuid disambiguates unnamed siblings. The root has none, and stamping one there makes
    // every path in the report start with a value that changes on every run — unmatchable by a
    // scenario and noise in any diff between two runs.
    const anonymous = current.parent === null ? typeNameOf(current) : `${typeNameOf(current)}[${current.uuid.slice(0, 8)}]`;
    parts.unshift(current.name || anonymous);
    current = current.parent;
  }
  return parts.join("/");
}

function visibleInTree(object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current !== null) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Whether a bound texture carries pixels.
 *
 * A slot bound to a texture whose image never arrived renders black, and every count above it
 * stays healthy: the material is mounted, the slot is set, the scene has lights. This is the
 * difference between the two.
 */
function textureLoaded(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const image = (value as { image?: unknown }).image;
  if (image === null || image === undefined) {
    // A render target's texture and a compressed texture carry mipmaps instead of an image.
    const mipmaps = (value as { mipmaps?: unknown }).mipmaps;
    return Array.isArray(mipmaps) && mipmaps.length > 0;
  }
  if (typeof image !== "object") return true;
  const width = finite((image as { width?: unknown }).width);
  const height = finite((image as { height?: unknown }).height);
  if (width === undefined || height === undefined) return true;
  return width > 0 && height > 0;
}

function materialObservation(value: object): IPlaytestSceneNodeMaterial {
  const material = value as Record<string, unknown>;
  const type = typeNameOf(value);
  const maps: string[] = [];
  const mapsUnloaded: string[] = [];
  for (const slot of MATERIAL_MAP_SLOTS) {
    const texture = material[slot];
    if (typeof texture !== "object" || texture === null) continue;
    maps.push(slot);
    if (!textureLoaded(texture)) mapsUnloaded.push(slot);
  }
  const color = hexOf(material.color);
  const emissive = hexOf(material.emissive);
  const metalness = finite(material.metalness);
  const opacity = finite(material.opacity);
  const roughness = finite(material.roughness);
  const name = material.name;
  return {
    ...(color === undefined ? {} : { color }),
    ...(emissive === undefined ? {} : { emissive }),
    lit: LIT_MATERIAL_PATTERN.test(type),
    maps,
    mapsUnloaded,
    ...(metalness === undefined ? {} : { metalness }),
    name: typeof name === "string" ? name : "",
    ...(opacity === undefined ? {} : { opacity }),
    ...(roughness === undefined ? {} : { roughness }),
    transparent: material.transparent === true,
    type,
    visible: material.visible !== false,
  };
}

function materialsOf(object: Object3D): IPlaytestSceneNodeMaterial[] | undefined {
  const material: unknown = (object as { material?: unknown }).material;
  if (material === undefined || material === null) return undefined;
  const entries = Array.isArray(material) ? material : [material];
  const observed = entries.filter((entry): entry is object => typeof entry === "object" && entry !== null);
  return observed.length === 0 ? undefined : observed.map(materialObservation);
}

function geometryOf(object: Object3D): IPlaytestSceneNodeObservation["geometry"] {
  const geometry: unknown = (object as { geometry?: unknown }).geometry;
  if (typeof geometry !== "object" || geometry === null) return undefined;
  const attributes = (geometry as { attributes?: unknown }).attributes;
  const names =
    typeof attributes === "object" && attributes !== null ? Object.keys(attributes as object).sort() : [];
  const position = (geometry as { attributes?: { position?: { count?: unknown } } }).attributes?.position;
  const vertices = finite(position?.count) ?? 0;
  const index = (geometry as { index?: { count?: unknown } | null }).index;
  const indexCount = finite(index?.count);
  const triangles = Math.floor((indexCount ?? vertices) / 3);
  return { attributes: names, triangles, vertices };
}

function animationOf(object: Object3D): IPlaytestSceneNodeObservation["animation"] {
  const animations = (object as { animations?: unknown }).animations;
  if (!Array.isArray(animations) || animations.length === 0) return undefined;
  const clips: string[] = [];
  for (const clip of animations) {
    if (typeof clip !== "object" || clip === null) continue;
    const name = (clip as { name?: unknown }).name;
    clips.push(typeof name === "string" ? name : "");
  }
  // Three.js keeps running actions on the mixer, not on the object, and the mixer is the game's.
  // A game that publishes its own animation state does so through `gameplay.animation`; this
  // reports only what the object itself carries, so `playing` is empty rather than guessed.
  return { clips, playing: [] };
}

function selectorMatches(
  object: Object3D,
  path: string,
  selector: IPlaytestSceneNodeSelector,
): boolean {
  if (selector.name !== undefined && object.name !== selector.name) return false;
  if (selector.type !== undefined && typeNameOf(object) !== selector.type) return false;
  if (
    selector.nameContains !== undefined &&
    !object.name.toLowerCase().includes(selector.nameContains.toLowerCase())
  )
    return false;
  if (
    selector.pathContains !== undefined &&
    !path.toLowerCase().includes(selector.pathContains.toLowerCase())
  )
    return false;
  return true;
}

function nodeObservation(
  object: Object3D,
  path: string,
  frustum: Frustum | undefined,
): IPlaytestSceneNodeObservation {
  const position = object.getWorldPosition(new Vector3());
  const scale = object.getWorldScale(new Vector3());
  const box = new Box3().setFromObject(object);
  const bounds = box.isEmpty()
    ? undefined
    : {
        max: [box.max.x, box.max.y, box.max.z] as [number, number, number],
        min: [box.min.x, box.min.y, box.min.z] as [number, number, number],
      };
  const instances = finite((object as { count?: unknown }).count);
  const skeleton = (object as { skeleton?: { bones?: unknown } }).skeleton;
  const bones = Array.isArray(skeleton?.bones) ? skeleton.bones.length : undefined;
  const materials = materialsOf(object);
  const geometry = geometryOf(object);
  const animation = animationOf(object);
  return {
    ...(animation === undefined ? {} : { animation }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(geometry === undefined ? {} : { geometry }),
    // Frustum membership is only reported when a camera projection was available to test it
    // against; an untested node is absent, never `false`.
    ...(frustum === undefined || bounds === undefined ? {} : { inFrustum: frustum.intersectsBox(box) }),
    ...(instances === undefined ? {} : { instances }),
    ...(materials === undefined ? {} : { materials }),
    name: object.name,
    path,
    position: [position.x, position.y, position.z],
    scale: [scale.x, scale.y, scale.z],
    ...(bones === undefined ? {} : { skinned: { bones } }),
    type: typeNameOf(object),
    visible: object.visible,
    visibleInTree: visibleInTree(object),
  };
}

function cameraFrustum(camera: Camera): Frustum | undefined {
  const projection = (camera as { projectionMatrix?: unknown }).projectionMatrix;
  const inverse = (camera as { matrixWorldInverse?: unknown }).matrixWorldInverse;
  if (!(projection instanceof Matrix4) || !(inverse instanceof Matrix4)) return undefined;
  camera.updateMatrixWorld();
  return new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(projection, inverse));
}

function resolveLimit(selector: IPlaytestSceneNodeSelector): number {
  const requested = selector.limit ?? SCENE_NODE_DEFAULT_LIMIT;
  return Math.min(Math.max(requested, 0), SCENE_NODE_MAX_LIMIT);
}

/**
 * Report the scene graph node by node, for the nodes each selector picks out.
 * @situation ask where one object is, whether it is on screen, and whether its textures loaded
 * @constraint reports what is mounted; nothing here decides how the game looks
 * @constraint a selector that matches nothing reports `matched: 0`, never an empty success
 * @constraint `matched` counts every match; `nodes` is cut to `limit` and says `truncated`
 * @example const [crates] = observeSceneNodes(scene, camera, [{ nameContains: "crate" }]);
 */
export function observeSceneNodes(
  scene: Scene,
  camera: Camera,
  selectors: readonly IPlaytestSceneNodeSelector[],
): IPlaytestSceneNodesObservation[] {
  if (selectors.length > SCENE_NODE_MAX_SELECTORS)
    throw new Error(
      `A playtest sample requested ${selectors.length} scene-node selectors; the protocol allows ${SCENE_NODE_MAX_SELECTORS}.`,
    );
  const frustum = cameraFrustum(camera);
  const results = selectors.map((selector) => ({
    limit: resolveLimit(selector),
    matched: 0,
    nodes: [] as IPlaytestSceneNodeObservation[],
    selector,
    truncated: false,
  }));
  let walked = 0;
  let walkCapped = false;
  scene.traverse((object) => {
    walked += 1;
    // traverse() has no early exit, so the cap refuses further work rather than stopping the
    // walk. Every result then says its list is a sample.
    if (walked > SCENE_NODE_WALK_CAP) {
      walkCapped = true;
      return;
    }
    const path = sceneNodePath(object);
    for (const result of results) {
      if (!selectorMatches(object, path, result.selector)) continue;
      result.matched += 1;
      if (result.nodes.length < result.limit) result.nodes.push(nodeObservation(object, path, frustum));
      else result.truncated = true;
    }
  });
  return results.map(({ matched, nodes, selector, truncated }) => ({
    matched,
    nodes,
    selector,
    truncated: truncated || walkCapped,
  }));
}
