import type { Rule } from "eslint";
import type * as ESTree from "estree";
import { unwrapExpression } from "../unwrapExpression.js";

function isAssetsModelCall(node: ESTree.Node | null | undefined): boolean {
  const inner = unwrapExpression(node, { unwrapAwait: true });
  if (inner?.type !== "CallExpression") return false;
  const { callee } = inner;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.type !== "Identifier"
  ) {
    return false;
  }
  if (callee.property.name !== "model") return false;
  const owner = callee.object;
  if (owner.type === "Identifier") return owner.name === "assets";
  return (
    owner.type === "MemberExpression" &&
    !owner.computed &&
    owner.property.type === "Identifier" &&
    owner.property.name === "assets"
  );
}

/** Errors when the `{ scene, animations }` wrapper returned by `ctx.assets.model(...)` is passed
 * directly to `.add(...)` instead of its `.scene` (`TN_ASSET_UNUSED`). */
export const noRawModelAdd: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      rawModelAdd:
        "`ctx.assets.model(...)` returns `{ scene, animations }`, not a Three.js `Object3D`. Add `.scene` (e.g. `const { scene } = await ctx.assets.model(...)`) so the asset is not dropped (`TN_ASSET_UNUSED`).",
    },
  },
  create(context) {
    const rawModelVars = new Set<string>();
    const visitor: Rule.RuleListener = {};
    // ESLint selects visitors by AST node type name, so the key cannot be camelCase.
    visitor.VariableDeclarator = (node) => {
      if (node.id.type !== "Identifier") return;
      if (isAssetsModelCall(node.init)) rawModelVars.add(node.id.name);
      else rawModelVars.delete(node.id.name);
    };
    visitor.AssignmentExpression = (node) => {
      if (node.left.type !== "Identifier") return;
      if (isAssetsModelCall(node.right)) rawModelVars.add(node.left.name);
      else rawModelVars.delete(node.left.name);
    };
    visitor.CallExpression = (node) => {
      const { callee } = node;
      if (
        callee.type !== "MemberExpression" ||
        callee.computed ||
        callee.property.type !== "Identifier" ||
        callee.property.name !== "add"
      ) {
        return;
      }
      const first = node.arguments[0];
      if (first === undefined) return;
      const inner = unwrapExpression(first, { unwrapAwait: true });
      const isRaw =
        isAssetsModelCall(first) || (inner?.type === "Identifier" && rawModelVars.has(inner.name));
      if (isRaw) context.report({ node: first, messageId: "rawModelAdd" });
    };
    return visitor;
  },
};
