/**
 * TSL on the Wasm engine (PRD-540): three's `three/tsl` authoring functions and node methods as JS
 * wrappers over node ids, built by the engine's one TSL name table (`tn_tsl_call`, shared with the
 * V8 back end). A node is an engine graph node; nothing here builds shader code in JavaScript.
 *
 * The statement forms (Fn, If, Else, Loop, toVar, assign) run the game's callbacks here, between
 * the engine's `scope:open` and `scope:close`, so their statements land in the engine's open body
 * (tn::abi::TslScopes, shared with the V8 back end).
 */
import { type IEngineRef, TSL_NODE, engineRef } from "./browser-backend.js";
import { markNormalTarget } from "./pass-node.js";
import { defineTslExtras } from "./tsl-extras.js";
import { type ConstClasses, liveUniforms, uniformLanes, withConstValues } from "./tsl-uniforms.js";

/** One argument as `tn_tsl_call` takes it. */
export type TslArgValue =
  | { readonly kind: "node"; readonly node: number }
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "string" | "named"; readonly text: string }
  | { readonly kind: "rgb" | "vector"; readonly numbers: readonly number[] }
  | { readonly kind: "other" }
  | { readonly kind: "handle"; readonly ref: IEngineRef };

/** The engine side of TSL: one call by name, node release, and a material's node slot. */
export interface ITslRuntime {
  call(name: string, receiver: number | null, args: readonly TslArgValue[]): number;
  release(node: number): void;
  set(material: IEngineRef, path: string, node: number): void;
  /** three's `uniform.value = x`: the uniform's lanes, with no program change. */
  setUniform(node: number, lanes: readonly number[]): void;
  /** A live post effect's scalar uniform, written first when `value` is given; answers its value. */
  effectParameter(node: number, name: string, value?: number): number;
  /** three's RenderPipeline: the post graph the web host draws between scene and output, or none. */
  setPost(node: number | null): void;
}

/** Module functions the shared table answers (engine/abi/tsl_call.cpp). */
const FUNCTIONS = [
  "float",
  "int",
  "uint",
  "vec2",
  "vec3",
  "vec4",
  "uniform",
  "attribute",
  "uv",
  "texture",
  "texture3D",
  "add",
  "sub",
  "mul",
  "div",
  "negate",
  "lessThan",
  "greaterThan",
  "equal",
  "abs",
  "sin",
  "cos",
  "floor",
  "fract",
  "sqrt",
  "exp",
  "exp2",
  "log2",
  "normalize",
  "length",
  "atan",
  "mod",
  "fwidth",
  "saturation",
  "mat2",
  "hash",
  "min",
  "max",
  "pow",
  "step",
  "dot",
  "distance",
  "cross",
  "mix",
  "clamp",
  "smoothstep",
  "select",
  "nodeObject",
  "color",
  "ivec2",
  "textureLoad",
  "reflect",
  "dFdx",
  "dFdy",
  "lengthSq",
  "viewportSharedTexture",
  "viewportDepthTexture",
  "linearDepth",
  "convertToTexture",
  "varying",
  // The live post effects (lane-531's table entries); post-effects.ts publishes them as three's addons.
  "ao",
  "denoise",
  "smaa",
  "bloom",
  "oneMinus",
  "mx_noise_float",
  "mx_worley_noise_vec2",
  "pmremTexture",
  "reflector",
  "transformDirection",
] as const;
/** The inputs TSL exports as values (tn::abi::tslConstants), each built once, when first read. */
const CONSTANTS = [
  "viewportLinearDepth",
  "cameraPosition",
  "cameraNear",
  "cameraFar",
  "screenSize",
  "depth",
  "cameraProjectionMatrix",
  "cameraWorldMatrix",
  "positionGeometry",
  "normalWorld",
  "positionLocal",
  "positionWorld",
  "normalViewGeometry",
  "cameraViewMatrix",
  "instanceIndex",
  "screenUV",
  "materialColor",
  "materialEmissive",
  "materialMetalness",
  "materialRoughness",
  "time",
  "normalView",
  "positionViewDirection",
  "screenCoordinate",
  "normalGeometry",
  "tangentGeometry",
  "normalWorldGeometry",
] as const;
/** Node methods the shared table answers, with the receiver passed apart. */
const METHODS = [
  "add",
  "sub",
  "mul",
  "div",
  "negate",
  "lessThan",
  "greaterThan",
  "equal",
  "abs",
  "sin",
  "cos",
  "floor",
  "fract",
  "sqrt",
  "exp",
  "exp2",
  "log2",
  "normalize",
  "length",
  "dFdx",
  "dFdy",
  "sign",
  "cbrt",
  "atan",
  "mod",
  "fwidth",
  "min",
  "max",
  "pow",
  "step",
  "dot",
  "distance",
  "cross",
  "reflect",
  "lengthSq",
  "mix",
  "clamp",
  "smoothstep",
  "select",
  "sample",
  "oneMinus",
  "dispose",
  "flipX",
  "flipY",
  "flipZ",
  "flipW",
  "level",
  "transformDirection",
] as const;
/** three's swizzles: every 1-4 lane combination of xyzw, rgba or stpq, as xyzw lanes. */
const SWIZZLES: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const set of ["xyzw", "rgba", "stpq"]) {
    const grow = (alias: string, lanes: string): void => {
      if (alias.length > 0) out[alias] = lanes;
      if (alias.length < 4) for (let i = 0; i < 4; i++) grow(alias + set[i], lanes + "xyzw"[i]);
    };
    grow("", "");
  }
  return out;
})();
interface ITslNode {
  readonly [TSL_NODE]: number;
}

