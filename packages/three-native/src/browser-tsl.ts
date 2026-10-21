import { type IEngineRef, TSL_NODE, engineRef } from "./browser-backend.js";
import { markNormalTarget } from "./pass-node.js";
import { defineQuadMesh } from "./quad-mesh.js";
import { type IRttClasses, defineRtt } from "./rtt.js";
import { defineStorage, defineStorageTextures } from "./storage.js";
import { defineTslExtras } from "./tsl-extras.js";
import { defineStruct } from "./tsl-struct.js";
import { type ConstClasses, liveUniforms, uniformLanes, withConstValues } from "./tsl-uniforms.js";
import { defineWgslFn } from "./wgsl-fn.js";
/**
 * TSL on the Wasm engine (PRD-540): three's `three/tsl` authoring functions and node methods as JS
 * wrappers over node ids, built by the engine's one TSL name table (`tn_tsl_call`, shared with the
 * V8 back end). A node is an engine graph node; nothing here builds shader code in JavaScript.
 *
 * The statement forms (Fn, If, Else, Loop, toVar, assign) run the game's callbacks here, between
 * the engine's `scope:open` and `scope:close`, so their statements land in the engine's open body
 * (tn::abi::TslScopes, shared with the V8 back end).
 */

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
  /** three's `renderer.compute(node)`: queues the kernel; it runs ahead of the next draw or read. */
  compute(node: number): void;
  /** `renderer.getArrayBufferAsync(attribute)`: the storage buffer's bytes after every queued kernel. */
  readStorage(attribute: IEngineRef): Promise<ArrayBuffer>;
  /** `renderer.deleteAttribute(attribute)`: drops the attribute's GPU copy. */
  deleteStorage(attribute: IEngineRef): void;
}

/** Module functions the shared table answers (engine/abi/tsl_call.cpp). */
const FUNCTIONS = [
  "float",
  "int",
  "uint",
  "atomicLoad",
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
  "notEqual",
  "lessThanEqual",
  "greaterThanEqual",
  "and",
  "or",
  "not",
  "all",
  "any",
  "abs",
  "sin",
  "cos",
  "floor",
  "fract",
  "sqrt",
  "exp",
  "exp2",
  "log2",
  "log",
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
  "uvec2",
  "storageTexture",
  "textureLoad",
  "reflect",
  "dFdx",
  "dFdy",
  "lengthSq",
  "viewportSharedTexture",
  "viewportDepthTexture",
  "linearDepth",
  "convertToTexture",
  "rtt",
  "varying",
  // The live post effects (lane-531's table entries); post-effects.ts publishes them as three's addons.
  "ao",
  "denoise",
  "smaa",
  "bloom",
  "traa",
  "film",
  "lut3D",
  "renderOutput",
  "struct",
  "wgslFunction",
  "lightShadowMatrix",
  "luminance",
  "viewZToOrthographicDepth",
  "viewZToPerspectiveDepth",
  "logarithmicDepthToViewZ",
  "oneMinus",
  "mx_noise_float",
  "mx_worley_noise_float",
  "mx_worley_noise_vec2",
  "pmremTexture",
  "reflector",
  "transformDirection",
  "transformNormalToView",
  "property",
] as const;
/** The inputs TSL exports as values (tn::abi::tslConstants), each built once, when first read. */
const CONSTANTS = [
  "viewportLinearDepth",
  "frameGroup",
  "renderGroup",
  "objectGroup",
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
  "modelWorldMatrix",
  "instanceIndex",
  "vertexIndex",
  "screenUV",
  "materialColor",
  "materialEmissive",
  "materialMetalness",
  "materialRoughness",
  "time",
  "deltaTime",
  "normalView",
  "positionViewDirection",
  "screenCoordinate",
  "normalGeometry",
  "tangentGeometry",
  "normalWorldGeometry",
] as const;
/** Node methods the shared table answers, with the receiver passed apart. */
const METHODS = [
  "element",
  "compute",
  "add",
  "sub",
  "mul",
  "div",
  "negate",
  "lessThan",
  "greaterThan",
  "equal",
  "notEqual",
  "lessThanEqual",
  "greaterThanEqual",
  "and",
  "or",
  "not",
  "all",
  "any",
  "toFloat",
  "toInt",
  "toUint",
  "abs",
  "sin",
  "cos",
  "floor",
  "fract",
  "sqrt",
  "exp",
  "exp2",
  "log2",
  "log",
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
  "__rtt",
  "oneMinus",
  "dispose",
  "newStruct",
  "invoke",
  "renderOutput",
  "get",
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
    (index === 0 &&
      (name === "pmremTexture" ||
        name === "texture3D" ||
        name === "storageTexture" ||
        name === "textureStore" ||
        name === "lightShadowMatrix")) ||
    (index < 2 && (name === "reflector" || name === "__rtt"))
  );
}

