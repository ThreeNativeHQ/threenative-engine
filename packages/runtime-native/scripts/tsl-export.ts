import { Fn, convert, expression, int, nodeObject, uv } from "three/tsl";
import { NodeBuilder } from "three/webgpu";
import { exportNativePost } from "./tsl-post-export.js";
import { bloomGraph, sharpenGraph } from "./tsl-post.js";

interface ITslNode {
  isNode: true;
  constructor: { type?: string; name: string };
  getNodeType(builder: unknown): string;
  getChildren(): Iterable<ITslNode>;
  [key: string]: unknown;
}

export interface ISerializedTslNode {
  kind: string;
  type?: string;
  name?: string;
  operation?: string;
  lanes?: string;
  value?: number | boolean | number[];
  args: number[];
  dependencies: number[];
  post?: {
    parameters: Record<string, number[]>;
    images: {
      name: string;
      width: number;
      height: number;
      bytes: number[];
      nearest: boolean;
      repeat: boolean;
      flipY: boolean;
    }[];
    normal: boolean;
    resolutionScale: number;
    temporal: boolean;
  };
  body?: number[];
  otherwise?: number[];
  scale?: number;
  width?: number;
  height?: number;
  vertex?: number;
}

export interface ISerializedTslGraph {
  version: 1;
  root: number;
  nodes: ISerializedTslNode[];
}

