import type { Rule } from "eslint";
import type * as ESTree from "estree";
import { unwrapExpression } from "../unwrapExpression.js";

const HOOK_NAMES = new Set(["useUiState", "useUiStateDuringStartup"]);

function isFreshCollection(node: ESTree.Node | null | undefined): boolean {
  const inner = unwrapExpression(node);
  return inner?.type === "ObjectExpression" || inner?.type === "ArrayExpression";
}

function statementReturnsFreshCollection(stmt: ESTree.Statement): boolean {
  if (stmt.type === "ReturnStatement") return isFreshCollection(stmt.argument);
  if (stmt.type === "BlockStatement") return stmt.body.some(statementReturnsFreshCollection);
  if (stmt.type === "IfStatement") {
    return (
      statementReturnsFreshCollection(stmt.consequent) ||
      (stmt.alternate !== null &&
        stmt.alternate !== undefined &&
        statementReturnsFreshCollection(stmt.alternate))
    );
  }
  return false;
}

function selectorArg(
  node: ESTree.CallExpression,
): ESTree.Expression | ESTree.SpreadElement | undefined {
  if (node.callee.type !== "Identifier" || !HOOK_NAMES.has(node.callee.name)) return undefined;
  if (node.callee.name === "useUiState") return node.arguments[0];
  return node.arguments[1];
}

/** Errors when a `useUiState` selector returns a new object or array literal (`() => ({ ... })` or
 * `() => [...]`), which fails equality checks on every snapshot and causes React re-render loops. */
export const noUnstableUiSelector: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      unstable:
        "Do not return a new object or array literal from `useUiState` — it allocates every snapshot and loops React. Read one primitive per call or call bare `useUiState()`.",
    },
  },
  create(context) {
    const visitor: Rule.RuleListener = {};
    // ESLint selects visitors by AST node type name, so the key cannot be camelCase.
    visitor.CallExpression = (node) => {
      const arg = selectorArg(node);
      if (arg?.type !== "ArrowFunctionExpression" && arg?.type !== "FunctionExpression") return;
      const returnsCollection =
        arg.body.type === "BlockStatement"
          ? statementReturnsFreshCollection(arg.body)
          : isFreshCollection(arg.body);
      if (returnsCollection) context.report({ node: arg, messageId: "unstable" });
    };
    return visitor;
  },
};
