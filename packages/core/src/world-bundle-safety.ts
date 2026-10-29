import type { Material, Mesh } from "three";
import { isEngineRenderHook } from "./engine-render-hook.js";

/**
 * The value `NodeUpdateType.RENDER` has, read as text so this file needs no import for it: a node
 * whose `updateBefore` runs on every render is a node whose work happens inside the draw that
 * recorded it, which is the whole test.
 */
const PER_RENDER_UPDATE = "render";

/**
 * Whether a node graph copies or renders the framebuffer, which a bundle encoder cannot be asked for.
 *
 * Every such node does its work in `updateBefore` and every one of them touches the *current* render
 * pass: `ViewportTextureNode` copies the bound framebuffer into a texture, and transmission, an
 * `RTTNode`, a `ReflectorNode` or a `PassNode` renders into one. Recorded into a bundle, the current
 * pass is a `GPURenderBundleEncoder`, which has no `end()` to close and no framebuffer to read, so
 * the call throws `currentPass.end is not a function` from inside the record and takes the whole
 * bundle's frame with it.
 *
 * Structural, over own properties and plain sub-objects, because a material's slots are node graphs
 * rather than one node: a `viewportSharedTexture()` under an arithmetic chain is still this. What it
 * cannot see is a node hidden inside an `Fn` body, which is how three keeps its own transmission
 * sampler — hence `transmission` is asked of the material itself as well.
 */
interface IBundleGraphSnapshot {
  readonly node: object;
  readonly keys: readonly string[];
  readonly links: readonly unknown[];
  readonly isNode: unknown;
  readonly beforeType: unknown;
  readonly before: string;
  readonly version: unknown;
  readonly terminal: boolean;
  readonly childReader: unknown;
  readonly children: readonly object[] | undefined;
}
interface IBundleGraphCapture {
  readonly rows: IBundleGraphSnapshot[];
  links: number;
  overflow: boolean;
}
interface IBundleMaterialCheck {
  readonly safe: boolean;
  readonly revision: number;
  readonly version: number;
  readonly transparent: boolean;
  readonly visible: boolean;
  readonly transmission: unknown;
  readonly rows: readonly IBundleGraphSnapshot[];
  /** The frame whose deep validation (or fresh walk) last proved this verdict. */
  provedFrame: number;
  /** The last frame that tested this material, so a frame counts its rows once. */
  testedFrame: number;
}

/**
 * Deep snapshot rows proved per frame, across every material. A small world proves every graph on
 * every frame; a forest of ~50 foliage surfaces at ~1,000 rows each spreads its proof instead of
 * walking ~50,000 rows each frame, which measured 10.9 s of a 25 s trace on the Strata preview. A
 * row costs about a microsecond, so the budget is about a millisecond a frame.
 */
const BUNDLE_PROOF_ROWS_PER_FRAME = 1024;

/** Own-link and installed-Node child snapshots avoid inherited TSL method scans. Deep unversioned
 * edits still invalidate: version/root identity alone cannot certify a mutable node graph. The
 * shallow witness (version, transparency, visibility, transmission) is read on every check. The deep
 * rows are proved once per `staleFrames` period: the rows the last frame tested over a per-frame
 * budget, so a small world proves every frame and a forest spreads its proofs evenly, each material
 * in its own slot of the period. Three itself rebuilds a draw only when `material.version` moves
 * (`RenderObjects.get`), so a deep edit without `needsUpdate` changes no compiled draw inside that
 * window. A graph past the witness caps uses the uncached safety walk. */
export class BundleSurfaceSafety {
  #checks = new WeakMap<Material, IBundleMaterialCheck>();
  #revision = 0;
  #frame = 0;
  #frameRows = 0;
  readonly stats = {
    checks: 0,
    refreshes: 0,
    validations: 0,
    uncached: 0,
    deferred: 0,
    staleFrames: 1,
  };

  clear(): void {
    this.#checks = new WeakMap();
  }

