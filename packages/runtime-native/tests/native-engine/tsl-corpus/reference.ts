/**
 * PRD-510 phase 2: the TSL reference corpus. Each graph is authored here once in upstream TSL (the
 * pinned three) and once in C++ with the native builder (tsl_corpus.cpp, same names, same order).
 * This prints the upstream node tree in the native IR's typed dump syntax (`Program::dump(true)`),
 * so `differential.mjs --suite tsl-ir` compares the two texts graph by graph.
 *
 * The normalizer only renames: upstream wrappers that carry no operation (VarNode, VaryingNode,
 * SubBuildNode) are transparent, `a > b` is the IR's `less(b, a)`, a constant vector is its
 * construct. Any upstream node it has no rule for is printed as `UNMAPPED:<type>`, which never
 * equals a native dump.
 */
import { FrontSide, PerspectiveCamera, Texture } from "three";
import {
  Fn,
  If,
  Loop,
  abs,
  atan,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraWorldMatrix,
  clamp,
  cos,
  cross,
  depth,
  distance,
  dot,
  exp2,
  float,
  floor,
  fract,
  frameGroup,
  time as frameTime,
  fwidth,
  getCurrentStack,
  getViewPosition,
  hash,
  instanceIndex,
  instancedArray,
  int,
  length,
  mat2,
  max,
  min,
  mix,
  mod,
  normalLocal,
  normalWorld,
  normalWorldGeometry,
  normalize,
  positionGeometry,
  positionLocal,
  positionPrevious,
  positionViewDirection,
  pow,
  property,
  saturation,
  screenCoordinate,
  screenSize,
  select,
  setCurrentStack,
  sin,
  smoothstep,
  sqrt,
  step,
  storage,
  tangentLocal,
  texture,
  transformNormalToView,
  uint,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { modelNormalMatrix } from "three/tsl";
import {
  NodeBuilder,
  StackNode,
  StorageBufferAttribute,
  WebGPUCoordinateSystem,
} from "three/webgpu";

type TslNode = {
  isNode?: boolean;
  constructor: { type?: string; name: string };
  getNodeType(builder: unknown): string;
  [key: string]: unknown;
};

const builder = new (NodeBuilder as unknown as new (...args: unknown[]) => { camera: unknown })(
  null,
  null,
  null,
);
// The camera accessors type themselves through the uniform their camera selects.
builder.camera = new PerspectiveCamera();

const TYPES: Record<string, string> = {
  float: "f32",
  int: "i32",
  uint: "u32",
  bool: "bool",
  vec2: "vec2<f32>",
  vec3: "vec3<f32>",
  vec4: "vec4<f32>",
  color: "vec3<f32>",
  ivec2: "vec2<i32>",
  ivec3: "vec3<i32>",
  ivec4: "vec4<i32>",
  uvec2: "vec2<u32>",
  uvec3: "vec3<u32>",
  uvec4: "vec4<u32>",
  bvec2: "vec2<bool>",
  bvec3: "vec3<bool>",
  bvec4: "vec4<bool>",
  mat2: "mat2x2<f32>",
  mat3: "mat3x3<f32>",
  mat4: "mat4x4<f32>",
};

function typeOf(node: TslNode): string {
  const kind = node.constructor.type ?? node.constructor.name;
  // These ask a building stack for their type; theirs is their target's, or their branches'.
  if (kind === "ConvertNode")
    return TYPES[node.convertTo as string] ?? `UNMAPPED_TYPE:${node.convertTo}`;
  if (kind === "ConditionalNode") return typeOf(node.ifNode as TslNode);
  if (kind === "VarNode") return typeOf(node.node as TslNode);
  const type = node.getNodeType(builder);
  return TYPES[type] ?? `UNMAPPED_TYPE:${type}`;
}

/** C's `%g`: six significant digits, trailing zeros dropped, exponent as e+XX / e-XX. */
function printfG(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const exponent = Math.floor(Math.log10(Math.abs(Number(value.toPrecision(6)))));
  if (exponent < -4 || exponent >= 6) {
    const [mantissa, power] = value.toExponential(5).split("e");
    const trimmed = (mantissa as string).replace(/\.?0+$/, "");
    const sign = (power as string).startsWith("-") ? "-" : "+";
    const digits = (power as string).replace(/^[-+]/, "").padStart(2, "0");
    return `${trimmed}e${sign}${digits}`;
  }
  return Number(value.toPrecision(6))
    .toFixed(Math.max(0, 5 - exponent))
    .replace(/\.?0+$/, "");
}

function constant(value: number, type: string): string {
  if (type === "f32") return `${printfG(Math.fround(value))}f:f32`;
  if (type === "i32") return `${value}i:i32`;
  // The i32 bit pattern, as the IR dump prints a u32 constant above 2^31.
  if (type === "u32") return `construct<u32>(${value | 0}i:i32):u32`;
  if (type === "bool") return `${value ? "true" : "false"}:bool`;
  return `UNMAPPED_CONST:${type}`;
}

/** Statement state: the declared variables in declaration order, and whether this is a compute stage. */
const scope = { vars: new Map<unknown, number>(), compute: false };

function storageName(element: TslNode): string {
  const buffer = element.node as TslNode;
  return (buffer.name as string | undefined) ?? "UNNAMED";
}

/**
 * What an `Fn(...)()` accessor (cameraPosition, normalView, ...) is called with: one perspective
 * camera, a front-sided smooth-shaded material, and the NORMAL sub-build, where normalView is the
 * interpolated geometry normal (no normalNode or normal map).
 */
const accessorBuilder = {
  camera: new PerspectiveCamera(),
  renderer: { coordinateSystem: WebGPUCoordinateSystem },
  subBuildFn: "NORMAL",
  isFlatShading: () => false,
  material: { side: FrontSide },
  context: {
    setupPositionView: () => varying(vec3(0), "v_positionView"),
  },
  // r185's normalLocal reads normalGeometry when the geometry has a normal (Normal.js).
  geometry: { hasAttribute: () => true },
};

/** Upstream names the native renderer binds under its own: the view matrix and the normal varying. */
const RENAMES: Record<string, string> = {
  cameraViewMatrix: "viewMatrix",
  v_normalViewGeometry: "normalView",
  v_positionViewDirection: "positionViewDirection",
  v_normalWorldGeometry: "normalWorldGeometry",
  v_positionView: "positionView",
};
const renamed = (name: string) => RENAMES[name] ?? name;
/** Upstream builtins that are unnamed uniforms the renderer fills each frame, bound by these names. */
const BUILTIN_UNIFORMS = new Map<unknown, string>([
  [frameTime, "time"],
  [modelNormalMatrix, "modelNormalMatrix"],
]);

const OPERATORS: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "<": "less",
  "==": "equal",
  "%": "mod",
  "^": "bitXor",
  ">>": "shiftRight",
};