/** The engine class `storage()` builds attributes from. */
interface IBufferAttributeClass {
  // quality-allow: three's class name, so a back end passes its class map.
  // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
  readonly BufferAttribute: never;
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
  sync(frame?: { camera?: unknown; scene?: unknown }): void;
} {
  const released = new FinalizationRegistry<number>((node) => runtime.release(node));
  // three marks every node with `isNode`; framework code (Atmosphere.radiance) branches on it.
  const prototype: Record<string, unknown> = { isNode: true };
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
    if (
      (name === "traa" && index === 3) ||
      (name === "ao" && index === 2) ||
      (name === "denoise" && index === 3)
    )
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
      const made = wrap(call(name, this[TSL_NODE], args));
      // three's ComputeNode flag, which a game (GPUParticles3D) checks before queueing the kernel.
      if (name === "compute") Object.defineProperty(made, "isComputeNode", { value: true });
      return made;
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
    // Outside a function body there is no stack to declare a variable in (rain's fragment node names its
    // terms this way); the expression itself is the value, read where it is used.
    if (depth === 0) return this;
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
  // `setGroup` answers the node it was called on, so the uniform keeps the live `.value` it was built with.
  prototype.setGroup = function (this: ITslNode, group: unknown) {
    runtime.release(call("setGroup", this[TSL_NODE], [group]));
    return this;
  };
  prototype.Else = function (this: ITslNode, callback: unknown) {
    statement("Else");
    const body = capture("Else", callback);
    return wrap(consume(body, runtime.call("Else", this[TSL_NODE], [node(body)])));
  };
  prototype.ElseIf = function (this: ITslNode, condition: unknown, callback: unknown) {
    statement("ElseIf");
    const test = argument("ElseIf", 0, condition);
    const body = capture("ElseIf", callback);
    return wrap(consume(body, runtime.call("ElseIf", this[TSL_NODE], [test, node(body)])));
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
  exports.rtt = defineRtt(
    exports.rtt as Parameters<typeof defineRtt>[0],
    classes && "Mesh" in classes
      ? ({
          // quality-allow: the back end's class map is untyped; rtt narrows it to the classes it names.
          ...(classes as unknown as IRttClasses),
          // quality-allow: three's class name, so a back end passes its class map.
          // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
          QuadMesh: defineQuadMesh(classes as never),
        } as IRttClasses)
      : undefined,
  );
  exports.wgslFn = defineWgslFn(exports.wgslFunction as Parameters<typeof defineWgslFn>[0]);
  exports.struct = defineStruct(exports.struct as Parameters<typeof defineStruct>[0]);
  // Each call binds its own inputs (positional, an array, nodes or one named object) before the callback
  // builds the graph; setLayout only chains, since the engine inlines.
  exports.Fn = (callback: unknown) => {
    if (typeof callback !== "function") throw new TypeError("TN_TSL Fn: expected a callback");
    const inline = (...args: unknown[]) => {
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
    return Object.assign(inline, { setLayout: () => inline });
  };
  for (const name of ["atomicAdd", "atomicStore", "textureStore"])
    exports[name] = (...args: unknown[]) => {
      statement(name);
      return wrap(call(name, null, args));
    };
  Object.assign(
    exports,
    defineStorageTextures(exports as unknown as Parameters<typeof defineStorageTextures>[0]),
  );
  // r185's Break(), Continue() and Return(): a loop or kernel ends early (statements, like atomicAdd).
  for (const name of ["Break", "Continue", "Return"])
    exports[name] = (...args: unknown[]) => {
      statement(name);
      return wrap(call(name, null, args));
    };
  exports.If = (condition: unknown, callback: unknown) => {
    statement("If");
    const test = argument("If", 0, condition);
    const body = capture("If", callback);
    return wrap(consume(body, runtime.call("If", null, [test, node(body)])));
  };
  // Loop(count, ({ i }) => ...) or three's Loop({ type, start, end, name }, ({ i }) => ...); several
  // parameters nest one loop in the next, named i, j, k... unless a parameter names its own.
  const loop = (
    count: unknown,
    defaultName: string,
    callback: (indices: Record<string, unknown>) => unknown,
  ) => {
    let end = count;
    let type = "int";
    let name = defaultName;
    const extra: TslArgValue[] = [];
    if (typeof count === "object" && count !== null && !isTslNode(count)) {
      const params = count as Record<string, unknown>;
      // The engine counts up while the index is below the end, by a whole step: "<=" is "<" one further.
      if (params.condition !== undefined && params.condition !== "<" && params.condition !== "<=")
        throw new TypeError(
          'TN_TSL Loop: condition is not supported; the loop runs while the index is below ("<") or at most ("<=") the end',
        );
      if (params.update !== undefined && typeof params.update !== "number")
        throw new TypeError("TN_TSL Loop: update is not supported; give a whole number step");
      end = params.end;
      if (params.condition === "<=")
        end = isTslNode(end)
          ? // quality-allow: isTslNode proved a TSL node, whose operator methods its value type does not declare.
            (end as unknown as { add(n: number): unknown }).add(1)
          : Number(end) + 1;
      if (params.type !== undefined) type = String(params.type);
      if (params.name !== undefined) name = String(params.name);
      if (params.start !== undefined || params.update !== undefined)
        extra.push(argument("Loop", 3, params.start ?? 0));
      if (params.update !== undefined) extra.push({ kind: "number", number: params.update });
    }
    const index = wrap(runtime.call("Loop:index", null, [{ kind: "string", text: type }]));
    const body = capture("Loop", callback, { [name]: index });
    return wrap(
      consume(
        body,
        runtime.call("Loop", null, [
          argument("Loop", 0, end),
          node(index[TSL_NODE]),
          node(body),
          ...extra,
        ]),
      ),
    );
  };
  exports.Loop = (...parameters: unknown[]) => {
    statement("Loop");
    const callback = parameters.pop();
    if (typeof callback !== "function" || parameters.length === 0)
      throw new TypeError("TN_TSL Loop: expected a callback");
    const level = (at: number, outer: Record<string, unknown>): unknown =>
      loop(parameters[at], "ijklmnopqrstuvwxyz"[at] ?? "i", (own) => {
        const indices = { ...outer, ...own };
        if (at + 1 < parameters.length) {
          level(at + 1, indices);
          return undefined;
        }
        return callback(indices);
      });
    return level(0, {});
  };
  // three's storage(attribute, type, count) over an engine BufferAttribute (storage.ts): setName names the
  // binding, element(index) reads or assigns one element of the attribute's own GPU buffer.
  let storageSerial = 0;
  const makeStorage = (attribute: unknown, type: unknown) => {
    const ref =
      typeof attribute === "object" && attribute !== null ? engineRef(attribute) : undefined;
    if (ref === undefined || typeof type !== "string")
      throw new TypeError("TN_TSL storage: expected an engine BufferAttribute and an element type");
    let label = `nodeStorageBuffer${++storageSerial}`;
    let atomic = false;
    const elements = new Set<WeakRef<ITslNode>>();
    const buffer = {
      toAtomic() {
        if (type !== "int" && type !== "uint")
          throw new TypeError("TN_TSL toAtomic: expected int or uint elements");
        atomic = true;
        for (const element of elements) {
          const target = element.deref();
          if (target) runtime.release(call("storage:atomic", target[TSL_NODE], []));
        }
        elements.clear();
        return buffer;
      },
      toReadOnly: () => buffer,
      setName(name: unknown) {
        label = String(name);
        return buffer;
      },
      element(index: unknown) {
        const handle: TslArgValue = { kind: "handle", ref };
        const element = wrap(
          runtime.call("storage:object", null, [
            handle,
            { kind: "string", text: type },
            { kind: "string", text: label },
            argument("storage:object", 3, index),
            { kind: "number", number: Number(atomic) },
          ]),
        );
        if (!atomic) elements.add(new WeakRef(element));
        return element;
      },
    };
    return buffer;
  };
  if (classes !== undefined && "BufferAttribute" in classes)
    Object.assign(
      exports,
      defineStorage(
        {
          storage: makeStorage as never,
          get instanceIndex() {
            return exports.instanceIndex;
          },
          get vertexIndex() {
            return exports.vertexIndex;
          },
          varying: (value) => (exports.varying as (value: unknown) => unknown)(value),
        },
        // quality-allow: the engine's BufferAttribute class arrives untyped from the back end's class map.
        (classes as unknown as IBufferAttributeClass).BufferAttribute,
      ),
    );
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
  const live = liveUniforms(
    exports.uniform as (value: unknown, type?: unknown) => ITslNode,
    (node, lanes) => runtime.setUniform(node[TSL_NODE], lanes),
  );
  exports.uniform = live.uniform;
  exports.uniformArray = live.uniformArray;
  exports.reference = live.reference;
  if (classes !== undefined) withConstValues(exports, classes);
  Object.assign(exports, defineTslExtras(exports as never));
  // mrt()'s `normal: vec4(normalView, 0)` names the engine's normal target (pass-node.ts), as on the V8 player.
  // Only the two-argument zero-alpha form can name it, so normalView is built then and not at install.
  const vec4 = exports.vec4 as (...args: unknown[]) => object;
  exports.vec4 = (...args: unknown[]) =>
    args.length === 2 && args[1] === 0
      ? (markNormalTarget(vec4, exports.normalView) as typeof vec4)(...args)
      : vec4(...args);
  return { exports, sync: live.sync };
}
