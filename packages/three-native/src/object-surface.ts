/**
 * The JavaScript half of three's object surface that both engine back ends share (PRD-540; moved
 * from the V8 player's core-three.mjs): `geometry.attributes` and `groups`, `shape.holes`, and the
 * abstract `Material` base. The engine owns the data; these are views over its bindings.
 */

type Constructor = abstract new (...args: never[]) => object;
type Prototype = Record<string, unknown> & object;

/** The engine classes the views attach to; a missing one is skipped. */
export interface ISurfaceClasses {
  readonly bufferGeometry: Constructor;
  readonly geometries: readonly Constructor[];
  readonly shape?: Constructor;
  readonly materials: readonly Constructor[];
}

// three's `geometry.attributes` map over the native named attributes: one live view per geometry,
// reading through getAttribute and writing through setAttribute/deleteAttribute.
// The engine lists names in its own (sorted) order; three's standard names come first, as three
// adds them, then the rest.
const STANDARD_ATTRIBUTES = [
  "position",
  "normal",
  "uv",
  "uv1",
  "uv2",
  "uv3",
  "color",
  "tangent",
  "skinIndex",
  "skinWeight",
];

interface IGeometry {
  /** Every attribute name, one per line: one engine call. */
  readonly __attributeNames: string;
  setAttribute(name: string, attribute: unknown): unknown;
  deleteAttribute(name: string): unknown;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): unknown;
}

function defineGeometrySurface(
  BufferGeometry: Constructor,
  geometries: readonly Constructor[],
): void {
  const attributeViews = new WeakMap<object, object>();
  for (const geometry of [BufferGeometry, ...geometries]) {
    const prototype = geometry.prototype as Prototype & IGeometry;
    // three's morphAttributes is a plain object a game replaces whole (core's merge clears it with
    // {}): the engine's holder takes its position and normal arrays, an absent one as none, and
    // any other key is refused by name.
    const morph = Object.getOwnPropertyDescriptor(prototype, "morphAttributes");
    if (morph?.get !== undefined && morph.set === undefined)
      Object.defineProperty(prototype, "morphAttributes", {
        configurable: true,
        get: morph.get,
        set(this: object, value: Record<string, unknown>) {
          for (const key of Object.keys(value))
            if (key !== "position" && key !== "normal")
              throw new TypeError(`TN_NATIVE_UNSUPPORTED morphAttributes.${key} is not ported`);
          const holder = morph.get?.call(this) as Record<string, unknown>;
          holder.position = value.position ?? [];
          holder.normal = value.normal ?? [];
        },
      });
    // The registry answers `groups` as canonical JSON text (the fixtures' protocol); three's is an
    // array of { start, count, materialIndex } in that key order.
    // ponytail: a fresh array per read, so edit groups with addGroup/clearGroups, as three advises.
    const groups = Object.getOwnPropertyDescriptor(prototype, "groups");
    if (groups?.get !== undefined)
      Object.defineProperty(prototype, "groups", {
        configurable: true,
        get(this: object) {
          return (
            JSON.parse(groups.get?.call(this) as string) as {
              start: number;
              count: number;
              materialIndex: number;
            }[]
          ).map(({ start, count, materialIndex }) => ({ start, count, materialIndex }));
        },
      });
    // Each geometry class carries its own `attributes` accessor, so every one gets the view.
    Object.defineProperty(prototype, "attributes", {
      configurable: true,
      get(this: IGeometry) {
        const cached = attributeViews.get(this);
        if (cached !== undefined) return cached;
        const names = () => {
          const listed = this.__attributeNames === "" ? [] : this.__attributeNames.split("\n");
          return [...new Set([...STANDARD_ATTRIBUTES, ...listed])].filter((name) =>
            listed.includes(name),
          );
        };
        const view = new Proxy(
          {},
          {
            // getAttribute answers null for a missing name: one engine call, not two.
            get: (_, name) =>
              typeof name === "string" ? (this.getAttribute(name) ?? undefined) : undefined,
            has: (_, name) => typeof name === "string" && this.hasAttribute(name),
            set: (_, name, attribute) => {
              this.setAttribute(String(name), attribute);
              return true;
            },
            deleteProperty: (_, name) => {
              this.deleteAttribute(String(name));
              return true;
            },
            ownKeys: () => names(),
            // Object.keys asks for every name's descriptor: answer from the name list and read the
            // attribute only if the descriptor's getter runs.
            getOwnPropertyDescriptor: (_, name) =>
              typeof name === "string" && names().includes(name)
                ? {
                    get: () => this.getAttribute(name),
                    set: (attribute: unknown) => this.setAttribute(name, attribute),
                    enumerable: true,
                    configurable: true,
                  }
                : undefined,
          },
        );
        attributeViews.set(this, view);
        return view;
      },
    });
  }
}