function canon(node: TslNode, fragment: boolean): string {
  if (node.isShaderCallNodeInternal === true) {
    const fn = (node.shaderNode as { jsFunc: (...args: unknown[]) => TslNode }).jsFunc;
    const inputs = node.rawInputs as unknown[] | undefined;
    return canon(inputs?.length ? fn(inputs, accessorBuilder) : fn(accessorBuilder), fragment);
  }
  const kind = node.constructor.type ?? node.constructor.name;
  const child = (key: string) => canon(node[key] as TslNode, fragment);
  switch (kind) {
    case "VaryingNode":
      // A fragment stage reads it as the varying; a vertex stage computes what it carries.
      if (fragment) return `varying:${renamed(node.name as string)}:${typeOf(node)}`;
      return child("node");
    case "VarNode": {
      const declared = scope.vars.get(node);
      if (declared !== undefined) return `v${declared}`;
      return child("node");
    }
    case "SubBuildNode":
    case "SubBuild":
      return child("node");
    case "StorageArrayElementNode":
      return `load:${storageName(node)}[${canon(node.indexNode as TslNode, fragment)}]`;
    // An unassigned property is a WGSL var's zero value, the engine's zero constructor.
    case "PropertyNode": {
      const type = typeOf(node);
      const lanes = { f32: 1, "vec2<f32>": 2, "vec3<f32>": 3, "vec4<f32>": 4 }[type];
      if (lanes === undefined) return `UNMAPPED_PROPERTY:${type}`;
      return lanes === 1
        ? "0f:f32"
        : `construct<${type}>(${Array(lanes).fill("0f:f32").join(", ")}):${type}`;
    }
    case "ScreenNode":
      if (node.scope === "coordinate") return "builtin:position:vec4<f32>.xy:vec2<f32>";
      if (node.scope === "size") return "uniform:screenSize:vec2<f32>";
      return `UNMAPPED_SCREEN:${node.scope}`;
    case "ConstNode": {
      const type = typeOf(node);
      const value = node.value as number | { toArray(): number[] };
      if (typeof value === "number" || typeof value === "boolean")
        return constant(Number(value), type);
      const scalar = type.replace(/^vec\d<(.*)>$/, "$1");
      return `construct<${type}>(${value
        .toArray()
        .map((v) => constant(v, scalar))
        .join(", ")}):${type}`;
    }
    case "UniformNode":
      return `uniform:${renamed(BUILTIN_UNIFORMS.get(node) ?? (node.name as string))}:${typeOf(node)}`;
    case "AttributeNode":
      if (fragment)
        return `varying:${(node as unknown as { _attributeName: string })._attributeName}:${typeOf(node)}`;
      return `attribute:${(node as unknown as { _attributeName: string })._attributeName}:${typeOf(node)}`;
    case "IndexNode":
      if (scope.compute && node.scope === "instance")
        return "builtin:globalInvocationId:vec3<u32>.x:u32";
      return `builtin:${node.scope as string}Index:${typeOf(node)}`;
    case "OperatorNode": {
      const op = node.op as string;
      const type = typeOf(node);
      if (op === ">") return `less(${child("bNode")}, ${child("aNode")}):${type}`;
      const name = OPERATORS[op];
      if (name === undefined) return `UNMAPPED_OP:${op}`;
      // OperatorNode.generate builds a numeric constant operand as the other operand's integer type, so
      // a u32 operation keeps the constant's exact integer (747796405 is not an f32).
      const operand = (key: string, other: string) => {
        const value = node[key] as TslNode;
        const integer = typeOf(node[other] as TslNode) === "u32";
        if (integer && value.constructor.type === "ConstNode" && typeof value.value === "number")
          return constant(value.value, "u32");
        return child(key);
      };
      return `${name}(${operand("aNode", "bNode")}, ${operand("bNode", "aNode")}):${type}`;
    }
    case "MathNode": {
      const method = node.method as string;
      const keys = ["aNode", "bNode", "cNode"].filter((key) => node[key] != null);
      const args = keys.map(child);
      if (method === "negate") return `neg(${args[0]}):${typeOf(node)}`;
      // MathNode.generate writes oneMinus as ( 1.0 - a ), the engine's sub(1, a).
      if (method === "oneMinus") return `sub(1f:f32, ${args[0]}):${typeOf(node)}`;
      // MathNode.generate: on WebGPU, atan with two operands is atan2.
      const name = method === "atan" && node.bNode != null ? "atan2" : method;
      // MathNode.generate builds each operand as the widest operand type, so a scalar operand of a
      // vector call is splatted. Cross and mix's scalar third operand are built as they are.
      const types = keys.map((key) => typeOf(node[key] as TslNode));
      const widest = types.find((type) => /^vec\d</.test(type));
      const splat = (index: number) =>
        widest !== undefined &&
        method !== "cross" &&
        !/^vec\d</.test(types[index] as string) &&
        !(method === "mix" && index === 2);
      const parts = args.map((arg, index) =>
        splat(index) ? `construct<${widest}>(${arg}):${widest}` : arg,
      );
      return `${name}(${parts.join(", ")}):${typeOf(node)}`;
    }
    case "SplitNode":
      return `${child("node")}.${node.components as string}:${typeOf(node)}`;
    case "JoinNode": {
      const type = typeOf(node);
      return `construct<${type}>(${(node.nodes as TslNode[]).map((part) => canon(part, fragment)).join(", ")}):${type}`;
    }
    case "ConvertNode": {
      const type = typeOf(node);
      // NodeBuilder.format returns a snippet already of the target type unchanged.
      if (typeOf(node.node as TslNode) === type) return child("node");
      return `construct<${type}>(${child("node")}):${type}`;
    }
    case "ConditionalNode":
      return `select(${child("condNode")}, ${child("ifNode")}, ${child("elseNode")}):${typeOf(node)}`;
    case "TextureNode": {
      const name = (node.value as { name: string }).name;
      return `sample:${name}(${child("uvNode")}):${typeOf(node)}`;
    }
    case "ViewportDepthNode":
      if (node.scope === "depth")
        return canon(
          (node as unknown as { setup(b: unknown): TslNode }).setup(accessorBuilder),
          fragment,
        );
      return `UNMAPPED_DEPTH:${node.scope}`;
    default:
      return `UNMAPPED:${kind}`;
  }
}

