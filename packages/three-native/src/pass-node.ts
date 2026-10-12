/**
 * three's `pass(scene, camera)`, `mrt()` and the MRT slots over the engine's own scene pass, for both
 * back ends (the V8 player and the Wasm engine). The engine draws one scene pass whose targets are
 * the renderer's colour ("output"), depth and, with an MRT that asks for it, view normals; a pass's
 * texture nodes name those targets. `normalView` is the engine's TSL node, as in three, so a graph
 * reads it and `mrt({ normal: normalView })` names the normal target by that node's identity.
 */

interface IPassTsl {
  texture(target: { readonly name: string }, uv: unknown): unknown;
  uv(): unknown;
  readonly normalView: unknown;
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
    const node = (vec4 as unknown as (...a: unknown[]) => object)(...args);
    if (args.length === 2 && args[0] === normalView && args[1] === 0)
      Object.defineProperty(node, "__tnNormalView", { value: normalView });
    return node;
  }) as unknown as T;
}

/**
 * `onTarget(scene, camera)` hears where a pass points (the V8 player draws that scene); a back end that
 * draws the renderer's last scene passes none.
 */
export function definePass(tsl: IPassTsl, onTarget?: (scene: unknown, camera: unknown) => void) {
  const slot = (name: string): IMRTSlot => Object.freeze({ isMRTSlot: true, name });
  const output = slot("output");
  const normalView = tsl.normalView;
  const metalness = slot("metalness");
  const roughness = slot("roughness");

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
          `TN_NATIVE_MRT_UNSUPPORTED: ${name} must be one of output, normal: normalView or vec4(normalView, 0), metalness, roughness`,
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

  class PassNode {
    readonly isPassNode = true;
    #mrt: IMRTNode | null = null;
    #scene: unknown;
    #camera: unknown;

    constructor(scene: unknown, camera: unknown) {
      this.#scene = scene;
      this.#camera = camera;
      onTarget?.(scene, camera);
    }

    get scene(): unknown {
      return this.#scene;
    }
    set scene(value: unknown) {
      this.#scene = value;
      onTarget?.(value, this.#camera);
    }
    get camera(): unknown {
      return this.#camera;
    }
    set camera(value: unknown) {
      this.#camera = value;
      onTarget?.(this.#scene, value);
    }

    setMRT(value: IMRTNode | null): this {
      if (value !== null && value?.isMRTNode !== true)
        throw new Error("TN_NATIVE_MRT_UNSUPPORTED: setMRT takes mrt()");
      this.#mrt = value;
      return this;
    }

    getMRT(): IMRTNode | null {
      return this.#mrt;
    }

    getTextureNode(name = "output"): unknown {
      if (name === "output") return tsl.texture({ name: "scene" }, tsl.uv());
      if (name === "depth") return tsl.texture({ name: "depth" }, tsl.uv());
      if (name === "normal" && this.#mrt?.outputs.normal === normalView)
        return tsl.texture({ name: "normal" }, tsl.uv());
      throw new Error(
        `TN_NATIVE_PASS_TEXTURE_UNSUPPORTED: the native scene pass has no '${name}' target`,
      );
    }

    dispose(): void {}
  }

  const pass = (scene: unknown, camera: unknown): PassNode => new PassNode(scene, camera);
  return { pass, mrt, output, normalView, metalness, roughness };
}
