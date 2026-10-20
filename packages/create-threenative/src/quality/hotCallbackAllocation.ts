import type { Rule } from "eslint";
import type * as ESTree from "estree";

const MATH_CLASSES = new Set(["Matrix4", "Quaternion", "Vector2", "Vector3"]);
const THREE_MODULES = new Set(["three", "three/webgpu"]);
const FRAME_METHODS = new Set(["render", "update"]);

type FunctionNode =
  | ESTree.ArrowFunctionExpression
  | ESTree.FunctionDeclaration
  | ESTree.FunctionExpression;

/** Warns on a Three.js math constructor that runs directly inside a per-frame callback: a
 * `Scene` `update`/`render` method or a function registered with `ctx.beforeRender`. It is
 * syntactic on purpose. A callback hidden behind a helper is outside its coverage. */
export const hotCallbackAllocation: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      allocation:
        "`new {{name}}()` runs every frame in `{{where}}`. Reuse an instance the scene owns if a measurement shows allocation pressure.",
    },
  },
  create(context) {
    const mathLocals = new Set<string>();
    const threeNamespaces = new Set<string>();
    const sceneLocals = new Set<string>();
    const frames: Array<string | undefined> = [];

    const frameName = (node: FunctionNode): string | undefined => {
      const parent = (node as Rule.Node).parent;
      if (
        parent.type === "MethodDefinition" &&
        !parent.static &&
        parent.key.type === "Identifier"
      ) {
        const owner = parent.parent.parent;
        const base = (owner as ESTree.Class).superClass;
        if (
          FRAME_METHODS.has(parent.key.name) &&
          base?.type === "Identifier" &&
          sceneLocals.has(base.name)
        ) {
          return `Scene.${parent.key.name}`;
        }
      }
      if (
        parent.type === "CallExpression" &&
        parent.arguments[0] === node &&
        parent.callee.type === "MemberExpression" &&
        !parent.callee.computed &&
        parent.callee.property.type === "Identifier" &&
        parent.callee.property.name === "beforeRender"
      ) {
        return "ctx.beforeRender";
      }
      return undefined;
    };
    const enter = (node: FunctionNode): void => {
      frames.push(frameName(node));
    };
    const leave = (): void => {
      frames.pop();
    };

    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        for (const specifier of node.specifiers) {
          if (source === "@threenative/core") {
            if (
              specifier.type === "ImportSpecifier" &&
              specifier.imported.type === "Identifier" &&
              specifier.imported.name === "Scene"
            ) {
              sceneLocals.add(specifier.local.name);
            }
          } else if (THREE_MODULES.has(source)) {
            if (specifier.type === "ImportNamespaceSpecifier")
              threeNamespaces.add(specifier.local.name);
            else if (
              specifier.type === "ImportSpecifier" &&
              specifier.imported.type === "Identifier" &&
              MATH_CLASSES.has(specifier.imported.name)
            ) {
              mathLocals.add(specifier.local.name);
            }
          }
        }
      },
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": leave,
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": leave,
      FunctionExpression: enter,
      "FunctionExpression:exit": leave,
      NewExpression(node) {
        const where = frames[frames.length - 1];
        if (where === undefined) return;
        const callee = node.callee;
        let name: string | undefined;
        if (callee.type === "Identifier" && mathLocals.has(callee.name)) name = callee.name;
        else if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          threeNamespaces.has(callee.object.name) &&
          callee.property.type === "Identifier" &&
          MATH_CLASSES.has(callee.property.name)
        ) {
          name = callee.property.name;
        }
        if (name !== undefined)
          context.report({ node, messageId: "allocation", data: { name, where } });
      },
    };
  },
};