// three's `shape.holes` is the plain array a game pushes paths into: each change writes the whole
// array through the native setter, so the geometry built from the shape sees it.
function defineShapeHoles(Shape: Constructor): void {
  const holeViews = new WeakMap<object, unknown[]>();
  const holes = Object.getOwnPropertyDescriptor(Shape.prototype, "holes");
  if (holes?.get === undefined || holes.set === undefined)
    throw new TypeError("TN_BROWSER_UNBOUND: Shape.holes needs the engine's getter and setter");
  Object.defineProperty(Shape.prototype, "holes", {
    configurable: true,
    get(this: object) {
      if (!holeViews.has(this)) {
        const shape = this;
        holeViews.set(
          this,
          new Proxy(holes.get?.call(this) as unknown[], {
            set(target, key, value) {
              // quality-allow: target is unknown[] accessed by PropertyKey inside Proxy handler.
              (target as unknown as Record<PropertyKey, unknown>)[key] = value;
              holes.set?.call(shape, [...target]);
              return true;
            },
          }),
        );
      }
      return holeViews.get(this);
    },
    set(this: object, value: unknown[]) {
      holes.set?.call(this, [...value]);
      holeViews.delete(this);
    },
  });
}

/**
 * three's abstract Material: the base the native material classes share for `instanceof` and its
 * default hooks. The engine compiles no WebGL program, so the hooks stay three's no-op defaults; a
 * bare Material has no native class and refuses construction.
 */
export class Material {
  constructor() {
    throw new Error("TN_NATIVE_MATERIAL_ABSTRACT: construct a concrete material class");
  }

  onBeforeCompile(): void {}

  // No program reads this key, and a strict build keeps no function source to stringify.
  customProgramCacheKey(): string {
    return "";
  }
}
// quality-allow: Material.prototype does not declare dynamic isMaterial property from Three.js class contract.
(Material.prototype as unknown as Prototype).isMaterial = true;

/** Attaches the shared views to a back end's engine classes. */
export function defineObjectSurface(classes: ISurfaceClasses): void {
  defineGeometrySurface(classes.bufferGeometry, classes.geometries);
  if (classes.shape !== undefined) defineShapeHoles(classes.shape);
  for (const material of classes.materials) {
    Object.setPrototypeOf(material.prototype, Material.prototype);
    // The browser back end already defines the flag (read-only) from the catalog.
    const flag = `is${material.name}`;
    if (!Object.hasOwn(material.prototype, flag)) (material.prototype as Prototype)[flag] = true;
  }
}

// three's scene classes and the `is<Class>` flag each one defines; every light is also `isLight`.
const FLAGGED_CLASSES = [
  "NodeMaterial",
  "MeshBasicNodeMaterial",
  "MeshStandardNodeMaterial",
  "MeshPhysicalNodeMaterial",
  "SpriteNodeMaterial",
  "Texture",
  "DataTexture",
  "CanvasTexture",
  "Object3D",
  "Scene",
  "Group",
  "Mesh",
  "SkinnedMesh",
  "InstancedMesh",
  "BatchedMesh",
  "Bone",
  "LOD",
  "Sprite",
  "Line",
  "LineSegments",
  "Points",
  "Camera",
  "PerspectiveCamera",
  "OrthographicCamera",
  "AmbientLight",
  "DirectionalLight",
  "HemisphereLight",
  "PointLight",
  "SpotLight",
] as const;

/**
 * three's `dispose()` on lights and instanced meshes frees a shadow map or the instance textures. The
 * engine frees those with the object, so the call has nothing to release (core's projection mirror
 * and a scene's exit make it). A back end's own `dispose` stays.
 */
export function defineReleaseNoops(classes: Readonly<Record<string, unknown>>): void {
  for (const name of [
    "BatchedMesh",
    "InstancedMesh",
    ...FLAGGED_CLASSES.filter((n) => n.endsWith("Light")),
  ]) {
    const cls = classes[name] as (new () => { dispose?: () => void }) | undefined;
    if (typeof cls === "function") cls.prototype.dispose ??= () => {};
  }
}

/**
 * Puts three's type flags (`isMesh`, `isCamera`, `isLight`, ...) on a back end's scene classes. A
 * subclass inherits its parent's through the prototype chain, as in three; a missing class is skipped.
 */
export function defineTypeFlags(classes: Readonly<Record<string, unknown>>): void {
  for (const name of FLAGGED_CLASSES) {
    const cls = classes[name] as Constructor | undefined;
    if (typeof cls !== "function") continue;
    const flags = name.endsWith("Light")
      ? [`is${name}`, "isLight"]
      : name.endsWith("NodeMaterial")
        ? [`is${name}`, "isNodeMaterial"]
        : [`is${name}`];
    for (const flag of flags)
      Object.defineProperty(cls.prototype, flag, {
        configurable: true,
        writable: true,
        value: true,
      });
  }
}
