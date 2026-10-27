import type { Rule } from "eslint";

/** Warns on `useUiState()` with no selector. It re-renders the component on every published
 * snapshot, whichever field changed; a selector re-renders only when its own slice does. */
export const uiStateSelector: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      whole:
        "`useUiState()` without a selector re-renders on every published snapshot. Pass a selector for the fields this component draws.",
    },
  },
  create(context) {
    const visitor: Rule.RuleListener = {};
    // ESLint selects visitors by AST node type name, so the key cannot be camelCase.
    visitor.CallExpression = (node) => {
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "useUiState" &&
        node.arguments.length === 0
      )
        context.report({ node, messageId: "whole" });
    };
    return visitor;
  },
};
