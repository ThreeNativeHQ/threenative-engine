const MAX_CAMERAS = 32;
const DEFAULT_MARGIN = 1.15;
/** Below this the target has no size and the framing distance would be zero. */
const MIN_RADIUS = 1e-3;
/** A point still frames from a readable metre, never from inside its own near plane. */
const MIN_FRAME_DISTANCE = 1;
const MIN_NEAR = 0.01;
/** Shorter than this and a position and target are the same point, not a view. */
const MIN_VIEW_DISTANCE = 1e-6;
/** Below this an up vector is parallel to the view and the frame is undefined. */
const MIN_UP_ANGLE = 1e-6;
/** A usable heading for a focus request that carries none: three-quarter view from the south-east. */
const DEFAULT_HEADING: [number, number, number] = [0.6, 0.5, 1];

/** Position/target/planes of one named observation camera. */
export interface ICameraPose {
  /** Stable across renames and reloads; selection and saves address the camera by it. */
  readonly id: string;
  readonly name: string;
  /** Local metres, Y up, centred on the terrain origin. */
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly near: number;
  readonly far: number;
}

/** A saved camera: perspective with a field of view, or orthographic with an extent and zoom. */
export type ISavedCamera = ICameraPose &
  (
    | { readonly projection: "perspective"; readonly fov: number }
    | { readonly projection: "orthographic"; readonly extent: number; readonly zoom: number }
  );

/** The camera list saved with the authoring document, plus which one is live. */
export interface ICameraSet {
  readonly cameras: readonly ISavedCamera[];
  /** `null` is the ordinary editor camera, not a saved bookmark. */
  readonly activeCamera: string | null;
}

export type ICameraOperation =
  | { readonly op: "create"; readonly camera: unknown }
  | { readonly op: "get"; readonly id: string }
  | { readonly op: "list" }
  | { readonly op: "update"; readonly id: string; readonly patch: unknown }
  | { readonly op: "delete"; readonly id: string }
  | { readonly op: "activate"; readonly id: string | null };

export interface ICameraResult {
  readonly op: string;
  readonly cameras: readonly ISavedCamera[];
  readonly activeCamera: string | null;
  /** The camera the operation addresses: the created, read or changed one. */
  readonly camera: ISavedCamera | null;
  /** `editor-camera` when this operation left the ordinary editor camera live. */
  readonly fallback: string | null;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a name`);
  return value;
}

function vector(value: unknown, name: string): [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  )
    throw new Error(`${name} must be finite [x, y, z] coordinates`);
  return [value[0] as number, value[1] as number, value[2] as number];
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive finite number`);
  return value;
}

function unit(value: [number, number, number]): number {
  return Math.hypot(...value);
}