const albedo = new Texture();
albedo.name = "albedo";
const u = uniform(0.5).setName("u");
const tint = uniform(vec3(1, 0.5, 0.25)).setName("tint");
const time = uniform(0).setName("time");
// core's projection-skinned palette: storage() over a StorageBufferAttribute, read per instance.
const palette = storage(new StorageBufferAttribute(16, 4), "vec4", 16)
  .setName("palette")
  .toReadOnly();

/** name -> the output it writes and the expression; the C++ twin builds the same, in order. */
export const CORPUS: [string, string, unknown][] = [
  ["scale-by-uniform", "position", vec4(positionLocal.mul(u), 1)],
  ["swizzle-and-join", "color", vec4(positionLocal.zyx, positionLocal.x)],
  ["sin-of-sum", "color", vec4(vec3(sin(float(2).add(u))), 1)],
  ["attribute-weight", "position", vec4(positionLocal.mul(attribute("weight", "float")), 1)],
  ["vector-math", "color", vec4(normalize(cross(positionLocal, tint)), dot(positionLocal, tint))],
  ["length-distance", "color", vec4(length(positionLocal), distance(positionLocal, tint), 0, 1)],
  [
    "mix-clamp-smoothstep",
    "color",
    vec4(mix(tint, positionLocal, clamp(u, 0, 1)), smoothstep(0, 1, u)),
  ],
  ["unary-math", "color", vec4(abs(u), floor(u), fract(u), sqrt(u))],
  ["binary-math", "color", vec4(pow(u, 2), min(u, time), max(u, time), step(u, time))],
  ["exp-cos", "color", vec4(exp2(u), cos(time), 0, 1)],
  ["compare-select", "color", vec4(vec3(select(u.lessThan(time), u, time)), 1)],
  ["greater-select", "color", vec4(vec3(select(u.greaterThan(0.25), float(1), float(0))), 1)],
  ["negate-sub-div", "color", vec4(u.negate(), u.sub(time), u.div(2), 1)],
  ["uv-texture", "color", texture(albedo, uv())],
  ["texture-scaled-uv", "color", texture(albedo, uv().mul(2)).mul(u)],
  ["int-convert", "color", vec4(float(int(3)), float(uint(4)), 0, 1)],
  ["vector-constants", "color", vec4(vec3(1, 2, 3).add(tint), 1)],
  ["constant-splat", "color", vec4(vec3(0.5).mul(tint), 1)],
  ["vec2-swizzle", "color", vec4(vec2(u, time).yx, 0, 1)],
  ["instance-offset", "position", vec4(positionLocal.add(vec3(float(instanceIndex), 0, 0)), 1)],
  ["time-wave", "position", vec4(positionLocal.add(vec3(0, sin(time.add(positionLocal.x)), 0)), 1)],
  ["camera-position", "color", vec4(cameraPosition, 1)],
  ["camera-projection", "position", cameraProjectionMatrix.mul(vec4(positionGeometry, 1))],
  ["camera-world-matrix", "color", cameraWorldMatrix.mul(vec4(1, 0, 0, 0))],
  ["position-geometry", "position", vec4(positionGeometry.xy, 0, 1)],
  ["normal-world", "color", vec4(normalWorld, 1)],
  ["varying-fragment", "color", vec4(varying(positionGeometry.mul(u), "scaled"), 1)],
  ["varying-vertex", "position", vec4(varying(positionGeometry.mul(u), "scaled"), 1)],
  ["atan", "color", vec4(atan(u), atan(time, u), 0, 1)],
  ["mod", "color", vec4(mod(positionLocal, tint), mod(u, time))],
  ["fwidth", "color", vec4(fwidth(uv()), fwidth(u), 1)],
  ["saturation", "color", vec4(saturation(tint, u), 1)],
  ["mat2", "color", vec4(mat2(vec2(1, 0), vec2(0, 1)).mul(vec2(u, time)), 0, 1)],
  ["hash", "color", vec4(hash(u), 0, 0, 1)],
  ["time", "color", vec4(frameTime, 0, 0, 1)],
  ["normal-local", "position", vec4(positionLocal.add(normalLocal.mul(u)), 1)],
  ["tangent-local", "position", vec4(positionLocal.add(tangentLocal.mul(u)), 1)],
  ["position-previous", "color", vec4(positionPrevious, 1)],
  ["storage-attribute", "position", vec4(positionLocal.add(palette.element(instanceIndex).xyz), 1)],
  ["screen-coordinate", "color", vec4(screenCoordinate, 0, 1)],
  ["position-view-direction", "color", vec4(positionViewDirection, 1)],
  ["screen-size", "color", vec4(screenSize, 0, 1)],
  ["depth", "color", vec4(depth, 0, 0, 1)],
  ["normal-world-geometry", "color", vec4(normalWorldGeometry, 1)],
  ["get-view-position", "color", vec4(getViewPosition(uv(), u, cameraProjectionMatrix), 1)],
  ["set-group", "color", vec4(uniform(0.25).setName("grouped").setGroup(frameGroup), 0, 0, 1)],
  ["transform-normal-to-view", "color", vec4(transformNormalToView(tint), 1)],
  ["property", "color", vec4(property("vec3").add(tint), 1)],
];

