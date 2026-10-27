import type { Rule } from "eslint";
import type * as ESTree from "estree";
import { SYNC_ITERATORS, mergeVisitors, trackHotCallbacks } from "../hotCallbacks.js";

/** Calls that walk a whole object tree, one per call. Measured: the kart hung at 105 ms per fixed
 * step with `Box3.setFromObject` over the track, and a `traverse` costs the same on any group
 * that grows. Compute once in `enter`/`load` and keep the number. */
const TREE_WALKS = new Set([
  "expandByObject",
  "intersectObjects",
  "raycastAll",
  "setFromObject",
  "traverse",
  "traverseVisible",
]);

/** `x.children` itself, the list a hand-written walk iterates. */
function isChildren(node: ESTree.Node): boolean {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "children"
  );
}

/** Errors on a call that walks an object tree directly inside a per-frame callback (see
 * `hotCallbacks.ts`), and on iterating `.children` there by hand (`for (const c of scene.children)`,
 * `group.children.forEach(...)`): core's AutoBatch fingerprinted `scene.children` every frame, 41% of
 * the worker. Syntactic, so a walk behind a helper is outside its coverage; `ctx.raycast` is the
 * engine's accelerated query and is not flagged. */
export const hotCallbackSceneWork: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      walk: "`.{{name}}()` walks an object tree every frame in `{{where}}`. Measure it once in `enter` or `load`, or use the engine's `ctx.raycast`.",
      children:
        "Iterating `.children` walks the scene by hand every frame in `{{where}}`. Keep the objects you need in a list built in `enter` or `load`.",
    },
  },
  create(context) {
    const hot = trackHotCallbacks();
    const visitor: Rule.RuleListener = {};
    // ESLint selects visitors by AST node type name, so the key cannot be camelCase.
    visitor.ForOfStatement = (node) => {
      const where = hot.where();
      if (where !== undefined && isChildren(node.right))
        context.report({ node: node.right, messageId: "children", data: { where } });
    };
    visitor.CallExpression = (node) => {
      const callee = node.callee;
      const where = hot.where();
      if (where === undefined || callee.type !== "MemberExpression" || callee.computed) return;
      if (
        callee.property.type === "Identifier" &&
        SYNC_ITERATORS.has(callee.property.name) &&
        isChildren(callee.object)
      ) {
        context.report({ node: callee.object, messageId: "children", data: { where } });
        return;
      }
      if (callee.property.type !== "Identifier" || !TREE_WALKS.has(callee.property.name)) return;
      context.report({
        node,
        messageId: "walk",
        data: { name: callee.property.name, where },
      });
    };
    return mergeVisitors(hot.visitor, visitor);
  },
};
