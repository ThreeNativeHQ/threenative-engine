/**
 * three's `pass(scene, camera)`, `mrt()` and the MRT slots over the engine's own scene pass, for both
 * back ends (the V8 player and the Wasm engine). The engine draws one scene pass whose targets are
 * the renderer's colour ("output"), depth and, with an MRT that asks for it, view normals, material
 * values and the diffuse colour; a pass's texture nodes name those targets. `normalView` is the engine's TSL node, as in three, so a graph
 * reads it and `mrt({ normal: normalView })` names the normal target by that node's identity.
 *
 * Which pass is the frame's is fixed by how it is made, never by when: `pass(scene, camera)` (the
 * call a world environment makes, and the one core re-aims at the frame's root every frame) is the
 * frame pass and the only one that publishes a scene. `new PassNode(PassNode.COLOR, scene, camera)`
 * is an offscreen pass: it owns a HalfFloat RenderTarget of floor(surface * resolutionScale), is
 * drawn into it each frame before the frame samples it (`updateSecondaryPasses`), and never
 * publishes. The two cannot be told apart by scene at construction, because a pass hands out its
 * texture node before any frame has named the frame's scene.
 */

const HALF_FLOAT_TYPE = 1016; // three's HalfFloatType

interface ISurface {
  readonly width: number;
  readonly height: number;
}

interface IPassTarget {
  readonly texture: unknown;
  readonly width: number;
  readonly height: number;
  /** The pass's colour attachments, in layout order; an offscreen engine target keeps its own list. */
  readonly textures?: readonly IPassAttachment[];
  /** The frame's MSAA sample count, as the engine draws it. */
  readonly samples?: number;
  setSize(width: number, height: number): void;
  dispose(): void;
}

/**
 * One colour attachment of the frame pass, as a game reads it (three's Texture): its name, format, type
 * and colour space. The engine owns the GPU texture, so this descriptor names the target the engine
 * draws and the renderer reads back; it is not a sampled texture handle.
 */
export interface IPassAttachment {
  name: string;
  format: number;
  type: number;
  colorSpace: string;
}

/**
 * The frame pass's render target: three's RenderTarget surface over the colour attachments the engine
 * draws. `textures` is the MRT layout (its own colour first), `width`/`height` the size the engine draws
 * at, and `samples` the frame's MSAA count; `dispose` dispatches three's event.
 */
export interface IFrameTarget {
  readonly texture: IPassAttachment;
  readonly textures: readonly IPassAttachment[];
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  setSize(width: number, height: number): void;
  dispose(): void;
  addEventListener(type: string, listener: unknown): void;
  removeEventListener(type: string, listener: unknown): void;
  dispatchEvent(event: { type: string }): void;
}

/** What an offscreen pass needs of a back end: its RenderTarget, and the surface before a first frame. */
export interface IPassHost {
  // quality-allow: three's class name, so a back end passes its class map.
  // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
  RenderTarget: new (
    width: number,
    height: number,
    options: { type: number },
  ) => IPassTarget;
  surface?(): ISurface;
  /** The frame's MSAA sample count: the renderer's, which the game may not have made yet. */
  samples?(): number;
}

const RGBA_FORMAT = 1023; // three's RGBAFormat
const NO_COLOR_SPACE = ""; // three's NoColorSpace

/** The colour attachment names of a frame pass, for the renderer's readback by attachment index. */
const ATTACHMENT_NAMES = Symbol.for("threenative.passAttachmentNames");

/** The name of a frame pass's colour attachment `index`, or undefined for any other target. */
export function frameAttachmentName(target: unknown, index: number): string | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  return (target as { [ATTACHMENT_NAMES]?: readonly string[] })[ATTACHMENT_NAMES]?.[index];
}

/**
 * The frame pass's colour attachments: three's RenderTarget surface over the targets the engine draws.
 * The engine owns their GPU memory, so a resize and a dispose belong to it; this object answers what a
 * game reads (the layout, the size, the sample count) and dispatches three's `dispose` event.
 */
