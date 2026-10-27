import type { Rule } from "eslint";
import { mergeVisitors, trackHotCallbacks } from "../hotCallbacks.js";

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

/** Errors on a call that walks an object tree directly inside a per-frame callback (`Scene`
 * `update`/`render`, `ctx.beforeRender`, `ctx.afterPhysics`). Syntactic, so a walk behind a helper
 * is outside its coverage; `ctx.raycast` is the engine's accelerated query and is not flagged. */
export const hotCallbackSceneWork: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      walk: "`.{{name}}()` walks an object tree every frame in `{{where}}`. Measure it once in `enter` or `load`, or use the engine's `ctx.raycast`.",
    },
  },
  create(context) {
    const hot = trackHotCallbacks();
    const visitor: Rule.RuleListener = {};
    // ESLint selects visitors by AST node type name, so the key cannot be camelCase.
    visitor.CallExpression = (node) => {
      const callee = node.callee;
      const where = hot.where();
      if (where === undefined || callee.type !== "MemberExpression" || callee.computed) return;
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
