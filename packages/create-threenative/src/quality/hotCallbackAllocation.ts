import type { Rule } from "eslint";
import type * as ESTree from "estree";

const MATH_CLASSES = new Set(["Matrix4", "Quaternion", "Vector2", "Vector3"]);
const THREE_MODULES = new Set(["three", "three/webgpu"]);
const FRAME_METHODS = new Set(["render", "update"]);

type FunctionNode =
  | ESTree.ArrowFunctionExpression
  | ESTree.FunctionDeclaration
  | ESTree.FunctionExpression;

function importedName(
  specifier: ESTree.ImportDeclaration["specifiers"][number],
): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined;
  return specifier.imported.type === "Identifier" ? specifier.imported.name : undefined;
}

function isBeforeRenderCall(parent: ESTree.Node, node: FunctionNode): boolean {
  if (parent.type !== "CallExpression" || parent.arguments[0] !== node) return false;
  const callee = parent.callee;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "beforeRender"
  );
}

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
      const parent = (node as Rule.Node).parent as Rule.Node;
      if (
        parent.type === "MethodDefinition" &&
        !parent.static &&
        parent.key.type === "Identifier"
      ) {
        const base = (parent.parent?.parent as ESTree.Class | undefined)?.superClass;
        const isSceneBase = base?.type === "Identifier" && sceneLocals.has(base.name);
        if (isSceneBase && FRAME_METHODS.has(parent.key.name)) return `Scene.${parent.key.name}`;
      }
      return isBeforeRenderCall(parent, node) ? "ctx.beforeRender" : undefined;
    };
    const enter = (node: Rule.Node): void => {
      frames.push(frameName(node as FunctionNode));
    };
    const leave = (): void => {
      frames.pop();
    };

    const registerImport = (
      source: string,
      specifier: ESTree.ImportDeclaration["specifiers"][number],
    ): void => {
      const name = importedName(specifier);
      if (source === "@threenative/core") {
        if (name === "Scene") sceneLocals.add(specifier.local.name);
      } else if (THREE_MODULES.has(source)) {
        if (specifier.type === "ImportNamespaceSpecifier")
          threeNamespaces.add(specifier.local.name);
        else if (name !== undefined && MATH_CLASSES.has(name)) mathLocals.add(specifier.local.name);
      }
    };

    const mathClassName = (callee: ESTree.Expression | ESTree.Super): string | undefined => {
      if (callee.type === "Identifier")
        return mathLocals.has(callee.name) ? callee.name : undefined;
      if (callee.type !== "MemberExpression" || callee.computed) return undefined;
      const { object, property } = callee;
      const fromNamespace = object.type === "Identifier" && threeNamespaces.has(object.name);
      return fromNamespace && property.type === "Identifier" && MATH_CLASSES.has(property.name)
        ? property.name
        : undefined;
    };

    // ESLint selects visitors by AST node type name, so the keys cannot be camelCase.
    const visitor: Rule.RuleListener = {};
    visitor.ImportDeclaration = (node) => {
      for (const specifier of node.specifiers) registerImport(String(node.source.value), specifier);
    };
    for (const type of ["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"]) {
      visitor[type] = enter;
      visitor[`${type}:exit`] = leave;
    }
    visitor.NewExpression = (node) => {
      const where = frames[frames.length - 1];
      const name = where === undefined ? undefined : mathClassName(node.callee);
      if (where !== undefined && name !== undefined) {
        context.report({ node, messageId: "allocation", data: { name, where } });
      }
    };
    return visitor;
  },
};