function scale(value: [number, number, number], factor: number): [number, number, number] {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function add(
  first: [number, number, number],
  second: [number, number, number],
): [number, number, number] {
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

function cross(
  first: [number, number, number],
  second: [number, number, number],
): [number, number, number] {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

const COMMON_FIELDS = ["id", "name", "position", "target", "up", "near", "far"] as const;

/**
 * Normalise and validate one saved camera, exactly as a document commit would store it.
 * @summary Validate an editor observation camera bookmark
 * @requires npm i -D @threenative/terrain
 * @situation create or update a named terrain-editor camera in the shared authoring document
 * @constraint authoring metadata only; finite noncoincident poses, usable up, valid projection, ordered planes
 * @example const camera = validateCamera({ id: "survey", name: "Survey", position: [40, 60, 40], target: [0, 12, 0], up: [0, 1, 0], projection: "perspective", fov: 50, near: 0.5, far: 900 });
 * @override the caller owns the document revision and the live viewport aspect
 */
export function validateCamera(
  input: unknown,
  existing: readonly ISavedCamera[] = [],
): ISavedCamera {
  const value = object(input, "Camera");
  if (value.projection !== "perspective" && value.projection !== "orthographic")
    throw new Error("Camera.projection must be 'perspective' or 'orthographic'");
  const projection = value.projection;
  const fields =
    projection === "perspective"
      ? [...COMMON_FIELDS, "projection", "fov"]
      : [...COMMON_FIELDS, "projection", "extent", "zoom"];
  const extra = Object.keys(value).filter(
    (key) => !fields.includes(key as (typeof fields)[number]),
  );
  if (extra.length) throw new Error(`Camera has unknown fields: ${extra.join(", ")}`);
  const id = text(value.id, "Camera.id");
  if (existing.some((camera) => camera.id === id))
    throw new Error(`Camera id '${id}' already exists`);
  const position = vector(value.position, "Camera.position");
  const target = vector(value.target, "Camera.target");
  const up = vector(value.up, "Camera.up");
  if (
    unit([position[0] - target[0], position[1] - target[1], position[2] - target[2]]) <
    MIN_VIEW_DISTANCE
  )
    throw new Error("Camera.position and Camera.target must not coincide");
  const direction = scale(
    [position[0] - target[0], position[1] - target[1], position[2] - target[2]],
    1 / unit([position[0] - target[0], position[1] - target[1], position[2] - target[2]]),
  );
  if (unit(up) < MIN_UP_ANGLE) throw new Error("Camera.up must be a usable direction");
  if (unit(cross(up, direction)) < MIN_UP_ANGLE * unit(up))
    throw new Error("Camera.up is parallel to the view direction");
  const near = positive(value.near, "Camera.near");
  const far = positive(value.far, "Camera.far");
  if (far <= near) throw new Error("Camera.far must be greater than Camera.near");
  const pose = {
    id,
    name: text(value.name, "Camera.name"),
    position: position as [number, number, number],
    target: target as [number, number, number],
    up: up as [number, number, number],
    near,
    far,
  } as const;
  if (projection === "perspective") {
    const fov = positive(value.fov, "Camera.fov");
    if (fov >= 180) throw new Error("Camera.fov must be below 180 degrees");
    return { ...pose, projection, fov };
  }
  return {
    ...pose,
    projection,
    extent: positive(value.extent, "Camera.extent"),
    zoom: positive(value.zoom, "Camera.zoom"),
  };
}

/**
 * Validate a document's saved camera list, keeping ids unique across it.
 * @summary Validate the saved editor camera list of an authoring document
 * @requires npm i -D @threenative/terrain
 * @situation reject a disk document whose saved cameras are malformed or duplicated
 * @constraint authoring metadata only; the same validation the camera operations apply
 * @example const cameras = validateCameras(JSON.parse(saved).cameras ?? []);
 * @override the document owns how many cameras it keeps; the list bound is the editor's own
 */
export function validateCameras(input: unknown): ISavedCamera[] {
  if (!Array.isArray(input) || input.length > MAX_CAMERAS)
    throw new Error(`A document holds at most ${MAX_CAMERAS} saved cameras`);
  const cameras: ISavedCamera[] = [];
  for (const entry of input) cameras.push(validateCamera(entry, cameras));
  return cameras;
}

function require_(cameras: readonly ISavedCamera[], id: unknown): ISavedCamera {
  const name = text(id, "Camera id");
  const camera = cameras.find((entry) => entry.id === name);
  if (!camera) throw new Error(`Unknown camera '${name}'`);
  return camera;
}

/**
 * Run one create / get / list / update / delete / activate operation over saved cameras.
 * @summary Apply an editor camera operation to a saved camera set
 * @requires npm i -D @threenative/terrain
 * @situation drive the terrain editor camera list from an agent or the GUI through one shared dispatch
 * @constraint pure: the input set is never mutated, an unknown id throws, and deleting the live camera falls back
 * @example const next = runCameraOperation(set, { op: "activate", id: "survey" });
 * @override the caller persists the returned set against its own revision
 */
export function runCameraOperation(set: ICameraSet, operation: unknown): ICameraResult {
  const request = object(operation, "Camera operation");
  const op = text(request.op, "Camera operation op");
  if (op === "list")
    return {
      op,
      cameras: [...set.cameras],
      activeCamera: set.activeCamera,
      camera: null,
      fallback: null,
    };
  if (op === "get")
    return {
      op,
      cameras: [...set.cameras],
      activeCamera: set.activeCamera,
      camera: require_(set.cameras, request.id),
      fallback: null,
    };
  if (op === "create") {
    if (set.cameras.length >= MAX_CAMERAS)
      throw new Error(`A document holds at most ${MAX_CAMERAS} saved cameras`);
    const camera = validateCamera(request.camera, set.cameras);
    return {
      op,
      cameras: [...set.cameras, camera],
      activeCamera: set.activeCamera,
      camera,
      fallback: null,
    };
  }
  if (op === "update") {
    const camera = require_(set.cameras, request.id);
    const patch = object(request.patch, "Camera patch");
    const merged: Record<string, unknown> = { ...camera, ...patch, id: camera.id };
    // Switching projection carries the other projection's saved fields no further; a patch that
    // edits them without switching is a mistake, and validateCamera rejects it.
    let switched = merged;
    if (patch.projection !== undefined) {
      const stale = merged.projection === "perspective" ? ["extent", "zoom"] : ["fov"];
      switched = Object.fromEntries(Object.entries(merged).filter(([key]) => !stale.includes(key)));
    }
    const next = validateCamera(
      switched,
      set.cameras.filter((entry) => entry.id !== camera.id),
    );
    return {
      op,
      cameras: set.cameras.map((entry) => (entry.id === camera.id ? next : entry)),
      activeCamera: set.activeCamera,
      camera: next,
      fallback: null,
    };
  }
  if (op === "delete") {
    const camera = require_(set.cameras, request.id);
    const cameras = set.cameras.filter((entry) => entry.id !== camera.id);
    const deleted = set.activeCamera === camera.id;
    return {
      op,
      cameras,
      activeCamera: deleted ? null : set.activeCamera,
      camera,
      fallback: deleted ? "editor-camera" : null,
    };
  }
  if (op === "activate") {
    if (request.id === null)
      return {
        op,
        cameras: [...set.cameras],
        activeCamera: null,
        camera: null,
        fallback: "editor-camera",
      };
    require_(set.cameras, request.id);
    return {
      op,
      cameras: [...set.cameras],
      activeCamera: request.id as string,
      camera: require_(set.cameras, request.id),
      fallback: null,
    };
  }
  throw new Error(`Unknown camera operation '${op}'`);
}

/** World-space bounds of whatever a focus target resolved to. */
export interface IFocusBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export type IFocusTarget =
  | { readonly kind: "point"; readonly at: readonly [number, number, number] }
  | { readonly kind: "prop" | "landmark" | "region"; readonly id: string };

/**
 * Resolves a non-point focus target to real world bounds. The view owns this because only it holds
 * the live instance matrices, the registered landmarks and the evaluated terrain extent.
 */
export type IFocusResolver = (target: {
  readonly kind: "prop" | "landmark" | "region";
  readonly id: string;
}) => IFocusBounds | undefined;

export interface IFocusRequest {
  readonly target: IFocusTarget;
  /** Measured from the live viewport; a saved browser aspect would frame the wrong picture. */
  readonly aspect: number;
  /** Extra room around the target as a multiplier of its own size. */
  readonly margin?: number;
  /** Heading kept from the current view, so focusing never spins the camera. */
  readonly direction?: readonly [number, number, number];
}

export interface IFocusFraming {
  readonly centre: readonly [number, number, number];
  readonly radiusMetres: number;
  readonly distanceMetres: number;
  readonly margin: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  /** Orthographic only: the extent the viewport aspect needs to contain the target. */
  readonly extent: number | null;
}

export interface IFocusOutcome {
  /** `null` keeps the last valid camera; the diagnostic then says why. */
  readonly camera: ISavedCamera | null;
  readonly framing: IFocusFraming | null;
  readonly diagnostic: string | null;
}

/**
 * Frame a point, prop, landmark or region for the live viewport and projection.
 * @summary Frame a focus target with an editor observation camera
 * @requires npm i -D @threenative/terrain
 * @situation frame one selected prop, a registered landmark, a terrain region or a local point
 * @constraint framing only; an unknown target returns a named diagnostic and no camera
 * @example const outcome = focusCamera(camera, { target: { kind: "prop", id: "pine-3" }, aspect: 16 / 9 }, resolve);
 * @override the view supplies target bounds, the live aspect and the camera to keep
 */
export function focusCamera(
  camera: ISavedCamera,
  request: IFocusRequest,
  resolve: IFocusResolver,
): IFocusOutcome {
  object(request, "Focus request");
  const target = request;
  const aspect = positive(target.aspect, "Focus aspect");
  const margin =
    target.margin === undefined ? DEFAULT_MARGIN : positive(target.margin, "Focus margin");
  const bounds =
    target.target.kind === "point"
      ? {
          min: vector(target.target.at, "Focus point"),
          max: vector(target.target.at, "Focus point"),
        }
      : resolve(target.target);
  if (!bounds) {
    const named = target.target as { kind: string; id: string };
    return {
      camera: null,
      framing: null,
      diagnostic: `No focus target for ${named.kind} '${named.id}'`,
    };
  }
  const minimum = vector(bounds.min, "Focus bounds min");
  const maximum = vector(bounds.max, "Focus bounds max");
  const centre: [number, number, number] = [
    (minimum[0] + maximum[0]) / 2,
    (minimum[1] + maximum[1]) / 2,
    (minimum[2] + maximum[2]) / 2,
  ];
  const radiusMetres = Math.max(
    unit([maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]]) / 2,
    MIN_RADIUS,
  );
  const framed = radiusMetres * margin;
  const heading =
    target.direction === undefined ? DEFAULT_HEADING : vector(target.direction, "Focus direction");
  const direction = normalise(unit(heading) < MIN_VIEW_DISTANCE ? DEFAULT_HEADING : heading);
  let extent: number | null = null;
  let distance: number;
  if (camera.projection === "perspective") {
    const halfVertical = (camera.fov * Math.PI) / 360;
    // The narrower of the two half-angles decides the distance; a wide viewport fits more.
    const limiting = Math.min(halfVertical, Math.atan(Math.tan(halfVertical) * aspect));
    distance = framed / Math.sin(limiting);
  } else {
    // Orthographic scale is the frustum height, so the wider viewport needs no extra world size.
    const halfHeight = framed / Math.min(1, aspect);
    extent = halfHeight / camera.zoom;
    distance = framed * 2 + halfHeight;
  }
  const distanceMetres = Math.max(MIN_FRAME_DISTANCE, distance);
  const near = Math.max(MIN_NEAR, distanceMetres - framed);
  const far = Math.max(near + MIN_NEAR, distanceMetres + framed);
  const framing: IFocusFraming = {
    centre,
    radiusMetres,
    distanceMetres,
    margin,
    aspect,
    near,
    far,
    extent,
  };
  const next = {
    ...camera,
    position: add(centre, scale(direction, distanceMetres)),
    target: centre,
    near,
    far,
    ...(extent === null ? {} : { extent }),
  };
  return { camera: validateCamera(next), framing, diagnostic: null };
}

function normalise(value: [number, number, number]): [number, number, number] {
  return scale(value, 1 / unit(value));
}