/** Run a deferred TSL body (an If/Else branch, a Loop body, an Fn) into a stack of its own. */
function capture(body: () => void): TslNode {
  const stack = new (StackNode as unknown as new () => TslNode)();
  const parent = getCurrentStack();
  setCurrentStack(stack);
  body();
  setCurrentStack(parent);
  return stack;
}

type Deferred = { jsFunc: (...args: unknown[]) => void };

/**
 * A stack as the IR's statements: a declared variable (`toVar`) is `vK = init`, an assignment to
 * one is `vK = value`, a storage element assignment is `store name[index] = value`, `If` is `if`,
 * `Loop` is `loop vK < count` whose index is the next variable. Hoisted values (VarNode intents)
 * carry no statement.
 */
function statements(stack: TslNode, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  for (const node of stack.nodes as TslNode[]) {
    const kind = node.constructor.type ?? node.constructor.name;
    if (kind === "VarNode") {
      if (node.intent === true) continue;
      const index = scope.vars.size;
      lines.push(`${pad}v${index} = ${canon(node.node as TslNode, false)}`);
      scope.vars.set(node, index);
    } else if (kind === "AssignNode") {
      const target = node.targetNode as TslNode;
      const value = canon(node.sourceNode as TslNode, false);
      const targetKind = target.constructor.type ?? target.constructor.name;
      if (targetKind === "StorageArrayElementNode")
        lines.push(
          `${pad}store ${storageName(target)}[${canon(target.indexNode as TslNode, false)}] = ${value}`,
        );
      else lines.push(`${pad}${canon(target, false)} = ${value}`);
    } else if (kind === "ConditionalNode") {
      lines.push(`${pad}if ${canon(node.condNode as TslNode, false)} {`);
      lines.push(
        ...statements(
          capture(() => (node.ifNode as unknown as Deferred).jsFunc()),
          depth + 1,
        ),
      );
      if (node.elseNode != null) {
        lines.push(`${pad}} else {`);
        lines.push(
          ...statements(
            capture(() => (node.elseNode as unknown as Deferred).jsFunc()),
            depth + 1,
          ),
        );
      }
      lines.push(`${pad}}`);
    } else if (kind === "LoopNode") {
      // `Loop(count, body)` lifts the count to a constant node and the body to an Fn.
      const [countNode, fn] = node.params as [TslNode, (...args: unknown[]) => unknown];
      const count = countNode.value as number;
      const body: Deferred = {
        jsFunc: (inputs) => {
          const called = fn(inputs) as { node?: { shaderNode?: Deferred }; shaderNode?: Deferred };
          const call = called.shaderNode !== undefined ? called : called.node;
          call?.shaderNode?.jsFunc(inputs);
        },
      };
      const index = scope.vars.size;
      const i = capture(() => undefined) && int(0).toVar();
      scope.vars.set(i, index);
      lines.push(`${pad}loop v${index} < ${constant(count, "i32")} {`);
      lines.push(
        ...statements(
          capture(() => body.jsFunc({ i })),
          depth + 1,
        ),
      );
      lines.push(`${pad}}`);
    } else {
      lines.push(`${pad}UNMAPPED_STATEMENT:${kind}`);
    }
  }
  return lines;
}

