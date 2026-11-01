/** Native VSM owns the clip cameras and sampling; core keeps its public option validation. */
let nextId = 0;
const installed = new Set<ShadowBaseNode>();
const dispatchKey = Symbol.for("threenative.virtualShadowCommand");
const bridgeKey = Symbol.for("threenative.virtualShadow");
/** Core's registration counter for the discrete LOD chains (see `bumpChains` in core's model-lod). */
const chainsVersionKey = Symbol.for("threenative.discreteLodChainsVersion");
/** The facade's count of `mesh.geometry` assignments (browser-backend's setter): a swap moves no hierarchy. */
const geometryAssignmentsKey = Symbol.for("threenative.geometryAssignments");
/** The symbol-keyed slots the native bridge keeps on a core shadow node. */
interface IBridgeSlots {
  [dispatchKey]?: unknown;
  [bridgeKey]?: unknown;
}
interface IShadowObject {
  id: number;
  parent?: IShadowObject | null;
  geometry?: object;
  traverse(callback: (child: IShadowObject) => void): void;
}
/** Transfer registered chain data: the derived rungs and their errors. Native chooses its rung separately for every shadow level. */
export function detachVirtualShadow(value: unknown): void {
  if (!(value instanceof ShadowBaseNode)) return;
  installed.delete(value);
  value.dispatch = undefined;
  value.lods.clear();
  delete (value as IBridgeSlots)[dispatchKey];
}
/**
 * Records what the light-root walk depends on and answers whether the last one still holds. Its answer
 * can change in exactly three ways: core registered a chain (the version), a mesh's geometry was assigned
 * (the facade's counter), or the hierarchy moved (the
 * engine's counter, stamped on the root and every one of its ancestors). A backend without that counter
 * (JSDOM, another engine) never skips.
 */
function walkStillCurrent(node: ShadowBaseNode, root: IShadowObject): boolean {
  const revision = (root as { __hierarchyRevision?: number }).__hierarchyRevision;
  if (revision === undefined) return false;
  const host = globalThis as Record<symbol, unknown>;
  const version = host[chainsVersionKey] as number | undefined;
  const assignments = host[geometryAssignmentsKey] as number | undefined;
  const current =
    revision === node.walkedAt &&
    version === node.walkedVersion &&
    assignments === node.walkedAssignments;
  node.walkedAt = revision;
  node.walkedVersion = version;
  node.walkedAssignments = assignments;
  return current;
}
export function syncVirtualShadowLods(): void {
  const chains = (globalThis as Record<symbol, unknown>)[
    Symbol.for("threenative.discreteLodChains")
  ] as WeakMap<object, { chain: { levels: object[]; errors: number[] } }> | undefined;
  if (!chains) return;
  for (const node of installed) {
    if (node.disposed) {
      installed.delete(node);
      continue;
    }
    let root = node.light as IShadowObject;
    while (root.parent) root = root.parent;
    if (typeof root.traverse !== "function") continue;
    if (walkStillCurrent(node, root)) continue;
    const present = new Set<number>();
    root.traverse((child) => {
      if (!child.geometry) return;
      const chain = chains.get(child.geometry)?.chain;
      if (!chain || chain.levels.length < 2) return;
      present.add(child.id);
      if (node.lods.get(child.id) === chain) return;
      // Rung 0 is the caster's own geometry; native already holds it.
      node.dispatch?.({
        command: "lod",
        id: child.id,
        geometries: chain.levels.slice(1),
        errors: chain.errors.slice(1),
      });
      node.lods.set(child.id, chain);
    });
    for (const id of node.lods.keys()) {
      if (present.has(id)) continue;
      node.dispatch?.({ command: "unlod", id });
      node.lods.delete(id);
    }
  }
}
export class ShadowBaseNode {
  static get type(): string {
    return "ShadowBaseNode";
  }
  readonly id = nextId++;
  readonly isNode = true;
  readonly isShadowBaseNode = true;
  updateBeforeType = "render";
  disposed = false;
  dispatch?: (value: object) => void;
  readonly lods = new Map<number, object>();
  /** What the last light-root walk saw; neither number moving means its result cannot have changed. */
  walkedAt?: number;
  walkedVersion?: number;
  walkedAssignments?: number;
  constructor(readonly light: object) {}
  dispose(): void {
    const shadow = (this.light as { shadow?: { shadowNode?: unknown } }).shadow;
    if (shadow?.shadowNode === this) shadow.shadowNode = null;
    this.disposed = true;
    detachVirtualShadow(this);
  }
}

