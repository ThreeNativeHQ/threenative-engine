import type { Rule } from "eslint";

/** Errors on `useUiStateDuringStartup` without a reason. The hook is the named override of the
 * loading-cover gate: it reads state while the engine's cover is up, so a call must say why in a
 * non-empty string literal `reason` field. The runtime reports the same string as
 * `TN_UI_STARTUP_OVERRIDE`. */
export const startupOverrideReason: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      reason:
        '`useUiStateDuringStartup` needs `{ reason: "…" }` as its first argument, a non-empty string literal that says why this UI draws before the loading cover lifts.',
    },
  },
  create(context) {
    const visitor: Rule.RuleListener = {};
    // ESLint selects visitors by AST node type name, so the key cannot be camelCase.
    visitor.CallExpression = (node) => {
      if (node.callee.type !== "Identifier" || node.callee.name !== "useUiStateDuringStartup")
        return;
      const first = node.arguments[0];
      const reason =
        first?.type === "ObjectExpression"
          ? first.properties.find(
              (property) =>
                property.type === "Property" &&
                !property.computed &&
                ((property.key.type === "Identifier" && property.key.name === "reason") ||
                  (property.key.type === "Literal" && property.key.value === "reason")),
            )
          : undefined;
      const value = reason?.type === "Property" ? reason.value : undefined;
      const ok =
        value?.type === "Literal" && typeof value.value === "string" && value.value.trim() !== "";
      if (!ok) context.report({ node, messageId: "reason" });
    };
    return visitor;
  },
};
