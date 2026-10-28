import type { Rule } from "eslint";
import type * as ESTree from "estree";
import { mergeVisitors, trackHotCallbacks } from "./hotCallbacks.js";

const MATH_CLASSES = new Set(["Matrix4", "Quaternion", "Vector2", "Vector3"]);
const THREE_MODULES = new Set(["three", "three/webgpu"]);

function importedName(
  specifier: ESTree.ImportDeclaration["specifiers"][number],
): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined;
  return specifier.imported.type === "Identifier" ? specifier.imported.name : undefined;
}

/** Warns on a Three.js math constructor that runs directly inside a per-frame callback: a
 * `Scene` `update`/`render` method or a function registered with `ctx.beforeRender` or `ctx.afterPhysics`. It is
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
    const hot = trackHotCallbacks();
    const mathLocals = new Set<string>();
    const threeNamespaces = new Set<string>();

    const registerImport = (
      source: string,
      specifier: ESTree.ImportDeclaration["specifiers"][number],
    ): void => {
      const name = importedName(specifier);
      if (THREE_MODULES.has(source)) {
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

    const visitor: Rule.RuleListener = {};
    visitor.ImportDeclaration = (node) => {
      for (const specifier of node.specifiers) registerImport(String(node.source.value), specifier);
    };
    visitor.NewExpression = (node) => {
      const where = hot.where();
      const name = where === undefined ? undefined : mathClassName(node.callee);
      if (where !== undefined && name !== undefined) {
        context.report({ node, messageId: "allocation", data: { name, where } });
      }
    };
    return mergeVisitors(hot.visitor, visitor);
  },
};
