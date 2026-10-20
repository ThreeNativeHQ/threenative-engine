/**
 * three's `pass(scene, camera)`, `mrt()` and the MRT slots over the engine's own scene pass, for both
 * back ends (the V8 player and the Wasm engine). The engine draws one scene pass whose targets are
 * the renderer's colour ("output"), depth and, with an MRT that asks for it, view normals and the diffuse colour; a pass's
 * texture nodes name those targets. `normalView` is the engine's TSL node, as in three, so a graph
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
  setSize(width: number, height: number): void;
  dispose(): void;
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
}

/** Draws `scene` through `camera` into `target`, at the call. */
export type PassDraw = (target: IPassTarget, scene: unknown, camera: unknown) => void;

interface IPassTsl {
  texture(source: unknown, uv: unknown): unknown;
  uv(): unknown;
  readonly normalView: unknown;
  /** The TSL constructors the surface decode composes; a table that lacks them refuses by name. */
  readonly floor?: (value: unknown) => unknown;
  readonly vec4?: (...values: unknown[]) => unknown;
}

interface IMRTSlot {
  readonly isMRTSlot: true;
  readonly name: string;
}

interface IMRTNode {
  readonly isMRTNode: true;
  readonly outputs: Readonly<Record<string, unknown>>;
  /**
   * three's per-output blend state. The engine's scene pass keeps the material's own blending on
   * every target, so a mode is recorded for `getBlendMode` and not applied to the target.
   */
  readonly blendModes: Record<string, unknown>;
  setBlendMode(name: string, blend: unknown): IMRTNode;
  getBlendMode(name: string): unknown;
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
  const metalness = slot("metalness");
  const roughness = slot("roughness");
  const diffuseColor = slot("diffuseColor");

  function mrt(outputs: Record<string, unknown>): IMRTNode {
    const named: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(outputs)) {
      const normal =
        name === "normal" &&
        (value === normalView ||
          (value as { __tnNormalView?: unknown } | null)?.__tnNormalView === normalView);
      if (
        !normal &&
        ((value as IMRTSlot | null)?.isMRTSlot !== true || name !== (value as IMRTSlot).name)
      )
        throw new Error(
          `TN_NATIVE_MRT_UNSUPPORTED: ${name} must be one of output, normal: normalView or vec4(normalView, 0), metalness, roughness, diffuseColor`,
        );
      named[name] = normal ? normalView : value;
    }
    const node: IMRTNode = Object.freeze({
      isMRTNode: true as const,
      outputs: Object.freeze(named),
      blendModes: {} as Record<string, unknown>,
      setBlendMode(name: string, blend: unknown): IMRTNode {
        node.blendModes[name] = blend;
        return node;
      },
      getBlendMode: (name: string): unknown => node.blendModes[name],
    });
    return node;
  }

  const slots: Record<string, IMRTSlot> = { metalness, roughness, diffuseColor };

  /**
   * The engine's normal target carries the surface in its alpha (Renderer::planNormals):
   * `2 * round(7 * metalness) + 0.25 + 0.5 * roughness`, 0 where no material wrote. One texel reads as
   * `vec4(metalness, roughness, 0, 1)`: a game samples `.r` for the metalness target and `.g` for the
   * roughness target. A pixel with no material reads as metalness 0 and roughness 1: it reflects nothing.
   */
  function surfaceNode(): unknown {
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
    return vec4(written.select(level.div(7), 0), written.select(roughness, 1), 0, 1);
  }

  const framePass = Symbol("tn.framePass");
  const drawPass = Symbol("tn.drawPass");
  interface IOffscreen {
    [drawPass](surface: ISurface, draw: PassDraw): void;
  }
  const offscreen = new Set<IOffscreen>();
  let lastSurface: ISurface | undefined;

  class PassNode implements IOffscreen {
    static readonly COLOR = "color";
    static readonly DEPTH = "depth";
    readonly isPassNode = true;
    #mrt: IMRTNode | null = null;
    #scene: unknown;
    #camera: unknown;
    #scale = 1;
    #target: IPassTarget | null = null;
    #offscreen: boolean;
    #disposed = false;

    constructor(scope: unknown, scene: unknown, camera: unknown) {
      this.#scene = scene;
      this.#camera = camera;
      this.#offscreen = scope !== framePass;
      if (!this.#offscreen) {
        onTarget?.(scene, camera);
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

    /** The offscreen pass's real target, so its width and height are the allocated size. */
    get renderTarget(): IPassTarget | undefined {
      return this.#target ?? undefined;
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
      if (value !== null && this.#offscreen)
        throw new Error("TN_NATIVE_MRT_UNSUPPORTED: an offscreen PassNode draws colour only");
      this.#mrt = value;
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
      if (name === "normal" && this.#mrt?.outputs.normal === normalView)
        return tsl.texture({ name: "normal" }, tsl.uv());
      // The renderer's albedo pass: each opaque lit draw's diffuse colour in rgb, alpha 1 where it wrote one.
      if (name === "diffuseColor" && this.#mrt?.outputs.diffuseColor === diffuseColor)
        return tsl.texture({ name: "albedo" }, tsl.uv());
      if (
        (name === "metalness" || name === "roughness") &&
        this.#mrt?.outputs.normal === normalView &&
        this.#mrt?.outputs[name] === slots[name]
      )
        return surfaceNode();
      throw new Error(
        `TN_NATIVE_PASS_TEXTURE_UNSUPPORTED: the native scene pass has no '${name}' target`,
      );
    }

    /** Releases an offscreen pass's target and stops drawing it. The frame pass owns nothing to release. */
    dispose(): void {
      if (this.#disposed) return;
      this.#disposed = true;
      offscreen.delete(this);
      this.#target?.dispose();
      this.#target = null;
    }
  }

  const pass = (scene: unknown, camera: unknown): PassNode =>
    new PassNode(framePass, scene, camera);

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
    mrt,
    output,
    normalView,
    metalness,
    roughness,
    diffuseColor,
  };
}