  /** Opens a frame: the period every deep proof is spread over follows the last frame's rows. */
  beginFrame(): void {
    this.#frame++;
    this.stats.staleFrames = Math.max(1, Math.ceil(this.#frameRows / BUNDLE_PROOF_ROWS_PER_FRAME));
    this.#frameRows = 0;
  }

  test(material: Material): IBundleMaterialCheck {
    this.stats.checks++;
    const previous = this.#checks.get(material);
    if (
      previous !== undefined &&
      previous.version === material.version &&
      previous.transparent === material.transparent &&
      previous.visible === material.visible &&
      previous.transmission === Reflect.get(material, "transmission")
    ) {
      if (previous.testedFrame !== this.#frame) {
        previous.testedFrame = this.#frame;
        this.#frameRows += previous.rows.length;
      }
      if (previous.provedFrame === this.#frame) return previous;
      const period = this.stats.staleFrames;
      const stale = this.#frame - previous.provedFrame;
      // Each verdict proves in its own slot of the period; a slot missed while the period grew is
      // made up at twice the period, so no verdict waits longer than that.
      if ((this.#frame + previous.revision) % period !== 0 && stale < 2 * period) {
        this.stats.deferred++;
        return previous;
      }
      if (previous.rows.every(graphSnapshotCurrent)) {
        this.stats.validations++;
        previous.provedFrame = this.#frame;
        return previous;
      }
    }
    this.stats.refreshes++;
    const capture: IBundleGraphCapture = { rows: [], links: 0, overflow: false };
    const checked: IBundleMaterialCheck = {
      safe: bundleSafeMaterial(material, capture),
      revision: ++this.#revision,
      version: material.version,
      transparent: material.transparent,
      visible: material.visible,
      transmission: Reflect.get(material, "transmission"),
      rows: capture.rows,
      provedFrame: this.#frame,
      testedFrame: this.#frame,
    };
    if (capture.overflow) {
      this.stats.uncached++;
      this.#checks.delete(material);
    } else this.#checks.set(material, checked);
    return checked;
  }
}

function graphSnapshotCurrent(row: IBundleGraphSnapshot): boolean {
  const node = row.node;
  const before = typeof Reflect.get(node, "updateBefore");
  if (
    Reflect.get(node, "isNode") !== row.isNode ||
    Reflect.get(node, "updateBeforeType") !== row.beforeType ||
    before !== row.before ||
    Reflect.get(node, "version") !== row.version
  )
    return false;
  if (row.terminal) return true; // Still a framebuffer reader, whatever its other children do.
  // TSL prototypes carry thousands of enumerable chaining methods, which are not child links.
  // Own slots stay cheap; Three's actual child reader witnesses inherited container links below.
  const keys = bundleGraphKeys(node);
  if (keys.length !== row.keys.length) return false;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index] as string;
    if (row.keys[index] !== key) return false;
    const value = Reflect.get(node, key);
    if ((value !== null && typeof value === "object" ? value : undefined) !== row.links[index])
      return false;
  }
  const reader = bundleGraphChildReader(node);
  if (reader !== row.childReader) return false;
  const expected = row.children;
  if (expected === undefined) return false;
  return readBundleGraphChildren(node, reader, expected) === expected;
}

/**
 * Three reads non-enumerable own Node/Material slots, but never inherited TSL chain methods, and
 * never a `_`-prefixed slot: `Node._getChildren` skips those, because they are private caches
 * (`ScreenNode._output` is rewritten every frame) rather than graph structure.
 */
function bundleGraphKeys(node: object): string[] {
  return (
    Reflect.get(node, "isNode") === true || Reflect.get(node, "isMaterial") === true
      ? Object.getOwnPropertyNames(node)
      : Object.keys(node)
  ).filter((key) => !key.startsWith("_"));
}
function bundleGraphChildReader(node: object): unknown {
  return Reflect.get(node, "isNode") === true ? Reflect.get(node, "getChildren") : undefined;
}
/** A child three's `getChildren` yields: an object node, or a callable TSL `Fn` (`typeof` "function"). */
function isGraphNode(child: unknown): child is object {
  return (
    child !== null &&
    (typeof child === "object" || typeof child === "function") &&
    Reflect.get(child, "isNode") === true
  );
}
function readBundleGraphChildren(
  node: object,
  reader: unknown,
  expected?: readonly object[],
): readonly object[] | undefined {
  if (reader === undefined) {
    if (expected === undefined) return [];
    return expected.length === 0 ? expected : undefined;
  }
  if (typeof reader !== "function") return undefined;
  try {
    const result: unknown = reader.call(node);
    if (
      result === null ||
      typeof result !== "object" ||
      typeof Reflect.get(result, Symbol.iterator) !== "function"
    )
      return undefined;
    if (expected !== undefined) {
      let index = 0;
      let match = true;
      for (const child of result as Iterable<unknown>) {
        if (index >= 8192 || !isGraphNode(child)) return undefined;
        if (match && child !== expected[index]) match = false;
        index++;
      }
      return match && index === expected.length ? expected : undefined;
    }
    const children: object[] = [];
    for (const child of result as Iterable<unknown>) {
      if (children.length >= 8192 || !isGraphNode(child)) return undefined;
      children.push(child);
    }
    return children;
  } catch {
    return undefined;
  }
}
function captureBundleGraph(
  node: object,
  terminal: boolean,
  capture: IBundleGraphCapture,
  childReader: unknown,
  children: readonly object[] | undefined,
): readonly unknown[] {
  const keys = terminal ? [] : bundleGraphKeys(node);
  const count = keys.length;
  capture.links += count + (children?.length ?? 0);
  if (children === undefined) capture.overflow = true;
  // A shipped foliage surface reaches ~1,000 nodes and ~21,000 links; a cap below that re-walked and
  // re-recorded every such material on every frame. The witness holds references only.
  if (capture.rows.length >= 4096 || capture.links > 65_536) capture.overflow = true;
  const values: unknown[] = new Array(count);
  if (capture.overflow) {
    for (let index = 0; index < count; index++)
      values[index] = Reflect.get(node, keys[index] as string);
    return values;
  }
  const links: (object | undefined)[] = new Array(count);
  for (let index = 0; index < count; index++) {
    const value: unknown = Reflect.get(node, keys[index] as string);
    values[index] = value;
    links[index] = value !== null && typeof value === "object" ? value : undefined;
  }
  capture.rows.push({
    node,
    terminal,
    childReader,
    children,
    keys,
    links,
    isNode: Reflect.get(node, "isNode"),
    beforeType: Reflect.get(node, "updateBeforeType"),
    before: typeof Reflect.get(node, "updateBefore"),
    version: Reflect.get(node, "version"),
  });
  return values;
}

function samplesFramebuffer(
  node: unknown,
  seen: Set<unknown>,
  capture?: IBundleGraphCapture,
): boolean {
  // Pixels and vertex data hold no node, and Object.values would copy every element of them.
  if (node === null || typeof node !== "object" || ArrayBuffer.isView(node) || seen.has(node))
    return false;
  seen.add(node);
  // A uniform group is a binding group, never a framebuffer reader, and three's shared frame and
  // render groups bump their `version` on every frame (`UniformGroupNode.update`). Walking into one
  // made every graph that holds a uniform look edited on every frame, which re-walked the whole
  // graph and re-recorded its bundle each frame.
  if (Reflect.get(node, "isUniformGroup") === true) return false;
  const candidate = node as {
    readonly isNode?: boolean;
    readonly updateBefore?: unknown;
    readonly updateBeforeType?: unknown;
  };
  if (
    candidate.isNode === true &&
    typeof candidate.updateBefore === "function" &&
    candidate.updateBeforeType === PER_RENDER_UPDATE
  ) {
    if (capture !== undefined) captureBundleGraph(node, true, capture, undefined, []);
    return true;
  }
  // getChildren owns Three's non-enumerable, dictionary and sparse-array child semantics. Its
  // ordered identities are a live witness, including prototype edits with unchanged own keys.
  const reader = bundleGraphChildReader(node);
  const children = readBundleGraphChildren(node, reader);
  const values =
    capture === undefined
      ? bundleGraphKeys(node).map((key) => Reflect.get(node, key))
      : captureBundleGraph(node, false, capture, reader, children);
  // Malformed/oversized child output retains the live source path. The stored witness is capped;
  // Three's eager getChildren implementation can still scan an authored array before yielding.
  if (children === undefined) return true;
  for (const value of values) {
    if (value === null || typeof value !== "object") continue;
    if (samplesFramebuffer(value, seen, capture)) return true;
  }
  for (const child of children) {
    if (samplesFramebuffer(child, seen, capture)) return true;
  }
  return false;
}

/**
 * Whether one mesh's draw can be recorded into a bundle and replayed from it.
 *
 * A bundle is an encoder, not a render pass: three fixes its render list and its draw order when it
 * records it, and every replay runs the encoded commands with no pass of its own to ask anything of.
 * So a mesh is bundle-safe only when nothing about its draw needs a live pass — the one question
 * {@link samplesFramebuffer} and the checks below both ask, of the node graph and of the object.
 *
 * - **The framebuffer.** A viewport or screen-space refraction sample, transmission, a render target,
 *   a reflector: `samplesFramebuffer`, plus `transmission` itself, which three's own lighting model
 *   reaches through an `Fn` body no structural walk can see.
 * - **Per-frame order.** A transparent mesh is sorted against its neighbours every frame; a record
 *   froze that order when it was made, so a bundled one draws in the order it happened to be in.
 * - **Per-object hooks.** `onBeforeRender`/`onAfterRender` are the two places a game reads the camera
 *   and the frame for a draw, and a replay runs them once at record time and never again. The
 *   engine's own borrow — the prewarm counting its batch's first submitted draw — is bookkeeping
 *   about the draw rather than a claim on the object, so it does not refuse; `isEngineRenderHook` is
 *   what tells them apart, the same answer `projection-plan.ts` gives.
 * - **Per-frame vertices.** A skinned or morphed mesh's positions are posed per frame from bones the
 *   record never reads, so its encoded vertices are its rest pose forever.
 *
 * A mesh that fails this stays on the per-object path — the path every chunk drew before bundles
 * existed — so a refusal costs the draw it was already paying and nothing else.
 */
export function bundleSafe(mesh: Mesh): boolean {
  if (ownHook(mesh, "onBeforeRender")) return false;
  if (ownHook(mesh, "onAfterRender")) return false;
  if ((mesh as Mesh & { readonly isSkinnedMesh?: boolean }).isSkinnedMesh === true) return false;
  if (mesh.morphTargetInfluences !== undefined) return false;
  return (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every((material) =>
    bundleSafeMaterial(material),
  );
}

/**
 * Whether this mesh carries a render hook of its own that is the game's, which a record freezes.
 *
 * `Object.hasOwn`, not the prototype comparison: the engine installs its own hook as an own property
 * on the very batches a prewarm borrowed, and refusing those would keep every batch of a streamed
 * world on the per-object path.
 */
export function ownHook(mesh: Mesh, name: "onAfterRender" | "onBeforeRender"): boolean {
  return Object.hasOwn(mesh, name) && isEngineRenderHook(mesh[name]) === false;
}

/** The material half of {@link bundleSafe}: nothing it draws may need a pass it was recorded in. */
export function bundleSafeMaterial(
  material: Material | undefined,
  capture?: IBundleGraphCapture,
): boolean {
  if (material === undefined) return true;
  if (material.transparent === true) return false;
  // Read structurally: a `MeshPhysicalMaterial` always has the number and nothing else does, and
  // three's transmission sampler is not a node slot, so `transmission` is the only way to see it.
  const transmission = Reflect.get(material, "transmission");
  if (typeof transmission === "number" && transmission > 0) return false;
  return samplesFramebuffer(material, new Set(), capture) === false;
}