class FrameTarget implements IFrameTarget {
  readonly texture: IPassAttachment = {
    name: "output",
    format: RGBA_FORMAT,
    type: HALF_FLOAT_TYPE,
    colorSpace: NO_COLOR_SPACE,
  };
  #attachments: IPassAttachment[] = [this.texture];
  readonly #events = new Map<string, Set<unknown>>();
  readonly #host: IPassHost | undefined;

  constructor(host: IPassHost | undefined) {
    this.#host = host;
  }

  get textures(): readonly IPassAttachment[] {
    return this.#attachments;
  }
  get width(): number {
    return this.#host?.surface?.()?.width ?? 1;
  }
  get height(): number {
    return this.#host?.surface?.()?.height ?? 1;
  }
  get samples(): number {
    return this.#host?.samples?.() ?? 1;
  }
  // The readback names an attachment by its index in `textures`; a facade has no `indexOf` identity to publish.
  get [ATTACHMENT_NAMES](): readonly string[] {
    return this.#attachments.map((attachment) => attachment.name);
  }

  /** three's RenderTarget.setSize: the engine resizes its own pass, so the layout size follows it. */
  setSize(_width: number, _height: number): void {}

  /** three's MRT layout: the pass's output first, then each further named target, in author order. */
  setLayout(names: readonly string[]): void {
    const kept = new Map(this.#attachments.map((attachment) => [attachment.name, attachment]));
    this.#attachments = names.map((name) => kept.get(name) ?? attachment(name));
  }

  /** three's PassNode.getTexture: a name the pass did not hold becomes a further colour attachment. */
  named(name: string): IPassAttachment {
    let found = this.#attachments.find((attachment) => attachment.name === name);
    if (found === undefined) {
      found = attachment(name);
      this.#attachments.push(found);
    }
    return found;
  }

  addEventListener(type: string, listener: unknown): void {
    const listeners = this.#events.get(type) ?? new Set<unknown>();
    listeners.add(listener);
    this.#events.set(type, listeners);
  }
  removeEventListener(type: string, listener: unknown): void {
    this.#events.get(type)?.delete(listener);
  }
  dispatchEvent(event: { type: string }): void {
    for (const listener of this.#events.get(event.type) ?? []) {
      if (typeof listener === "function") (listener as (event: unknown) => void)(event);
      else (listener as { handleEvent(event: unknown): void }).handleEvent(event);
    }
  }

  dispose(): void {
    this.dispatchEvent({ type: "dispose" });
  }
}

function attachment(name: string): IPassAttachment {
  return { name, format: RGBA_FORMAT, type: HALF_FLOAT_TYPE, colorSpace: NO_COLOR_SPACE };
}

/** Draws `scene` through `camera` into `target`, at the call. */
export type PassDraw = (target: IPassTarget, scene: unknown, camera: unknown) => void;

interface IPassTsl {
  texture(source: unknown, uv: unknown): unknown;
  uv(): unknown;
  readonly normalView: unknown;
  /** three's diffuseColor node, when the engine's TSL table has one. */
  readonly diffuseColor?: unknown;
  /** The TSL constructors the surface decode composes; a table that lacks them refuses by name. */
  readonly floor?: (value: unknown) => unknown;
  readonly vec4?: (...values: unknown[]) => unknown;
  readonly cameraNear?: IPassMath;
  readonly cameraFar?: IPassMath;
  /** The engine's mrt(names, ...nodes): a material mrtNode of named outputs. */
  readonly mrt?: (names: string, ...nodes: unknown[]) => object;
}

/** The node arithmetic getViewZNode composes. */
interface IPassMath {
  readonly x: IPassMath;
  sub(value: unknown): IPassMath;
  mul(value: unknown): IPassMath;
  div(value: unknown): IPassMath;
}

interface IMRTSlot {
  readonly isMRTSlot: true;
  readonly name: string;
}

/**
 * The slot names the engine's scene pass already owns: its colour, depth, velocity and surface targets.
 * A custom slot keeps its own name and cannot take one of these, because the pass answers that name
 * with its own target (getTextureNode).
 */
const RESERVED_SLOTS: ReadonlySet<string> = new Set([
  "output",
  "depth",
  "velocity",
  "normal",
  "metalness",
  "roughness",
  "diffuseColor",
  "emissive",
]);

/** The pass's own `normalView` spelling of its normal target, which the scene pass draws itself. */
const passNormals = new WeakSet<object>();

/**
 * Whether a material's `mrtNode` writes this output. The engine's scene pass draws its own colour, depth, velocity,
 * normal and surface targets every frame, so the pass's own spellings of them (a slot marker, `normal: normalView`)
 * stay with the pass. Any other node, under any name, is the material's: a render target's texture of that name
 * takes it (an impostor bake writes `output` and `normal`, PRD-858).
 */
export function isCustomMrtOutput(name: string, value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ((value as { isMRTSlot?: boolean }).isMRTSlot === true) return false;
  return !(name === "normal" && (passNormals.has(value) || "__tnNormalView" in value));
}

/** WebGPU's guaranteed colour-attachment count, and what a device's limit reports here when it answers. */
function maxColorAttachments(): number {
  const limit = (
    globalThis as {
      navigator?: { gpu?: { limits?: { maxColorAttachments?: unknown } } };
    }
  ).navigator?.gpu?.limits?.maxColorAttachments;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : 8;
}

interface IMRTNode {
  readonly isMRTNode: true;
  /** Set on the material form, whose output nodes are a RenderTarget's attachments; the scene pass keeps its slots. */
  readonly isMaterialMrt?: true;
  /** three's MRTNode.outputNodes: the node each named output writes. */
  readonly outputNodes: Readonly<Record<string, unknown>>;
  /** The same record under the facade's earlier name, which the Wasm backend's setter reads. */
  readonly outputs: Readonly<Record<string, unknown>>;
  /**
   * three's per-output blend state. The engine's scene pass keeps the material's own blending on
   * every target, so a mode is recorded for `getBlendMode` and not applied to the target.
   */
  readonly blendModes: Record<string, unknown>;
  setBlendMode(name: string, blend: unknown): IMRTNode;
  getBlendMode(name: string): unknown;
  /** three's MRTNode.has: the render chain asks before it provisions an output. */
  has(name: string): boolean;
}

/**
 * three's templates write the normal target as `vec4(normalView, 0)`: the zero alpha, with a
 * `BlendMode(MaterialBlending)` on the output, keeps the opaque normal under a transparent card. The
 * engine's normal target holds the view normal itself, so that spelling names the same target.
 * `vec4` is the back end's own constructor; its result for `(normalView, 0)` carries the marker
 * `mrt()` reads, every other call is untouched.
 */
export function markNormalTarget<T extends (...args: never[]) => object>(
  vec4: T,
  normalView: unknown,
): T {
  return ((...args: unknown[]) => {
    // quality-allow: the back end's vec4 is called with its untyped argument list, as three's own TSL does.
    const node = (vec4 as unknown as (...a: unknown[]) => object)(...args);
    if (args.length === 2 && args[0] === normalView && args[1] === 0)
      Object.defineProperty(node, "__tnNormalView", { value: normalView });
    return node;
    // quality-allow: the wrapper is returned as the same call signature T it wraps.
  }) as unknown as T;
}

/**
 * `onTarget(scene, camera)` hears where a pass points (the V8 player draws that scene); a back end that
 * draws the renderer's last scene passes none.
 */
export function definePass(
  tsl: IPassTsl,
  onTarget?: (scene: unknown, camera: unknown) => void,
  host?: IPassHost,
) {
  const slot = (name: string): IMRTSlot => Object.freeze({ isMRTSlot: true, name });
  const output = slot("output");
  const normalView = tsl.normalView;
  if (normalView !== null && typeof normalView === "object") passNormals.add(normalView);
  const metalness = slot("metalness");
  const roughness = slot("roughness");
  // three's diffuseColor is a node a material reads (`diffuseColor.a`) and the pass's slot in mrt(); the engine's node
  // carries the slot marker, so both spellings hold.
  const engineDiffuse = tsl.diffuseColor;
  const diffuseColor: IMRTSlot =
    engineDiffuse !== null && typeof engineDiffuse === "object"
      ? (Object.defineProperties(engineDiffuse, {
          isMRTSlot: { value: true },
          name: { value: "diffuseColor" },
        }) as IMRTSlot)
      : slot("diffuseColor");
  const emissive = slot("emissive");

  /** A scene pass output: one of the slots, or `normal` as normalView (or vec4(normalView, 0)). */
  const passOutput = (name: string, value: unknown): boolean =>
    (value as IMRTSlot | null)?.isMRTSlot === true ||
    (name === "normal" &&
      (value === normalView ||
        (value as { __tnNormalView?: unknown } | null)?.__tnNormalView === normalView));

  /**
   * Outputs that are TSL nodes (not the scene pass's slots): a material's mrtNode, written into a RenderTarget made
   * with `count`, each output to the texture of its name. `output` keeps the material's own colour there. The scene
   * pass draws its own targets every frame, so a record carries them beside the material's nodes (three's templates
   * spell `normal` as normalView there) and the material writes only the nodes: `mrtNode` skips the reserved names.
   */
  function materialMrt(
    outputs: Record<string, unknown>,
    nodes: [string, unknown][],
    engineMrt: NonNullable<IPassTsl["mrt"]>,
  ): IMRTNode {
    // A pass slot object beside material nodes is a wiring error: only the pass draws that target. The normal target
    // as normalView is not a slot object, so it stays the spelling a material's mrt() carries.
    for (const [name, value] of Object.entries(outputs))
      if (value !== output && (value as IMRTSlot | null)?.isMRTSlot === true)
        throw new Error(
          `TN_NATIVE_MRT_UNSUPPORTED: ${name} mixes a scene pass slot with material outputs`,
        );
    if (nodes.some(([name]) => name.includes(",")))
      throw new Error("TN_NATIVE_MRT_UNSUPPORTED: an mrt() output name holds a comma");
    const node = engineMrt(
      nodes.map(([name]) => name).join(","),
      ...nodes.map(([, value]) => value),
    );
    const blendModes: Record<string, unknown> = {};
    // Defined, not assigned: a node may be a proxy whose set trap means `uniform.value = x`.
    return Object.defineProperties(node, {
      isMRTNode: { value: true },
      // A material's mrt(): its output nodes go to a RenderTarget's textures, never to the scene pass's targets.
      isMaterialMrt: { value: true },
      outputs: { value: Object.freeze({ ...outputs }) },
      // The material's blending writes every attachment, as three's does when the renderer has no MRT.
      blendModes: { value: blendModes },
      setBlendMode: {
        value: (name: string, blend: unknown): IMRTNode => {
          blendModes[name] = blend;
          return node as IMRTNode;
        },
      },
      getBlendMode: { value: (name: string): unknown => blendModes[name] },
      has: { value: (name: string): boolean => name in outputs },
    }) as IMRTNode;
  }

  function mrt(outputs: Record<string, unknown>): IMRTNode {
    const entries = Object.entries(outputs);
    const limit = maxColorAttachments();
    if (entries.length > limit)
      throw new Error(
        `TN_NATIVE_MRT_UNSUPPORTED: ${entries.length} colour attachments exceed the device limit ${limit}`,
      );
    const named: Record<string, unknown> = {};
    const nodes = Object.entries(outputs).filter(([name, value]) => !passOutput(name, value));
    if (nodes.length > 0 && tsl.mrt !== undefined) return materialMrt(outputs, nodes, tsl.mrt);
    for (const [name, value] of entries) {
      const normal =
        name === "normal" &&
        (value === normalView ||
          (value as { __tnNormalView?: unknown } | null)?.__tnNormalView === normalView);
      if (normal) {
        named[name] = normalView;
        continue;
      }
      const engineSlot = value as IMRTSlot | null;
      // A name the engine's pass owns keeps its exact spelling: its own slot, or the refusal it always gave.
      if (RESERVED_SLOTS.has(name)) {
        if (engineSlot?.isMRTSlot === true && engineSlot.name === name) {
          named[name] = value;
          continue;
        }
        throw new Error(
          `TN_NATIVE_MRT_UNSUPPORTED: ${name} must be one of output, normal: normalView or vec4(normalView, 0), metalness, roughness, diffuseColor, emissive`,
        );
      }
      // An engine target under a custom name is a wiring error, not a node.
      if (
        engineSlot?.isMRTSlot === true ||
        (value !== null && typeof value === "object" && "isMRTSlot" in value)
      )
        throw new Error(
          `TN_NATIVE_MRT_UNSUPPORTED: ${name} must be one of output, normal: normalView or vec4(normalView, 0), metalness, roughness, diffuseColor, emissive`,
        );
      // Any other name is a custom colour attachment: three's mrt() takes any node there.
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error(
          `TN_NATIVE_MRT_UNSUPPORTED: the '${name}' slot must be a shader node, got ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}`,
        );
      named[name] = value;
    }
    const frozen = Object.freeze(named);
    const node: IMRTNode = Object.freeze({
      isMRTNode: true as const,
      outputNodes: frozen,
      outputs: frozen,
      blendModes: {} as Record<string, unknown>,
      setBlendMode(name: string, blend: unknown): IMRTNode {
        node.blendModes[name] = blend;
        return node;
      },
      getBlendMode: (name: string): unknown => node.blendModes[name],
      has: (name: string): boolean => name in named,
    });
    return node;
  }

  const slots: Record<string, IMRTSlot> = { metalness, roughness, diffuseColor };

  /**
   * The engine's normal target carries the surface in its alpha (Renderer::planNormals):
   * `2 * round(7 * metalness) + 0.25 + 0.5 * roughness`, 0 where no material wrote. Each name reads as a
   * splat of its own value, as three splats a float MRT output to RGBA (and as the separate material
   * target does). A pixel with no material reads as metalness 0 and roughness 1: it reflects nothing.
   */
  function surfaceNode(name: string): unknown {
    const { floor, vec4 } = tsl;
    if (floor === undefined || vec4 === undefined)
      throw new Error(
        "TN_NATIVE_PASS_TEXTURE_UNSUPPORTED: this TSL table has no floor and vec4 to unpack the surface",
      );
    // quality-allow: the engine's untyped TSL node surface (chained operator calls).
    // biome-ignore lint/suspicious/noExplicitAny: the engine's TSL node surface is open-ended chained calls.
    const alpha = (tsl.texture({ name: "normal" }, tsl.uv()) as any).a;
    const level = floor(alpha.mul(0.5)) as typeof alpha;
    const written = alpha.greaterThan(0.125);
    const roughness = alpha.sub(level.mul(2)).sub(0.25).mul(2).clamp(0, 1);
    const value =
      name === "metalness" ? written.select(level.div(7), 0) : written.select(roughness, 1);
    return vec4(value, value, value, value);
  }

  const framePass = Symbol("tn.framePass");
  const drawPass = Symbol("tn.drawPass");
  interface IOffscreen {
    [drawPass](surface: ISurface, draw: PassDraw): void;
  }
  /** A pass the engine's frame draws: its updateBefore is the frame's hook. */
  interface IPassFrame {
    updateBefore(frame: unknown): unknown;
  }
  const offscreen = new Set<IOffscreen>();
  const frameNodes = new Set<IPassFrame>();
  let lastSurface: ISurface | undefined;

  class PassNode implements IOffscreen, IPassFrame {
    static readonly COLOR = "color";
    static readonly DEPTH = "depth";
    readonly isPassNode = true;
    #mrt: IMRTNode | null = null;
    #scene: unknown;
    #camera: unknown;
    #scale = 1;
    #target: IPassTarget | null = null;
    #frameTarget: FrameTarget | null = null;
    #offscreen: boolean;
    #disposed = false;
    #viewZ = new Map<string, unknown>();

    constructor(scope: unknown, scene: unknown, camera: unknown) {
      this.#scene = scene;
      this.#camera = camera;
      this.#offscreen = scope !== framePass;
      if (!this.#offscreen) {
        onTarget?.(scene, camera);
        frameNodes.add(this);
        return;
      }
      if (scope !== PassNode.COLOR)
        throw new Error(
          `TN_NATIVE_PASS_SCOPE_UNSUPPORTED: an offscreen PassNode draws colour only, not '${String(scope)}'`,
        );
      if (host === undefined)
        throw new Error("TN_NATIVE_PASS_HOST: this back end has no RenderTarget for a PassNode");
      this.#target = new host.RenderTarget(1, 1, { type: HALF_FLOAT_TYPE });
      this.#resize(lastSurface ?? host.surface?.());
      offscreen.add(this);
    }

    get scene(): unknown {
      return this.#scene;
    }
    set scene(value: unknown) {
      this.#scene = value;
      if (!this.#offscreen) onTarget?.(value, this.#camera);
    }
    get camera(): unknown {
      return this.#camera;
    }
    set camera(value: unknown) {
      this.#camera = value;
      if (!this.#offscreen) onTarget?.(this.#scene, value);
    }

    /**
     * The pass's target: an offscreen pass's own RenderTarget, or the frame pass's colour attachments.
     * The frame pass draws into the engine's frame, so this answers its layout, size and sample count.
     */
    get renderTarget(): IPassTarget | IFrameTarget | undefined {
      if (this.#offscreen) return this.#target ?? undefined;
      this.#frameTarget ??= new FrameTarget(host);
      return this.#frameTarget;
    }

    /**
     * The texture of one of the pass's colour attachments, as three's PassNode.getTexture(name) answers it.
     * A name the MRT does not write becomes a further attachment descriptor, as three pushes one.
     */
    getTexture(name = "output"): IPassAttachment {
      if (this.#offscreen)
        throw new Error(
          "TN_NATIVE_PASS_TEXTURE_UNSUPPORTED: an offscreen PassNode's colour is a node (getTextureNode()) with no JS texture",
        );
      if (name === "depth")
        throw new Error(
          "TN_NATIVE_PASS_TEXTURE_UNSUPPORTED: the frame pass's depth is a node (getTextureNode('depth')), not a JS texture",
        );
      const target = this.renderTarget as FrameTarget;
      return name === "output" ? target.texture : target.named(name);
    }

    /**
     * three's PassNode.updateBefore: the pass's frame. The engine draws the frame pass itself, so this
     * body is the safe point a game wraps to run code at the pass's frame (the water proof reads back
     * the attachment the pass last drew). An offscreen pass draws in updateSecondaryPasses.
     */
    updateBefore(_frame: unknown): unknown {
      return undefined;
    }

    setResolutionScale(scale: number): this {
      if (!this.#offscreen)
        throw new Error(
          "TN_NATIVE_PASS_RESOLUTION_UNSUPPORTED: the frame pass draws at the surface size; only an offscreen PassNode scales",
        );
      if (!Number.isFinite(scale) || scale <= 0)
        throw new Error(`TN_NATIVE_PASS_RESOLUTION_SCALE: expected a number above 0, got ${scale}`);
      this.#scale = scale;
      this.#resize(lastSurface ?? host?.surface?.());
      return this;
    }

    getResolutionScale(): number {
      return this.#scale;
    }

    #resize(surface: ISurface | undefined): void {
      const target = this.#target;
      if (target === null || surface === undefined) return;
      const width = Math.max(1, Math.floor(surface.width * this.#scale));
      const height = Math.max(1, Math.floor(surface.height * this.#scale));
      if (width !== target.width || height !== target.height) target.setSize(width, height);
    }

    [drawPass](surface: ISurface, draw: PassDraw): void {
      if (this.#target === null) return;
      this.#resize(surface);
      draw(this.#target, this.#scene, this.#camera);
    }

    setMRT(value: IMRTNode | null): this {
      if (value !== null && value?.isMRTNode !== true)
        throw new Error("TN_NATIVE_MRT_UNSUPPORTED: setMRT takes mrt()");
      // The material form's output nodes are written into a RenderTarget by the material itself, so a scene pass
      // cannot lay them out: three's setMRT takes the pass's own slots plus the custom colour attachments.
      if (value !== null && value.isMaterialMrt === true)
        throw new Error(
          "TN_NATIVE_MRT_UNSUPPORTED: a material's mrt() writes node outputs; set it on material.mrtNode",
        );
      if (value !== null && this.#offscreen)
        throw new Error("TN_NATIVE_MRT_UNSUPPORTED: an offscreen PassNode draws colour only");
      this.#mrt = value;
      // The pass holds one colour attachment per output the MRT names, its own colour first (three's
      // PassNode pushes a texture per MRT output; the engine draws that same layout).
      const names = value === null ? [] : Object.keys(value.outputNodes);
      this.#frameTarget ??= new FrameTarget(host);
      this.#frameTarget.setLayout(["output", ...names.filter((name) => name !== "output")]);
      return this;
    }

    getMRT(): IMRTNode | null {
      return this.#mrt;
    }

    getTextureNode(name = "output"): unknown {
      if (this.#offscreen) {
        if (this.#target === null)
          throw new Error("TN_NATIVE_PASS_DISPOSED: getTextureNode() after dispose()");
        if (name !== "output")
          throw new Error(
            `TN_NATIVE_PASS_TEXTURE_UNSUPPORTED: an offscreen PassNode has no '${name}' target`,
          );
        return tsl.texture(this.#target.texture, tsl.uv());
      }
      if (name === "output") return tsl.texture({ name: "scene" }, tsl.uv());
      if (name === "depth") return tsl.texture({ name: "depth" }, tsl.uv());
      // The temporal pass's velocity target (the NDC difference between two frames, the camera's own motion where no
      // rigid draw wrote one). The engine draws it while a traa() effect is in the graph, no MRT asks for it.
      if (name === "velocity") return tsl.texture({ name: "velocity" }, tsl.uv());
      if (name === "normal" && this.#mrt?.outputs.normal === normalView)
        return tsl.texture({ name: "normal" }, tsl.uv());
      // The renderer's albedo pass: each opaque lit draw's diffuse colour in rgb, alpha 1 where it wrote one.
      if (name === "diffuseColor" && this.#mrt?.outputs.diffuseColor === diffuseColor)
        return tsl.texture({ name: "albedo" }, tsl.uv());
      if (name === "emissive" && this.#mrt?.outputs.emissive === emissive)
        return tsl.texture({ name: "emissive" }, tsl.uv());
      // The draws that composited over the frame, lit as they were drawn. The engine draws them while the post graph
      // reads this name (Renderer::planAux), so the read is the request and no MRT output names it: the occlusion and
      // the gather belong to the opaque surface, and the composite restores what a translucent sheet drew over it.
      if (name === "translucent") return tsl.texture({ name: "translucent" }, tsl.uv());
      // Each lit draw's indirect diffuse light (hemisphere, ambient, environment, irradiance node; no direct light),
      // drawn while the post graph reads the name (Renderer::planAux), so an occlusion can darken that share alone.
      if (name === "indirectDiffuse") return tsl.texture({ name: "indirectDiffuse" }, tsl.uv());
      if (
        (name === "metalness" || name === "roughness") &&
        this.#mrt?.outputs.normal === normalView &&
        this.#mrt?.outputs[name] === slots[name]
      )
        return surfaceNode(name);
      if (
        (name === "metalness" && this.#mrt?.outputs.metalness === metalness) ||
        (name === "roughness" && this.#mrt?.outputs.roughness === roughness)
      )
        return tsl.texture({ name }, tsl.uv());
      // A custom slot the MRT names is a further colour target the engine draws (pass-node.ts).
      if (this.#mrt !== null && Object.hasOwn(this.#mrt.outputs, name))
        return tsl.texture({ name }, tsl.uv());
      throw new Error(
        `TN_NATIVE_PASS_TEXTURE_UNSUPPORTED: the native scene pass has no '${name}' target`,
      );
    }

    /** three's `perspectiveDepthToViewZ(depth, cameraNear, cameraFar)` of a depth target, once per name. */
    getViewZNode(name = "depth"): unknown {
      let viewZ = this.#viewZ.get(name);
      if (viewZ === undefined) {
        const depth = (this.getTextureNode(name) as IPassMath).x;
        const { cameraNear: near, cameraFar: far } = tsl;
        if (near === undefined || far === undefined)
          throw new Error(
            "TN_NATIVE_PASS_TEXTURE_UNSUPPORTED: this TSL table has no cameraNear and cameraFar",
          );
        viewZ = near.mul(far).div(far.sub(near).mul(depth).sub(far));
        this.#viewZ.set(name, viewZ);
      }
      return viewZ;
    }

    /** Releases an offscreen pass's target and stops drawing it. The frame pass owns nothing to release. */
    dispose(): void {
      if (this.#disposed) return;
      this.#disposed = true;
      offscreen.delete(this);
      this.#target?.dispose();
      this.#target = null;
      frameNodes.delete(this);
      this.#frameTarget?.dispose();
      this.#frameTarget = null;
    }
  }

  const pass = (scene: unknown, camera: unknown): PassNode =>
    new PassNode(framePass, scene, camera);

  /**
   * Runs every live frame pass's `updateBefore` at each render, as three's node update system does.
   * The engine draws the frame pass itself, so a game's wrapper runs at the pass's frame point; a
   * wrapper that must run once a frame (the water proof's copy) guards that itself, as three's
   * PassNode does not count frames for it either.
   */
  function updateFramePasses(frame?: { frameId?: number }): void {
    if (frameNodes.size === 0) return;
    for (const node of [...frameNodes]) node.updateBefore(frame);
  }

  /**
   * Draws every live offscreen pass into its target, at the surface size, before the frame that
   * samples them. A back end calls it once per frame with its drawing buffer and its target draw;
   * with no offscreen pass it reads neither.
   */
  function updateSecondaryPasses(surface: () => ISurface, draw: PassDraw): void {
    if (offscreen.size === 0) return;
    const { width, height } = surface();
    if (!(width >= 1 && height >= 1))
      throw new Error(
        `TN_NATIVE_PASS_SURFACE: the surface is ${width}x${height}; an offscreen PassNode needs a real size`,
      );
    lastSurface = { width, height };
    for (const entry of [...offscreen]) entry[drawPass](lastSurface, draw);
  }

  return {
    pass,
    PassNode,
    updateSecondaryPasses,
    updateFramePasses,
    mrt,
    output,
    normalView,
    metalness,
    roughness,
    diffuseColor,
    emissive,
  };
}
