/**
 * Syncs the catalog's capability statuses with the engine's binding registry (PRD-531 phase 1).
 *
 *   pnpm --filter @threenative/three-native sync-native-status -- --dump <registry.json>
 *
 * The registry dump is the truth of what is natively implemented and bound:
 * `tn-native-engine-registry-dump` prints it. A class the registry binds becomes `supported`; each
 * member it binds becomes `supported` (a catalog method by name, a field by a top-level getter or
 * member object); an unbound member of a bound class becomes `partial(native-not-bound)`. A bound
 * class the catalog lacks is added, modeling a sibling and listing only members the registry binds.
 * A missing member is typed from its class chain in `@types/three`; a bound member with no type source
 * is `TN_CATALOG_UNKNOWN_BINDING` and fails the sync, so the catalog never publishes an untyped member.
 *
 * Dotted registry paths (`position.x`, `attributes.position`) are protocol paths, not catalog members.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  CatalogEntry,
  ICatalog,
  ICatalogField,
  ICatalogMethod,
  ICatalogParameter,
} from "../src/catalog.js";

type Writable<T> = T extends readonly (infer U)[]
  ? Writable<U>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Writable<T[Key]> }
    : T;

type MutableCatalog = Writable<ICatalog>;
type MutableClass = Writable<Extract<CatalogEntry, { kind: "class" }>>;
type MutableField = Writable<ICatalogField>;
type MutableMethod = Writable<ICatalogMethod>;

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const CATALOG_PATH = path.join(REPO, "packages", "three-native", "api", "catalog.json");

interface IRegistryClass {
  readonly constructor: boolean;
  readonly methods: string[];
  readonly getters: string[];
  readonly setters: string[];
  readonly members: string[];
  /** Language callbacks the engine calls back (`onBeforeRender`), set through tn_set_callback. */
  readonly callbacks: string[];
}

interface IRegistryDump {
  readonly classes: Record<string, IRegistryClass>;
  readonly constants?: readonly string[];
}

const SUPPORTED = { kind: "supported" } as const;
const NOT_IMPLEMENTED = {
  kind: "partial" as const,
  gaps: ["native-not-implemented"] as string[],
};
const NOT_BOUND = { kind: "partial" as const, gaps: ["native-not-bound"] as string[] };

const unknown: string[] = [];

/** A bound field whose three type the catalog narrows to what the binding accepts. */
const FIELD_TYPE_OVERRIDE: Record<string, string> = {
  // @types/three's RenderTarget<TTexture> is generic; the engine's target colour is a Texture.
  "RenderTarget.texture": "Texture",
  // @types/three names these by union aliases the catalog does not publish; they are three's numbers.
  "Texture.format": "number",
  "Texture.type": "number",
  "BufferGeometry.groups": "string",
  // The binding answers three's `{ start, count }[]` as its canonical JSON text.
  "BufferAttribute.updateRanges": "string",
  "Scene.background": "Color | Texture | null",
  "SkinnedMesh.bindMode": '"attached" | "detached"',
  "SkinnedMesh.boundingBox": "Box3 | null",
  // @types/three spells Line's members over its own type parameters, which no entry publishes.
  "Line.geometry": "BufferGeometry",
  "Line.material": "Material",
  "AnimationClip.tracks":
    "Array<{ name: string; times: number[]; values: number[]; ValueTypeName: string }>",
};

/** Bound methods whose binding signature differs from three's richer overloads. */
// EventDispatcher's generic event-map overloads, as the native mixer and Object3D bind them: any
// event type, one listener function. @types/three spells them over AnimationMixerEventMap and
// Object3DEventMap, which no catalog entry publishes.
const LISTENER: ICatalogParameter[] = [
  { name: "type", type: "string", optional: false },
  { name: "listener", type: "EventListener", optional: false, callback: "EventListener" },
];
const dispatcherMethods = (owner: string) => ({
  [`${owner}.addEventListener`]: [{ parameters: LISTENER, returns: "void" }],
  [`${owner}.removeEventListener`]: [{ parameters: LISTENER, returns: "void" }],
  [`${owner}.hasEventListener`]: [{ parameters: LISTENER, returns: "boolean" }],
  [`${owner}.dispatchEvent`]: [
    { parameters: [{ name: "event", type: "BaseEvent", optional: false }], returns: "void" },
  ],
});