/** Core stores selection guards after subtracting refreshStep; native's factory subtracts it. */
export function virtualShadowOptions(
  value: unknown,
  dispatch?: (value: object) => void,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    !(value instanceof ShadowBaseNode) ||
    (value.constructor as typeof ShadowBaseNode).type !== "VirtualShadowNode" ||
    !("options" in value)
  )
    throw new TypeError("TN_NATIVE_SHADOW_NODE_UNSUPPORTED: expected core VirtualShadowNode");
  if (value.disposed) throw new Error("TN_NATIVE_SHADOW_NODE_DISPOSED");
  if (dispatch) {
    value.dispatch = dispatch;
    (value as IBridgeSlots)[dispatchKey] = dispatch;
    installed.add(value);
  }
  const bridge = (value as IBridgeSlots)[bridgeKey];
  const options = (bridge ?? value.options) as Record<string, unknown>;
  const guards = options.selectionGuard as number[];
  const steps = options.refreshStep as number[];
  return {
    ...options,
    selectionGuard: guards.map((guard, i) => guard + (steps[Math.min(i, steps.length - 1)] ?? 0)),
  };
}

/**
 * Only the source-angle filter (a sun) and the source-radius filter (a lamp) have engine
 * implementations; never silently drop a callback.
 */
export function shadowFilterOptions(value: unknown): Record<string, number> | null {
  if (value === null) return null;
  const tagged = (name: string) =>
    typeof value === "function" ? Reflect.get(value, Symbol.for(`threenative.${name}`)) : undefined;
  const angle = tagged("sourceAngleShadowFilter");
  const options = angle ?? tagged("sourceRadiusShadowFilter");
  if (typeof options !== "object" || options === null)
    throw new Error(
      "TN_VIRTUAL_SHADOW_UNSUPPORTED: filterNode (sourceAngleShadowFilter or sourceRadiusShadowFilter required)",
    );
  const config = options as Record<string, unknown>;
  const size = angle ? "sourceAngleRad" : "sourceRadius";
  const { [size]: extent, blockerSamples, filterSamples, penumbraScale } = config;
  // A sun's optional keys, each with its range; a lamp has none.
  const sunKeys: Record<string, (n: number) => boolean> = {
    minPenumbraPixels: (n) => Number.isFinite(n) && n >= 0 && n <= 16,
    samplesPerRay: (n) => Number.isInteger(n) && n >= 0 && n <= 64,
    rayLengthScale: (n) => Number.isFinite(n) && n > 0,
  };
  const optional =
    angle === undefined
      ? []
      : Object.keys(sunKeys)
          .filter((key) => config[key] !== undefined)
          .map((key) => [key, config[key]] as const);
  if (
    typeof extent !== "number" ||
    !Number.isFinite(extent) ||
    extent < 0 ||
    (angle !== undefined && extent >= Math.PI / 2) ||
    [blockerSamples, filterSamples].some(
      (count) => typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 64,
    ) ||
    (angle === undefined &&
      (typeof penumbraScale !== "number" || !(penumbraScale > 0 && penumbraScale <= 4))) ||
    optional.some(([key, v]) => typeof v !== "number" || sunKeys[key]?.(v) !== true)
  )
    throw new Error(
      `TN_VIRTUAL_SHADOW_INVALID: ${angle ? "source-angle" : "source-radius"} filter`,
    );
  return {
    [size]: extent,
    blockerSamples: blockerSamples as number,
    filterSamples: filterSamples as number,
    // A lamp keeps a share of its geometric penumbra (sourceRadiusShadowFilter's penumbraScale).
    ...(angle === undefined ? { penumbraScale: penumbraScale as number } : {}),
    ...(Object.fromEntries(optional) as Record<string, number>),
  };
}
