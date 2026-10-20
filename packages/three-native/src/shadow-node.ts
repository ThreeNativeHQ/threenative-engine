/** Native VSM owns the clip cameras and sampling; core keeps its public option validation. */
let nextId = 0;
export class ShadowBaseNode {
  static get type(): string {
    return "ShadowBaseNode";
  }
  readonly id = nextId++;
  readonly isNode = true;
  readonly isShadowBaseNode = true;
  updateBeforeType = "render";
  disposed = false;
  constructor(readonly light: object) {}
  dispose(): void {
    const shadow = (this.light as { shadow?: { shadowNode?: unknown } }).shadow;
    if (shadow?.shadowNode === this) shadow.shadowNode = null;
    this.disposed = true;
  }
}

/** Core stores selection guards after subtracting refreshStep; native's factory subtracts it. */
export function virtualShadowOptions(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    !(value instanceof ShadowBaseNode) ||
    (value.constructor as typeof ShadowBaseNode).type !== "VirtualShadowNode" ||
    !("options" in value)
  )
    throw new TypeError("TN_NATIVE_SHADOW_NODE_UNSUPPORTED: expected core VirtualShadowNode");
  if (value.disposed) throw new Error("TN_NATIVE_SHADOW_NODE_DISPOSED");
  const bridge = (value as unknown as Record<symbol, unknown>)[
    Symbol.for("threenative.virtualShadow")
  ];
  const options = (bridge ?? value.options) as Record<string, unknown>;
  const guards = options.selectionGuard as number[];
  const steps = options.refreshStep as number[];
  return {
    ...options,
    selectionGuard: guards.map((guard, i) => guard + (steps[Math.min(i, steps.length - 1)] ?? 0)),
  };
}