const METHOD_OVERRIDE: Record<string, { parameters: ICatalogParameter[]; returns: string }[]> = {
  ...dispatcherMethods("AnimationMixer"),
  ...dispatcherMethods("Object3D"),
  // three sets `targetObject` when it binds and @types/three does not declare it; the engine answers
  // it as a call, which the shared facade (src/property-binding.ts) publishes as three's property.
  "PropertyBinding.targetObject": [{ parameters: [], returns: "Object3D | Material | null" }],
  // three's statics, answered by a root-less engine helper the shared facade calls.
  "PropertyBinding.parseTrackName": [
    {
      parameters: [{ name: "trackName", type: "string", optional: false }],
      returns:
        "{ nodeName: string; objectName: string; objectIndex: string; propertyName: string; propertyIndex: string }",
    },
  ],
  // three's addon namespace utils/SkeletonUtils (not in @types/three's class chain).
  "SkeletonUtils.clone": [
    { parameters: [{ name: "source", type: "Object3D", optional: false }], returns: "Object3D" },
  ],
  "PropertyBinding.findNode": [
    {
      parameters: [
        { name: "root", type: "Object3D", optional: false },
        { name: "nodeName", type: "string", optional: true },
      ],
      returns: "Object3D | null",
    },
  ],
  // The native port intersects Object3D geometry, independent of @types/three's generic overloads.
  "Raycaster.intersectObject": [
    {
      parameters: [
        { name: "object", type: "Object3D", optional: false },
        { name: "recursive", type: "boolean", optional: true },
        { name: "target", type: "Intersection[]", optional: true },
      ],
      returns: "Intersection[]",
    },
  ],
  "Raycaster.intersectObjects": [
    {
      parameters: [
        { name: "objects", type: "Object3D[]", optional: false },
        { name: "recursive", type: "boolean", optional: true },
        { name: "target", type: "Intersection[]", optional: true },
      ],
      returns: "Intersection[]",
    },
  ],
  "BufferGeometry.setAttribute": [
    {
      parameters: [
        { name: "name", type: "string", optional: false },
        { name: "attribute", type: "BufferAttribute", optional: false },
      ],
      returns: "this",
    },
  ],
  "BufferGeometry.getAttribute": [
    {
      parameters: [{ name: "name", type: "string", optional: false }],
      returns: "BufferAttribute | null",
    },
  ],
  "BufferGeometry.deleteAttribute": [
    {
      parameters: [{ name: "name", type: "string", optional: false }],
      returns: "this",
    },
  ],
  "BufferGeometry.hasAttribute": [
    {
      parameters: [{ name: "name", type: "string", optional: false }],
      returns: "boolean",
    },
  ],
  // three r185 has Vector4.clampLength; the pinned @types/three lags it.
  "Vector4.clampLength": [
    {
      parameters: [
        { name: "min", type: "number", optional: false },
        { name: "max", type: "number", optional: false },
      ],
      returns: "this",
    },
  ],
  // The engine calls it with no renderer and no group (tn_set_callback); three types the renderer
  // as WebGLRenderer, which the catalog does not publish.
  "Object3D.onBeforeRender": [
    {
      parameters: [
        { name: "renderer", type: "null", optional: false },
        { name: "scene", type: "Scene", optional: false },
        { name: "camera", type: "Camera", optional: false },
        { name: "geometry", type: "BufferGeometry", optional: false },
        { name: "material", type: "Material", optional: false },
        { name: "group", type: "null", optional: false },
      ],
      returns: "void",
    },
  ],
  // The binding's `toArray()` takes no argument and returns the plain array.
  "Vector2.toArray": [{ parameters: [], returns: "number[]" }],
  // The native Sprite shares Mesh's morph storage and binding surface.
  "Sprite.updateMorphTargets": [{ parameters: [], returns: "void" }],
};

/**
 * Bound members @types/three does not declare: engine-only counters, and `id`, which three's
 * Material defines at runtime but the pinned types omit. Everything else is typed from @types/three.
 */
