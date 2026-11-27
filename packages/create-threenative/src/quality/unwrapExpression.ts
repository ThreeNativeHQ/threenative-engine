import type * as ESTree from "estree";

const WRAPPED_EXPR_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ChainExpression",
]);

function isAstNode(value: unknown): value is ESTree.Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

/** Unwraps transparent TypeScript/optional-chain wrappers (and optionally `await`) to the inner AST node. */
export function unwrapExpression(
  node: ESTree.Node | null | undefined,
  options: { readonly unwrapAwait?: boolean } = {},
): ESTree.Node | undefined {
  let cur: ESTree.Node | undefined = node ?? undefined;
  while (cur !== undefined) {
    if (options.unwrapAwait && cur.type === "AwaitExpression") {
      cur = cur.argument;
      continue;
    }
    if (WRAPPED_EXPR_TYPES.has(cur.type)) {
      const inner: unknown = Reflect.get(cur, "expression");
      if (isAstNode(inner)) {
        cur = inner;
        continue;
      }
    }
    break;
  }
  return cur;
}