export function isTslNode(value: unknown): value is ITslNode {
  return typeof value === "object" && value !== null && TSL_NODE in value;
}

/**
 * Arguments that cross as the engine object itself: pmremTexture prefilters its texture and texture3D
 * samples it (not a map the material names), and reflector takes its target and virtual camera.
 */
function takesEngineObject(name: string, index: number): boolean {
  return (
    (index === 0 && (name === "pmremTexture" || name === "texture3D")) ||
    (index < 2 && name === "reflector")
  );
}

/**
 * Defines the TSL exports over `runtime`. `sync` pushes edited Color/VectorN uniform values; the
 * renderer calls it before each frame. With `classes`, constants answer r185's ConstNode.value.
 */
export function defineTsl(
  runtime: ITslRuntime,
  classes?: ConstClasses,
): {
  exports: Record<string, unknown>;
  sync(): void;
} {
  const released = new FinalizationRegistry<number>((node) => runtime.release(node));
  const prototype: Record<string, unknown> = {};
  const wrap = (node: number): ITslNode => {
    const object = Object.create(prototype) as ITslNode;
    Object.defineProperty(object, TSL_NODE, { value: node, configurable: true });
    released.register(object, node, object);
    return object;
  };
  const argument = (name: string, index: number, value: unknown): TslArgValue => {
    if (isTslNode(value)) return { kind: "node", node: value[TSL_NODE] };
    // An omitted optional input (denoise's normal node) has no TSL meaning of its own, and ao's and
    // denoise's camera is the render camera, whose matrices the engine's effect reads each frame.
    if (value === null || value === undefined) return { kind: "other" };
    if ((name === "ao" && index === 2) || (name === "denoise" && index === 3))
      return { kind: "other" };
    if (typeof value === "number") return { kind: "number", number: value };
    if (typeof value === "string") return { kind: "string", text: value };
    // texture(engineTexture, uv) samples that texture itself; a plain object names a material map,
    // and textureLoad also takes a texture node.
    if (
      index === 0 &&
      name === "texture" &&
      typeof value === "object" &&
      engineRef(value) !== undefined
    )
      return { kind: "handle", ref: engineRef(value) as IEngineRef };
    if (index === 0 && (name === "texture" || name === "textureLoad") && typeof value === "object")
      return { kind: "named", text: String((value as { name?: unknown } | null)?.name ?? "") };
    // A three value is the engine's (`mesh.position`) or JS's own (`new Vector3()`).
    if (typeof value === "object" && value !== null) {
      const object = value as Record<string, unknown>;
      if (takesEngineObject(name, index) && engineRef(value) !== undefined)
        return { kind: "handle", ref: engineRef(value) as IEngineRef };
      // TSL's nodeObject turns a three Color or VectorN into its constant: vec3(new Vector3(1, 2, 3)).
      if (object.isColor === true) return { kind: "rgb", numbers: uniformLanes(object) };
      if (object.isVector2 === true || object.isVector3 === true || object.isVector4 === true)
        return { kind: "vector", numbers: uniformLanes(object) };
    }
    throw new TypeError(
      `TN_TSL ${name}: argument ${index} is not a TSL node, number, string or three value`,
    );
  };
  const call = (name: string, receiver: number | null, args: readonly unknown[]): number =>
    runtime.call(
      name,
      receiver,
      args.map((value, index) => argument(name, index, value)),
    );

  for (const name of METHODS)
    prototype[name] = function (this: ITslNode, ...args: unknown[]) {
      return wrap(call(name, this[TSL_NODE], args));
    };
  for (const [alias, lanes] of Object.entries(SWIZZLES))
    Object.defineProperty(prototype, alias, {
      get(this: ITslNode) {
        return wrap(call(`swizzle:${lanes}`, this[TSL_NODE], []));
      },
    });
  // The statement forms: a callback runs between scope:open and scope:close, which closes even when
  // the callback throws; its statements land in the engine's open body.
  let depth = 0;
  const node = (id: number): TslArgValue => ({ kind: "node", node: id });
  const capture = (form: string, callback: unknown, input?: unknown): number => {
    if (typeof callback !== "function") throw new TypeError(`TN_TSL ${form}: expected a callback`);
    runtime.release(runtime.call("scope:open", null, []));
    depth++;
    let returned: TslArgValue[] = [];
    try {
      const result: unknown = callback(input);
      if (result !== undefined) returned = [argument("scope:close", 0, result)];
    } catch (error) {
      depth--;
      runtime.release(runtime.call("scope:close", null, []));
      throw error;
    }
    depth--;
    return runtime.call("scope:close", null, returned);
  };
  // A statement's body crosses into the statement's own node, so its handle is released after the call.
  const consume = (body: number, made: number): number => {
    runtime.release(body);
    return made;
  };
  const statement = (form: string): void => {
    if (depth === 0) throw new TypeError(`TN_TSL ${form}: statement outside Fn`);
  };
  prototype.toVar = function (this: ITslNode) {
    return wrap(runtime.call("toVar", this[TSL_NODE], []));
  };
  prototype.assign = function (this: ITslNode, value: unknown) {
    runtime.release(call("assign", this[TSL_NODE], [value]));
    return this;
  };
  // r185's `<op>Assign`: the shared scopes assign op(this, value) to the variable.
  for (const form of ["addAssign", "subAssign", "mulAssign", "divAssign"]) {
    prototype[form] = function (this: ITslNode, value: unknown) {
      runtime.release(call(form, this[TSL_NODE], [value]));
      return this;
    };
  }
  prototype.Else = function (this: ITslNode, callback: unknown) {
    statement("Else");
    const body = capture("Else", callback);
    return wrap(consume(body, runtime.call("Else", this[TSL_NODE], [node(body)])));
  };
  prototype.__effect = function (this: ITslNode, name: string, value?: number) {
    return runtime.effectParameter(this[TSL_NODE], name, value);
  };
  // A uniform under the name a material binds: the same wrapper now names the renamed node, so its
  // live `.value` (tsl-uniforms.ts) writes the node the game goes on to use.
  prototype.setName = function (this: ITslNode, label: unknown) {
    const previous = this[TSL_NODE];
    const renamed = call("setName", previous, [label]);
    Object.defineProperty(this, TSL_NODE, { value: renamed, configurable: true });
    released.unregister(this);
    released.register(this, renamed, this);
    runtime.release(previous);
    return this;
  };
  const exports: Record<string, unknown> = {};
  for (const name of FUNCTIONS)
    exports[name] = (...args: unknown[]) => wrap(call(name, null, args));
  // Each call binds its own inputs before the callback builds the graph.
  exports.Fn = (callback: unknown) => {
    if (typeof callback !== "function") throw new TypeError("TN_TSL Fn: expected a callback");
    return (...args: unknown[]) => {
      const first = args[0];
      const inputs =
        args.length === 1 &&
        first !== null &&
        typeof first === "object" &&
        !isTslNode(first) &&
        (Array.isArray(first) || first.constructor === Object)
          ? first
          : args;
      const asNode = (value: unknown) =>
        isTslNode(value) ? value : wrap(call("nodeObject", null, [value]));
      const parameters = Array.isArray(inputs)
        ? inputs.map(asNode)
        : Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, asNode(value)]));
      return wrap(capture("Fn", callback, parameters));
    };
  };
  exports.If = (condition: unknown, callback: unknown) => {
    statement("If");
    const test = argument("If", 0, condition);
    const body = capture("If", callback);
    return wrap(consume(body, runtime.call("If", null, [test, node(body)])));
  };
  exports.Loop = (count: unknown, callback: unknown) => {
    statement("Loop");
    const index = wrap(runtime.call("Loop:index", null, []));
    const body = capture("Loop", callback, { i: index });
    return wrap(
      consume(
        body,
        runtime.call("Loop", null, [argument("Loop", 0, count), node(index[TSL_NODE]), node(body)]),
      ),
    );
  };
  // A storage buffer: setName names it, element(index) reads or assigns one element.
  exports.instancedArray = (count: unknown, type: unknown) => {
    if (!Number.isInteger(count) || (count as number) <= 0)
      throw new TypeError("TN_TSL instancedArray: storage count must be positive");
    let label = "";
    const buffer = {
      setName(name: unknown) {
        label = String(name);
        return buffer;
      },
      element: (index: unknown) => wrap(call("storage:element", null, [label, type, index])),
    };
    return buffer;
  };
  for (const name of CONSTANTS) {
    let made: ITslNode | undefined;
    Object.defineProperty(exports, name, {
      enumerable: true,
      get: () => {
        made ??= wrap(call(`constant:${name}`, null, []));
        return made;
      },
    });
  }
  const live = liveUniforms(exports.uniform as (value: unknown) => ITslNode, (node, lanes) =>
    runtime.setUniform(node[TSL_NODE], lanes),
  );
  exports.uniform = live.uniform;
  exports.uniformArray = live.uniformArray;
  if (classes !== undefined) withConstValues(exports, classes);
  Object.assign(exports, defineTslExtras(exports as never));
  // mrt()'s `normal: vec4(normalView, 0)` names the engine's normal target (pass-node.ts), as on the V8 player.
  exports.vec4 = markNormalTarget(exports.vec4 as never, exports.normalView);
  return { exports, sync: live.sync };
}