const UNDECLARED_FIELDS: Record<string, string> = {
  revision: "number",
  id: "number",
  "BufferGeometry.parameters": "Record<string, unknown>",
  // Basic stores these authored slots too; upstream only evaluates emissiveNode.
  "MeshBasicNodeMaterial.emissiveNode": "Node | null",
  "MeshBasicNodeMaterial.roughnessNode": "Node | null",
  "MeshBasicNodeMaterial.metalnessNode": "Node | null",
  "Sprite.morphTargetInfluences": "number[]",
  "SpriteNodeMaterial.emissiveNode": "Node | null",
  "SpriteNodeMaterial.roughnessNode": "Node | null",
  "SpriteNodeMaterial.metalnessNode": "Node | null",
};

/** A `__` member is engine-internal (a back end calls it, as `__walk`); three's surface never has it. */
const published = (member: string): boolean => !member.startsWith("__");

function registryMembers(binding: IRegistryClass): Set<string> {
  return new Set([
    ...binding.methods.filter(published),
    ...binding.getters.filter((name) => !name.includes(".") && published(name)),
    ...binding.members.filter((name) => !name.includes(".")),
    ...binding.callbacks,
  ]);
}

// ------------------------------------------------------------------------------- three types

const TYPES_ROOT = (() => {
  const pnpm = path.join(REPO, "node_modules", ".pnpm");
  for (const entry of readdirSync(pnpm)) {
    if (entry.startsWith("@types+three@")) {
      const dir = path.join(pnpm, entry, "node_modules", "@types", "three");
      if (existsSync(dir)) return dir;
    }
  }
  return null;
})();

const classFiles = new Map<string, string>();
const declarationBodies = new Map<string, string | null>();
const classParents = new Map<string, string | null>();
// A generic class's own type parameter names, and the type arguments its `extends` passes its parent
// (`DirectionalLightShadow extends LightShadow<OrthographicCamera>`), so an inherited `camera: TCamera`
// is typed as the subclass sees it.
const classTypeParameters = new Map<string, string[]>();
const classParentArguments = new Map<string, string[]>();

/** Top-level comma-separated parts of a `<...>` list's inside. */
function typeList(text: string | undefined): string[] {
  if (text === undefined) return [];
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if ("([{<".includes(character)) depth++;
    if (")]}>".includes(character)) depth--;
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

function indexThreeTypes(): void {
  if (TYPES_ROOT === null) return;
  const source = path.join(TYPES_ROOT, "src");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith(".d.ts")) continue;
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const match of text.matchAll(
        /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface)\s+([A-Za-z_$][\w$]*)/gu,
      )) {
        const name = match[1];
        // Keep the declaration before later renderer module augmentations of the same interface.
        if (name !== undefined && !classFiles.has(name)) classFiles.set(name, full);
      }
    }
  };
  walk(source);
  // Addon classes (`RoundedBoxGeometry`) are typed beside their module; core declarations win.
  walk(path.join(TYPES_ROOT, "examples", "jsm"));
}

/** The body between a declaration's opening brace and its matching close. */
function declarationBody(keyword: "class" | "interface", name: string): string | null {
  const key = `${keyword} ${name}`;
  if (declarationBodies.has(key)) return declarationBodies.get(key) ?? null;
  const file = classFiles.get(name);
  if (file === undefined) {
    declarationBodies.set(key, null);
    return null;
  }
  const text = readFileSync(file, "utf8");
  const header = new RegExp(
    `(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?${keyword}\\s+${name}\\b(?:<([^>]*)>)?\\s*(?:extends\\s+([A-Za-z_$][\\w$]*)(?:<([^{]*?)>)?)?[^{]*\\{`,
    "u",
  ).exec(text);
  if (header === null) {
    declarationBodies.set(key, null);
    return null;
  }
  if (keyword === "class") {
    classParents.set(name, header[2] ?? null);
    classTypeParameters.set(
      name,
      typeList(header[1]).map((parameter) => parameter.split(/\s|=/u)[0] ?? parameter),
    );
    classParentArguments.set(name, typeList(header[3]));
  }
  const start = header.index + header[0].length;
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      const body = text.slice(start, i);
      declarationBodies.set(key, body);
      return body;
    }
  }
  declarationBodies.set(key, null);
  return null;
}