/** Real upstream TSL DAG, including unknown nodes. Only the native compiler decides support. */
export function exportTslGraph(root: unknown): ISerializedTslGraph {
  const builder = new (NodeBuilder as unknown as new (...args: unknown[]) => NodeBuilder)(
    null,
    null,
    null,
  );
  const ids = new Map<ITslNode, number>();
  const nodes: ISerializedTslNode[] = [];
  const textureNames = new Map<unknown, string>();
  const textureProducers = new Map<unknown, number>();
  const returnTypes = new Map<unknown, string>();
  const loopIndices = new Map<string, number[]>();
  function expandCall(node: ITslNode): unknown {
    const shader = node.shaderNode as ITslNode;
    const layout = shader.layout;
    const rawInputs = node.rawInputs;
    const signature = layout as { type: string; inputs: { name: string; type: string }[] } | null;
    const converted = (value: unknown, type: string) =>
      type.startsWith("texture") || type === "sampler"
        ? nodeObject(value as number)
        : convert(nodeObject(value as number), type);
    // Instantiate the upstream callback, preserving the layout's parameter/return conversions.
    if (signature) {
      const raw = rawInputs as unknown[] | null;
      const first = raw?.[0];
      const named =
        first != null &&
        typeof first === "object" &&
        Object.getPrototypeOf(first) === Object.prototype;
      node.rawInputs = named
        ? [
            Object.fromEntries(
              signature.inputs.map((input) => [
                input.name,
                converted(Reflect.get(first as object, input.name), input.type),
              ]),
            ),
          ]
        : signature.inputs.map((input, i) => converted(raw?.[i], input.type));
    }
    shader.layout = null;
    builder.addStack();
    try {
      builder.stack.outputNode = (node.call as (builder: NodeBuilder) => never)(builder);
      const returnType = signature?.type ?? shader.nodeType;
      if (typeof returnType === "string" && returnType !== "void")
        returnTypes.set(builder.stack, returnType);
      return builder.stack;
    } finally {
      builder.removeStack();
      shader.layout = layout;
      node.rawInputs = rawInputs;
    }
  }
  function visit(value: unknown): number {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function") ||
      Reflect.get(value, "isNode") !== true
    )
      throw new Error(
        `TN_TSL_EXPORT_INVALID: expected a real TSL node, got ${typeof value} ${value === null ? "null" : String(value)}`,
      );
    const node = value as ITslNode;
    const previous = ids.get(node);
    if (previous !== undefined) return previous;
    const id = nodes.length;
    ids.set(node, id);
    const declaredType = node.constructor.type;
    const kind =
      declaredType === "Node" ? node.constructor.name : (declaredType ?? node.constructor.name);
    const record: ISerializedTslNode = { kind, args: [], dependencies: [] };
    nodes.push(record);
    const child = (key: string): number => {
      try {
        return visit(node[key]);
      } catch (error) {
        throw new Error(
          `${kind}.${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const nativePost = exportNativePost(node, kind, id, visit);
    if (nativePost) {
      Object.assign(record, nativePost);
      return id;
    }
    switch (kind) {
      case "ShaderCallNodeInternal": {
        record.kind = "ShaderCall";
        record.args = [visit(expandCall(node))];
        return id;
      }
      case "ShaderNodeInternal": {
        record.kind = "ShaderCall";
        record.args = [visit(expandCall((node.call as () => ITslNode)()))];
        return id;
      }
      case "StackNode":
        record.type = returnTypes.get(node);
        record.body = (node.nodes as unknown[]).map(visit);
        if (node.outputNode != null) record.args = [child("outputNode")];
        return id;
      case "AssignNode":
        record.args = [child("targetNode"), child("sourceNode")];
        return id;
      case "ConditionalNode":
        record.args = [
          child("condNode"),
          child("ifNode"),
          ...(node.elseNode == null ? [] : [child("elseNode")]),
        ];
        return id;
      case "LoopNode": {
        const params = node.params as unknown[];
        const inputs: Record<string, unknown> = {};
        const loops: ISerializedTslNode[] = [];
        for (const [i, raw] of params.slice(0, -1).entries()) {
          const param = raw as {
            isNode?: boolean;
            start?: unknown;
            end?: unknown;
            type?: string;
            condition?: string;
            update?: unknown;
            name?: string;
          };
          const name = param.name ?? String.fromCharCode(105 + i);
          const type = param.type ?? "int";
          if (
            type !== "int" ||
            !["<", "<="].includes(param.condition ?? "<") ||
            (param.update ?? 1) !== 1
          )
            throw new Error(
              "TN_TSL_UNSUPPORTED: LoopNode range (native vocabulary: ascending int loop)",
            );
          const start = param.isNode ? int(0) : int((param.start ?? 0) as number);
          const end = param.isNode
            ? int(raw as number)
            : int(param.end as number).add(int(param.condition === "<=" ? 1 : 0));
          const index = nodes.length;
          nodes.push({ kind: "LoopIndex", args: [], dependencies: [] });
          const binding = loopIndices.get(name) ?? [];
          binding.push(index);
          loopIndices.set(name, binding);
          inputs[name] = expression(name, type);
          loops.push({
            kind: "LoopNode",
            args: [visit(start), visit(end), index],
            body: [],
            dependencies: [],
          });
        }
        const callback = params.at(-1) as (inputs: Record<string, unknown>) => unknown;
        const body = visit(Fn(() => callback(inputs))());
        let nested = body;
        for (let i = loops.length - 1; i >= 0; i--) {
          const loop = loops[i];
          if (loop === undefined) throw new Error("TN_TSL_EXPORT_INVALID: loop");
          loop.body = [nested];
          if (i === 0) Object.assign(record, loop);
          else {
            nested = nodes.length;
            nodes.push(loop);
          }
        }
        for (let i = 0; i < loops.length; i++) {
          const param = params[i] as { name?: string };
          loopIndices.get(param.name ?? String.fromCharCode(105 + i))?.pop();
        }
        return id;
      }
      case "ExpressionNode": {
        const binding = loopIndices.get(String(node.snippet))?.at(-1);
        if (binding !== undefined) {
          record.kind = "LoopIndexReference";
          record.args = [binding];
        } else record.operation = String(node.snippet);
        return id;
      }
      case "BloomNode":
        record.kind = "ShaderCall";
        record.args = [visit(bloomGraph(node as unknown as Parameters<typeof bloomGraph>[0]))];
        return id;
      case "SharpenNode":
        // r185 RCAS samples textureNode.value directly, losing the input RTT node.
        // Export that producer first and reconnect its raw texture loads below.
        child("textureNode");
        record.kind = "ShaderCall";
        record.args = [
          visit(sharpenGraph(node as unknown as Parameters<typeof sharpenGraph>[0], builder)),
        ];
        return id;
      case "RTTNode": {
        record.name = `rtt${id}`;
        if (node.autoUpdate === false) record.operation = "static";
        textureNames.set(node.value, record.name);
        textureProducers.set(node.value, id);
        record.scale = Number(node._resolutionScale);
        if (node.width != null) record.width = Number(node.width);
        if (node.height != null) record.height = Number(node.height);
        record.args = [child("node"), child("uvNode")];
        return id;
      }
      case "TextureSizeNode":
        record.args = [child("textureNode")];
        if (node.levelNode != null) record.args.push(child("levelNode"));
        return id;
      case "ConstNode":
      case "UniformNode": {
        record.type = node.getNodeType(builder);
        const v = node.value;
        if (typeof v === "number" || typeof v === "boolean") record.value = v;
        else if (
          v !== null &&
          typeof v === "object" &&
          typeof Reflect.get(v, "toArray") === "function"
        )
          record.value = (v as { toArray(): number[] }).toArray();
        else throw new Error(`TN_TSL_EXPORT_INVALID: ${kind} value`);
        if (kind === "UniformNode")
          record.name =
            typeof node.name === "string" && node.name.length > 0 ? node.name : `uniform${id}`;
        break;
      }
      case "OperatorNode":
        record.operation = String(node.op);
        record.args = [child("aNode"), ...(node.bNode == null ? [] : [child("bNode")])];
        break;
      case "MathNode":
        record.operation = String(node.method);
        record.args = ["aNode", "bNode", "cNode"].filter((key) => node[key] != null).map(child);
        break;
      case "SplitNode":
        record.lanes = String(node.components);
        record.args = [child("node")];
        break;
      case "JoinNode":
        record.type = node.getNodeType(builder);
        record.args = (node.nodes as unknown[]).map(visit);
        break;
      case "ConvertNode":
        record.type = String(node.convertTo);
        record.args = [child("node")];
        break;
      case "VarNode":
        record.operation =
          node.intent === true ? "intent" : node.readOnly === true ? "readOnly" : "mutable";
        record.args = [child("node")];
        break;
      case "ContextNode":
        if (
          node.value !== null &&
          typeof node.value === "object" &&
          Object.keys(node.value).length > 0
        )
          record.operation = "custom-context";
        record.args = [child("node")];
        break;
      case "VaryingNode":
      case "SubBuildNode":
        record.args = [child("node")];
        break;
      case "UVNode":
        record.name = String(node.index);
        break;
      case "AttributeNode":
        record.name = String(node._attributeName);
        record.type = node.getNodeType(builder);
        break;
      case "PassNode": {
        const scene = node.scene as {
          traverse(callback: (object: { material?: unknown }) => void): void;
        };
        const materials: object[] = [];
        scene.traverse((object) => {
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material]) {
            if (
              material !== null &&
              typeof material === "object" &&
              Reflect.get(material, "fragmentNode") != null
            )
              materials.push(material);
          }
        });
        if (materials.length > 0) {
          if (materials.length !== 1)
            throw new Error("TN_TSL_UNSUPPORTED: multi-material authored post scene");
          const material = materials[0] as object;
          record.operation = "post-material";
          record.name = `scene_post_${id}`;
          record.scale = Number(node._resolutionScale);
          record.args = [visit(Reflect.get(material, "fragmentNode")), visit(uv())];
          const vertex = Reflect.get(material, "vertexNode");
          if (vertex != null) record.vertex = visit(vertex);
        }
        return id;
      }
      case "ViewportDepthNode":
      case "ScreenNode":
        record.operation = String(node.scope);
        break;
      case "TextureNode":
      case "PassTextureNode":
      case "PassMultipleTextureNode": {
        if (node.referenceNode != null) record.dependencies.push(child("referenceNode"));
        const owner = node.passNode;
        // Scene passes are external shader inputs. Effect-owned textures are not: their owner
        // remains a dependency, so e.g. SSGI.getGINode() cannot hide an unlowered SSGINode.
        if (owner !== undefined) record.dependencies.push(visit(owner));
        const producer = textureProducers.get(node.value);
        if (producer !== undefined) record.dependencies.push(producer);
        const image = node.value as { name?: string } | null;
        record.name =
          typeof node.textureName === "string" ? node.textureName : image?.name || `texture${id}`;
        record.name = textureNames.get(node.value) ?? record.name.replace(/[^a-zA-Z0-9_]/gu, "_");
        if (node.uvNode != null) record.args = [child("uvNode")];
        if (node.sampler === false) {
          record.operation = "load";
          if (node.levelNode != null) record.args.push(child("levelNode"));
        }
        if (
          (node.levelNode != null && node.sampler !== false) ||
          node.biasNode != null ||
          node.compareNode != null ||
          node.gradNode != null
        )
          record.operation = "non-default-sampling";
        break;
      }
    }
    // Preserve every dependency, including effect owners and unsupported nodes. Never replace
    // an unrecognised node by a colour sample or omit it from the exported graph.
    for (const dependency of node.getChildren()) record.dependencies.push(visit(dependency));
    record.dependencies = [...new Set(record.dependencies)];
    return id;
  }
  return { version: 1, root: visit(root), nodes };
}
