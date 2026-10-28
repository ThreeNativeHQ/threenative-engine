import type { Rule } from "eslint";
import type * as ESTree from "estree";
import { mergeVisitors, trackHotCallbacks } from "../hotCallbacks.js";

const RESOURCE = /(Geometry|Material|Texture)$/;

function className(callee: ESTree.Expression | ESTree.Super): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  )
    return callee.property.name;
  return undefined;
}

/** Errors on `new …Geometry/Material/Texture()` directly inside a per-frame callback. A material
 * the renderer has not seen compiles a pipeline on its first draw, which is a visible stall, and
 * every frame builds a new one. Build resources in `load`/`enter` and mutate them in the frame. */
export const hotCallbackResourceCreation: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      resource:
        "`new {{name}}()` in `{{where}}` builds a GPU resource every frame (a pipeline compile on first draw). Create it in `load` or `enter` and change its values here.",
    },
  },
  create(context) {
    const hot = trackHotCallbacks();
    const visitor: Rule.RuleListener = {};
    // ESLint selects visitors by AST node type name, so the key cannot be camelCase.
    visitor.NewExpression = (node) => {
      const where = hot.where();
      const name = where === undefined ? undefined : className(node.callee);
      if (where !== undefined && name !== undefined && RESOURCE.test(name))
        context.report({ node, messageId: "resource", data: { name, where } });
    };
    return mergeVisitors(hot.visitor, visitor);
  },
};