/** @types/three splits a class's fields into a merged `XProperties` interface. */
function bodiesFor(name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const bodies: string[] = [];
  const classDeclaration = declarationBody("class", name);
  if (classDeclaration !== null) bodies.push(classDeclaration);
  for (const candidate of [name, `${name}Properties`]) {
    const properties = declarationBody("interface", candidate);
    if (properties === null) continue;
    bodies.push(properties);
    // Default-exported node materials merge a same-name interface with property interfaces.
    const file = classFiles.get(candidate);
    const text = file === undefined ? "" : readFileSync(file, "utf8");
    const parents = new RegExp(`interface\\s+${candidate}\\b\\s+extends\\s+([^{}]+)\\{`, "u").exec(
      text,
    )?.[1];
    for (const parent of parents?.split(",") ?? []) {
      const simple = parent.trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(simple)) bodies.push(...bodiesFor(simple, seen));
    }
  }
  return bodies;
}

function chain(name: string): string[] {
  const names: string[] = [];
  let current: string | null | undefined = name;
  while (current !== null && current !== undefined && !names.includes(current)) {
    names.push(current);
    if (!classParents.has(current)) declarationBody("class", current);
    current = classParents.get(current) ?? null;
  }
  return names;
}

/** The declared type of a field or accessor, reading a multi-line object type to its closing `;`. */
function captureMemberType(body: string, member: string): string | null {
  const heads = new RegExp(
    `(?:^|[\\n;{}])\\s*(?:(?:static|abstract|declare|readonly|get|set)\\s+)*${member}\\s*(?:\\(\\s*\\))?\\s*\\??\\s*:\\s*`,
    "gu",
  );
  // A constructor written one parameter per line also matches `name?: type` at a line start; its
  // type text then runs out through the list's closing ')', which no member declaration does.
  for (let head = heads.exec(body); head !== null; head = heads.exec(body)) {
    const start = head.index + head[0].length;
    let depth = 0;
    for (let i = start; i < body.length; i++) {
      const character = body.charAt(i);
      if ("([{<".includes(character)) depth++;
      else if (")]}>".includes(character)) depth--;
      if (depth < 0) break;
      if (character === ";" && depth <= 0) {
        return body
          .slice(start, i)
          .replace(/\/\*[\s\S]*?\*\//gu, " ")
          .replace(/\/\/[^\n]*/gu, " ")
          .replace(/\s+/gu, " ")
          .trim();
      }
    }
  }
  return null;
}

function findFieldType(className: string, member: string): string | null {
  // Type arguments in scope for the class being read: a parent's parameters bound by its child.
  let bound = new Map<string, string>();
  const substitute = (type: string): string =>
    type.replace(/[A-Za-z_$][\w$]*/gu, (word) => bound.get(word) ?? word);
  for (const name of chain(className)) {
    for (const body of bodiesFor(name)) {
      const type = captureMemberType(body, member);
      if (type !== null) return substitute(type);
    }
    const parent = classParents.get(name);
    if (parent === null || parent === undefined) break;
    if (!classParents.has(parent)) declarationBody("class", parent);
    const parameters = classTypeParameters.get(parent) ?? [];
    const args = (classParentArguments.get(name) ?? []).map(substitute);
    bound = new Map(
      parameters.flatMap((parameter, i) => (args[i] === undefined ? [] : [[parameter, args[i]]])),
    );
  }
  return null;
}

function parseParameters(text: string): ICatalogParameter[] {
  const parameters: ICatalogParameter[] = [];
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if ("([{<".includes(character)) depth++;
    if (")]}>".includes(character)) depth--;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  for (const part of parts) {
    const match = /^\s*(\.\.\.)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*(.+?)\s*$/u.exec(part);
    if (match === null) continue;
    const rest = match[1] !== undefined;
    const name = match[2];
    const type = match[4];
    if (name === undefined || type === undefined) continue;
    const parameter: ICatalogParameter = {
      name,
      type,
      optional: rest || match[3] !== undefined,
      ...(rest ? { rest: true } : {}),
    };
    parameters.push(parameter);
  }
  return parameters;
}

function findMethod(
  className: string,
  member: string,
): { parameters: ICatalogParameter[]; returns: string }[] | null {
  for (const name of chain(className)) {
    for (const body of bodiesFor(name)) {
      const match = new RegExp(
        `(?:^|[\\n;{}])\\s*(?:(?:static|abstract|declare|get|set)\\s+)*${member}\\s*\\(([^;]*?)\\)\\s*:\\s*([^;]+);`,
        "u",
      ).exec(body);
      if (match === null) continue;
      const parameters = match[1];
      const returns = match[2];
      if (parameters === undefined || returns === undefined) continue;
      return [{ parameters: parseParameters(parameters), returns: returns.trim() }];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------- catalog

function classEntry(name: string): MutableClass {
  return {
    name,
    kind: "class",
    source: "three",
    status: SUPPORTED,
    extends: null,
    constructor: [],
    fields: [],
    methods: [],
  };
}

function nearestCataloguedParent(
  name: string,
  catalogued: (candidate: string) => boolean,
): string | null {
  for (const parent of chain(name).slice(1)) {
    if (catalogued(parent)) return parent;
  }
  return null;
}

function fieldFor(className: string, member: string, mutable: boolean): MutableField | null {
  const key = `${className}.${member}`;
  const override = FIELD_TYPE_OVERRIDE[key] ?? UNDECLARED_FIELDS[key] ?? UNDECLARED_FIELDS[member];
  const counterpart =
    className === "MeshBasicNodeMaterial" || className === "MeshStandardNodeMaterial"
      ? className.replace("NodeMaterial", "Material")
      : null;
  const type =
    override ??
    findFieldType(className, member) ??
    (counterpart === null ? null : findFieldType(counterpart, member));
  if (type === null || type === undefined) {
    unknown.push(`${className}.${member}`);
    return null;
  }
  return { name: member, type, mutable, lifetime: "owned", status: SUPPORTED };
}

function methodFor(className: string, member: string): MutableMethod | null {
  const overloads = METHOD_OVERRIDE[`${className}.${member}`] ?? findMethod(className, member);
  if (overloads === null) {
    unknown.push(`${className}.${member}`);
    return null;
  }
  return { name: member, async: false, overloads, status: SUPPORTED };
}

function supportedMembers(entry: MutableClass): Set<string> {
  const names = new Set<string>();
  for (const member of [...entry.fields, ...entry.methods]) {
    if (member.status?.kind === "supported") names.add(member.name);
  }
  return names;
}

function effectiveSupported(
  entry: MutableClass,
  byName: Map<string, MutableClass>,
  seen = new Set<string>(),
): Set<string> {
  const names = supportedMembers(entry);
  const parent = entry.extends;
  if (parent !== null && !seen.has(parent)) {
    seen.add(entry.name);
    const parentEntry = byName.get(parent);
    if (parentEntry !== undefined) {
      for (const name of effectiveSupported(parentEntry, byName, seen)) names.add(name);
    }
  }
  return names;
}

/** A registry class the catalog lacks is added; every bound class entry becomes supported. */
function ensureSupportedClasses(
  catalog: MutableCatalog,
  byName: Map<string, MutableClass>,
  dump: IRegistryDump,
): void {
  for (const name of Object.keys(dump.classes)) {
    let entry = byName.get(name);
    if (entry === undefined) {
      entry = classEntry(name);
      catalog.entries.push(entry);
      byName.set(name, entry);
    }
    entry.status = SUPPORTED;
    const parent = nearestCataloguedParent(name, (candidate) => byName.has(candidate));
    if (name === "MeshBasicNodeMaterial" || name === "MeshStandardNodeMaterial") {
      // Publish the bound Material surface; the full upstream NodeMaterial base remains unbound.
      entry.extends = "Material";
    } else if (parent !== null) entry.extends = parent;
  }
}

/**
 * A bound member is supported; an unbound member without its own diagnostic is
 * partial(native-not-bound). An explicit unsupported diagnostic is kept.
 */
function applyMemberStatuses(dump: IRegistryDump, byName: Map<string, MutableClass>): void {
  for (const name of Object.keys(dump.classes)) {
    const entry = byName.get(name);
    const binding = dump.classes[name];
    if (entry === undefined || binding === undefined) continue;
    const bound = registryMembers(binding);
    for (const field of entry.fields) {
      if (bound.has(field.name)) {
        field.status = SUPPORTED;
        if (binding.setters.includes(field.name)) field.mutable = true;
        const override = FIELD_TYPE_OVERRIDE[`${name}.${field.name}`];
        if (override !== undefined) field.type = override;
      } else if (field.status?.kind !== "unsupported") {
        field.status = NOT_BOUND;
      }
    }
    for (const method of entry.methods) {
      if (bound.has(method.name)) {
        method.status = SUPPORTED;
        const override = METHOD_OVERRIDE[`${name}.${method.name}`];
        if (override !== undefined) method.overloads = override;
      } else if (method.status?.kind !== "unsupported") {
        method.status = NOT_BOUND;
      }
    }
  }
}

/** A registry member the catalog lacks is added, parents first so a derived class inherits. */
function addMissingMembers(dump: IRegistryDump, byName: Map<string, MutableClass>): void {
  // Parents first, by the catalog's own chain (the one `effectiveSupported` walks): a member a parent
  // gains here then covers its subclasses, whose @types file the chain parser may not find.
  const depth = (name: string): number => {
    let count = 0;
    for (let at = byName.get(name); at?.extends; at = byName.get(at.extends)) count++;
    return count;
  };
  const order = Object.keys(dump.classes).sort((left, right) => depth(left) - depth(right));
  for (const name of order) {
    const entry = byName.get(name);
    const binding = dump.classes[name];
    if (entry === undefined || binding === undefined) continue;
    const covered = effectiveSupported(entry, byName);
    for (const member of binding.methods.filter(published)) {
      if (covered.has(member)) continue;
      const method = methodFor(name, member);
      if (method === null) continue;
      entry.methods.push(method);
      covered.add(member);
    }
    const getters = [
      ...binding.getters.filter((member) => !member.includes(".") && published(member)),
      ...binding.members.filter((member) => !member.includes(".")),
    ];
    for (const member of getters) {
      if (covered.has(member) || binding.methods.includes(member)) continue;
      const field = fieldFor(name, member, binding.setters.includes(member));
      if (field === null) continue;
      entry.fields.push(field);
      covered.add(member);
    }
  }
}

/** A catalog constant is supported exactly when the engine's constant table (the dump) lists it. */
function syncConstants(catalog: MutableCatalog, dumped: readonly string[]): void {
  const listed = new Set(dumped);
  const constants = new Map<string, Writable<CatalogEntry>>();
  for (const entry of catalog.entries)
    if (entry.kind === "constant") constants.set(entry.name, entry);
  for (const name of dumped) if (!constants.has(name)) unknown.push(`constant.${name}`);
  for (const [name, entry] of constants) {
    if (listed.has(name)) entry.status = SUPPORTED;
    else if (entry.status.kind === "supported") entry.status = NOT_IMPLEMENTED;
  }
}

function main(): void {
  const dumpIndex = process.argv.indexOf("--dump");
  const dumpPath = dumpIndex === -1 ? undefined : process.argv[dumpIndex + 1];
  if (dumpPath === undefined) throw new Error("usage: sync-native-status --dump <registry.json>");
  const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as IRegistryDump;
  indexThreeTypes();

  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as MutableCatalog;
  const byName = new Map<string, MutableClass>();
  for (const entry of catalog.entries) if (entry.kind === "class") byName.set(entry.name, entry);

  syncConstants(catalog, dump.constants ?? []);

  if (
    dump.classes.MeshBasicNodeMaterial !== undefined ||
    dump.classes.MeshStandardNodeMaterial !== undefined
  ) {
    const node = byName.get("Node");
    if (node !== undefined)
      node.status = { kind: "partial", gaps: ["graph-authoring-only", "constructor-not-bound"] };
  }
  ensureSupportedClasses(catalog, byName, dump);
  applyMemberStatuses(dump, byName);
  addMissingMembers(dump, byName);
  if (unknown.length > 0) {
    for (const member of unknown) process.stderr.write(`TN_CATALOG_UNKNOWN_BINDING ${member}\n`);
    process.exit(1);
  }

  writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  const supported = catalog.entries.filter((entry) => entry.status.kind === "supported").length;
  process.stdout.write(
    `TN_CATALOG_SYNCED: ${Object.keys(dump.classes).length} registry classes, ${supported} supported catalog entries\n`,
  );
}

main();