const positions = instancedArray(16, "vec4").setName("positions");

/** Compute graphs: an `Fn` body, authored the same way in tsl_corpus.cpp. */
export const STATEMENTS: [string, () => void][] = [
  [
    "fn-if-store",
    () => {
      const acc = float(0).toVar();
      If(instanceIndex.lessThan(uint(16)), () => {
        acc.assign(acc.add(1));
        positions.element(instanceIndex).assign(vec4(acc, 0, 0, 1));
      });
    },
  ],
  [
    "loop-accumulate",
    () => {
      const acc = float(0).toVar();
      Loop(4, ({ i }: { i: TslNode }) => {
        acc.assign(acc.add(float(i)));
      });
      positions.element(instanceIndex).assign(vec4(acc, 0, 0, 1));
    },
  ],
  [
    "if-else",
    () => {
      If(instanceIndex.lessThan(uint(8)), () => {
        positions.element(instanceIndex).assign(vec4(1, 0, 0, 1));
      }).Else(() => {
        positions.element(instanceIndex).assign(vec4(0, 1, 0, 1));
      });
    },
  ],
  [
    "storage-read-modify",
    () => {
      positions.element(instanceIndex).assign(positions.element(instanceIndex).mul(2));
    },
  ],
];

export function referenceDumps(): string[] {
  const expressions = CORPUS.map(
    ([name, output, node]) =>
      `# ${name}\noutput ${output} = ${canon(node as TslNode, output === "color")}\n`,
  );
  const computes = STATEMENTS.map(([name, body]) => {
    scope.vars = new Map();
    scope.compute = true;
    // `Fn(body)()` is a hoisted call (a VarNode intent around a ShaderCallNodeInternal).
    const call = (Fn(body)() as unknown as { node: { shaderNode: Deferred } }).node;
    const text = statements(
      capture(() => call.shaderNode.jsFunc()),
      0,
    );
    scope.compute = false;
    return `# ${name}\n${text.map((line) => `${line}\n`).join("")}`;
  });
  return [...expressions, ...computes];
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.stdout.write(referenceDumps().join(""));
