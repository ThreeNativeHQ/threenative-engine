import type { Rule } from "eslint";
import type * as ESTree from "estree";

const FRAME_METHODS = new Set(["render", "update"]);
/** Method names a class other than a `Scene` may use for its own per-frame step. A game's entity
 * class is not a node, so the engine cannot see its `update`, and 22 allocation or tree-walk sites
 * in kit entity `update` methods were invisible to the rules. */
const ENTITY_FRAME_METHODS = new Set(["fixedUpdate", "step", "tick", "update"]);
/** Registration calls whose first argument runs every frame (or every render call), by label. The
 * TSL node hooks run once per render call, and a post chain makes many a frame: the shooter's
 * backlight validated its controls in eight `onRenderUpdate` callbacks, 525 bridge reads a frame. */
const FRAME_HOOKS = new Map([
  ["afterPhysics", "ctx.afterPhysics"],
  ["beforeRender", "ctx.beforeRender"],
  ["onFrameUpdate", ".onFrameUpdate"],
  ["onObjectUpdate", ".onObjectUpdate"],
  ["onRenderUpdate", ".onRenderUpdate"],
  ["setAnimationLoop", "renderer.setAnimationLoop"],
]);
/** Array methods that call their callback before they return: a callback passed to one inside a hot
 * callback runs every frame too (`this.enemies.forEach((e) => e.root.traverse(...))`). */
export const SYNC_ITERATORS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
]);

type FunctionNode =
  | ESTree.ArrowFunctionExpression
  | ESTree.FunctionDeclaration
  | ESTree.FunctionExpression;

export interface IHotCallbacks {
  /** Visitors that keep the stack; a rule spreads them into its own and adds `ImportDeclaration`
   * handling by calling `visitor.ImportDeclaration` too. */
  readonly visitor: Rule.RuleListener;
  /** The hot callback the visitor is inside, innermost function first, or undefined. */
  where(): string | undefined;
}

/** The member a call's callee names (`x.forEach(...)` -> "forEach"), when `node` is one of its arguments. */
function calleeMember(parent: ESTree.Node, node: FunctionNode): string | undefined {
  if (parent.type !== "CallExpression" || !parent.arguments.some((arg) => arg === node))
    return undefined;
  const callee = parent.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  return callee.property.type === "Identifier" ? callee.property.name : undefined;
}

function hookName(parent: ESTree.Node, node: FunctionNode): string | undefined {
  if (parent.type !== "CallExpression" || parent.arguments[0] !== node) return undefined;
  const name = calleeMember(parent, node);
  return name === undefined ? undefined : FRAME_HOOKS.get(name);
}

/** The label a class method carries when it runs each frame: `Scene.update`, or `Enemies.tick` for a
 * game's own entity class. */
function methodLabel(parent: Rule.Node, sceneLocals: ReadonlySet<string>): string | undefined {
  if (parent.type !== "MethodDefinition" || parent.static || parent.key.type !== "Identifier")
    return undefined;
  const owner = (parent.parent?.parent as ESTree.Class | undefined) ?? undefined;
  const base = owner?.superClass;
  const isSceneBase = base?.type === "Identifier" && sceneLocals.has(base.name);
  if (isSceneBase)
    return FRAME_METHODS.has(parent.key.name) ? `Scene.${parent.key.name}` : undefined;
  if (!ENTITY_FRAME_METHODS.has(parent.key.name)) return undefined;
  const className = owner?.id?.name;
  return className === undefined ? parent.key.name : `${className}.${parent.key.name}`;
}

/** Tracks whether the visitor is directly inside a per-frame callback: a `Scene` `update`/`render`
 * method, a non-static `update`/`fixedUpdate`/`tick`/`step` method on any other class, a function
 * registered with `ctx.beforeRender` / `ctx.afterPhysics`, a TSL node's
 * `onRenderUpdate` / `onFrameUpdate` / `onObjectUpdate`, or `setAnimationLoop`; a callback handed to
 * an array iterator inside one is inside it too. Syntactic on purpose: a callback hidden behind a
 * helper is outside its coverage. Shared by every rule that means "this must not run every frame". */
export function trackHotCallbacks(): IHotCallbacks {
  const sceneLocals = new Set<string>();
  const frames: Array<string | undefined> = [];

  const frameName = (node: FunctionNode): string | undefined => {
    const parent = (node as Rule.Node).parent as Rule.Node;
    const method = methodLabel(parent, sceneLocals);
    if (method !== undefined) return method;
    const hook = hookName(parent, node);
    if (hook !== undefined) return hook;
    const member = calleeMember(parent, node);
    return member !== undefined && SYNC_ITERATORS.has(member)
      ? frames[frames.length - 1]
      : undefined;
  };

  // ESLint selects visitors by AST node type name, so the keys cannot be camelCase.
  const visitor: Rule.RuleListener = {};
  visitor.ImportDeclaration = (node) => {
    if (node.source.value !== "@threenative/core") return;
    for (const specifier of node.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      if (specifier.imported.type === "Identifier" && specifier.imported.name === "Scene")
        sceneLocals.add(specifier.local.name);
    }
  };
  for (const type of ["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"]) {
    visitor[type] = (node: Rule.Node) => {
      frames.push(frameName(node as FunctionNode));
    };
    visitor[`${type}:exit`] = () => {
      frames.pop();
    };
  }
  return { visitor, where: () => frames[frames.length - 1] };
}

/** Runs `first` then `second` for every key both define. */
export function mergeVisitors(...visitors: Rule.RuleListener[]): Rule.RuleListener {
  const merged: Record<string, (node: never) => void> = {};
  for (const visitor of visitors) {
    for (const [key, handler] of Object.entries(visitor)) {
      const previous = merged[key];
      const next = handler as (node: never) => void;
      merged[key] =
        previous === undefined
          ? next
          : (node) => {
              previous(node);
              next(node);
            };
    }
  }
  return merged as Rule.RuleListener;
}
