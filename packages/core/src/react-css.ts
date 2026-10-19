import type { ReactNode } from "react";
import ReactReconciler from "react-reconciler";
import { DiscreteEventPriority, NoEventPriority } from "react-reconciler/constants.js";
import { type IUiMessage, connectUiBridge } from "./ui-bridge.js";

/**
 * A React host that renders standard JSX to a native CSS engine, with no DOM in the process.
 *
 * The vocabulary is the HTML a game already writes: `div`, `section`, `button`, `className`,
 * `style`, `data-*`, `aria-*`. That is the whole point — the same component can mount through
 * `react-dom` on the web and through here on a phone, so a game does not keep two UI trees.
 *
 * What crosses the UI bridge is not a tree but a stream of mutations, one frame per React commit,
 * exactly what `packages/runtime-native/native/css-ui` replays. This half owns no layout, no style
 * resolution and no Tailwind knowledge: a `class` attribute crosses byte-for-byte and the CSS engine
 * decides what it means, which is the only arrangement in which `hover:bg-brand/80` behaves the
 * same on a phone as in a browser. Nothing here imports `react-dom` or touches `document`.
 *
 * Fail closed: a tag the CSS engine cannot build throws naming it and the allowed list rather than
 * mounting a subtree with a hole in it. Props outside the supported list — the tag list above, the
 * pass-through and renamed attribute sets, the `on*` map and the supported style properties — are
 * ignored rather than throwing, so a component shared with `react-dom` still mounts here.
 */

/** The one frame type this host sends. The native CSS engine keys on it. */
export const CSS_UI_MESSAGE = "tn:css";

/**
 * Every host tag the native CSS engine can build. Closed on purpose: an unknown tag is a missing
 * element, not a different-looking one, and a UI that quietly drops half its tree is the failure
 * this refuses to have.
 */
export const CSS_UI_TAGS = [
  "div",
  "section",
  "aside",
  "header",
  "footer",
  "main",
  "nav",
  "article",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "span",
  "button",
  "img",
  "ul",
  "ol",
  "li",
  "a",
  "label",
  "strong",
  "em",
  "b",
  "i",
  "small",
] as const;

/** One mutation for the CSS engine. The op set is closed and every one of these is legal to send. */
type CssOp =
  | { op: "create"; id: number; tag: string }
  | { op: "text"; id: number; text: string }
  | { op: "setText"; id: number; text: string }
  | { op: "append"; parent: number; child: number }
  | { op: "insertBefore"; parent: number; child: number; before: number }
  | { op: "remove"; id: number }
  | { op: "attr"; id: number; name: string; value: string | null }
  | { op: "listen"; id: number; event: string };

/** The body root the engine hangs the tree from. Its id is 0, which is why real ids start at 1. */
const ROOT_ID = 0;

/** The event an `on*` prop asks for, and so the event name that comes back over the bridge. */
const EVENT_PROPS: Readonly<Record<string, string>> = {
  onClick: "click",
  onPointerDown: "pointerdown",
  onPointerUp: "pointerup",
  onPointerEnter: "pointerenter",
  onPointerLeave: "pointerleave",
  onFocus: "focus",
  onBlur: "blur",
};

const EVENT_NAMES: ReadonlySet<string> = new Set(Object.values(EVENT_PROPS));

/** Props whose attribute keeps the React name, and so crosses as typed. */
const PASSTHROUGH_ATTRS: ReadonlySet<string> = new Set([
  "id",
  "role",
  "type",
  "src",
  "alt",
  "title",
]);

/** The React props whose names are spelled differently as attributes. */
const RENAMED_ATTRS: Readonly<Record<string, string>> = {
  className: "class",
  tabIndex: "tabindex",
};

/**
 * The CSS properties React does not append `px` to. Spelled out rather than derived: a wrong entry
 * here is a layout that only looks right at the default font size.
 */
const UNITLESS_PROPERTIES: ReadonlySet<string> = new Set([
  "lineHeight",
  "opacity",
  "flex",
  "flexGrow",
  "flexShrink",
  "zIndex",
  "order",
  "fontWeight",
  "zoom",
  "aspectRatio",
  "gridColumn",
  "gridRow",
  "gridRowStart",
  "gridRowEnd",
  "gridColumnStart",
  "gridColumnEnd",
  "lineClamp",
  "WebkitLineClamp",
  "columns",
  "tabSize",
]);

/** A handler as this host stores it: React's signature, reached through our own event object. */
type CssHandler = (event: ICssSyntheticEvent) => void;

/** The only event shape a native control can honestly offer. There is no DOM here to be complete. */
interface ICssSyntheticEvent {
  readonly type: string;
  readonly target: { readonly id: number };
  preventDefault(): void;
  stopPropagation(): void;
}

interface ICssElement {
  readonly kind: "element";
  readonly id: number;
  readonly tag: string;
  /** What the engine has been told, so an update emits the attributes that actually changed. */
  readonly attrs: Map<string, string>;
  readonly children: ICssNode[];
  /** Live handlers by event name. Updated in place, so a new closure never crosses the bridge. */
  readonly handlers: Map<string, CssHandler>;
  /** Events a `listen` op was already sent for. One listener per node per event, forever. */
  readonly listened: Set<string>;
}

interface ICssText {
  readonly kind: "text";
  readonly id: number;
  text: string;
}

type ICssNode = ICssElement | ICssText;

interface ICssRoot {
  /** The body root, which is also the reconciler's container: id 0, and a parent like any other. */
  readonly root: ICssElement;
  readonly byId: Map<number, ICssElement>;
  readonly pending: CssOp[];
  nextId: number;
  opCount: number;
  postCount: number;
}

/** Node ids are u32 from 1: 0 is the body root, which the engine already owns. */
function takeId(root: ICssRoot): number {
  root.nextId += 1;
  return root.nextId;
}

/** `WebkitLineClamp` is `-webkit-line-clamp`; a custom property is emitted exactly as written. */
function styleProperty(name: string): string {
  // The leading capital of a vendor name is the leading dash of its CSS property, so
  // hyphenating is the whole rule: `WebkitLineClamp` -> `-webkit-line-clamp`.
  return name.startsWith("--")
    ? name
    : name.replaceAll(/[A-Z]/gu, (upper) => `-${upper.toLowerCase()}`);
}

function styleValue(name: string, value: string | number): string {
  if (typeof value === "string") return value;
  return name.startsWith("--") || UNITLESS_PROPERTIES.has(name) ? String(value) : `${value}px`;
}

/** One `style` attribute. `undefined` means the object held nothing worth sending. */
function styleAttribute(style: unknown): string | undefined {
  if (typeof style !== "object" || style === null) return undefined;
  const declarations: string[] = [];
  for (const [name, value] of Object.entries(style)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    declarations.push(`${styleProperty(name)}: ${styleValue(name, value)}`);
  }
  return declarations.length === 0 ? undefined : declarations.join("; ");
}

/** One prop as one attribute, or nothing for a prop that crosses as no attribute at all. */
function attrFor(name: string, value: unknown): readonly [string, string] | undefined {
  if (value === null || value === undefined) return undefined;
  if (name.startsWith("data-") || name.startsWith("aria-")) return [name, String(value)];
  if (name === "disabled") return value ? [name, ""] : undefined;
  if (name === "style") {
    const css = typeof value === "string" ? value : styleAttribute(value);
    return css === undefined ? undefined : [name, css];
  }
  const named = PASSTHROUGH_ATTRS.has(name) ? name : RENAMED_ATTRS[name];
  return named === undefined ? undefined : [named, String(value)];
}

/**
 * What the props say the engine should hold, as attributes. An allowlist, not a sweep: `children`,
 * an unknown `on*` prop and anything else React owns is absent here rather than crossing as noise.
 */
function desiredAttrs(props: Record<string, unknown>): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const [name, value] of Object.entries(props)) {
    const attr = attrFor(name, value);
    if (attr !== undefined) attrs.set(attr[0], attr[1]);
  }
  return attrs;
}

/** Attributes that differ from what the engine holds, plus a `null` for each one it should drop. */
function attrOps(element: ICssElement, props: Record<string, unknown>): CssOp[] {
  const desired = desiredAttrs(props);
  const ops: CssOp[] = [];
  for (const [name, value] of desired) {
    if (element.attrs.get(name) === value) continue;
    element.attrs.set(name, value);
    ops.push({ op: "attr", id: element.id, name, value });
  }
  for (const name of [...element.attrs.keys()]) {
    if (desired.has(name)) continue;
    element.attrs.delete(name);
    ops.push({ op: "attr", id: element.id, name, value: null });
  }
  return ops;
}

function makeElement(id: number, tag: string, props: Record<string, unknown>): ICssElement {
  if (!(CSS_UI_TAGS as readonly string[]).includes(tag)) {
    throw new Error(
      `TN_CSS_UI_ELEMENT_UNSUPPORTED: <${tag}> has no native CSS element, so mounting it would drop the subtree under it. Build it from: ${CSS_UI_TAGS.join(" ")}.`,
    );
  }
  if (props.dangerouslySetInnerHTML !== undefined) {
    throw new Error(
      "TN_CSS_UI_PROP_UNSUPPORTED: dangerouslySetInnerHTML has no native CSS equivalent, because the engine is handed a tree and not a string. Render the markup as elements, or send it as a sheet.",
    );
  }
  return {
    attrs: new Map(),
    children: [],
    handlers: new Map(),
    id,
    kind: "element",
    listened: new Set(),
    tag,
  };
}

/**
 * One `listen` the first time a node asks for an event, and the handler swapped in place after
 * that. A HUD re-rendering every frame must not re-arm every button on every frame.
 */
function handlerOps(element: ICssElement, props: Record<string, unknown>): CssOp[] {
  const ops: CssOp[] = [];
  for (const [prop, event] of Object.entries(EVENT_PROPS)) {
    const handler = props[prop];
    if (typeof handler !== "function") {
      // The prop is gone, so the control must stop firing. The engine keeps the listener it has.
      element.handlers.delete(event);
      continue;
    }
    if (!element.listened.has(event)) {
      element.listened.add(event);
      ops.push({ op: "listen", id: element.id, event });
    }
    element.handlers.set(event, handler as CssHandler);
  }
  return ops;
}

/** Drop a removed subtree's handler entries with it, so a stale frame cannot reach a dead node. */
function free(root: ICssRoot, node: ICssNode): void {
  root.byId.delete(node.id);
  if (node.kind !== "element") return;
  node.handlers.clear();
  for (const child of node.children) free(root, child);
}

/** Ops that wire nodes together, which must not precede the ops that make those nodes exist. */
function wires(op: CssOp): boolean {
  return op.op === "append" || op.op === "insertBefore";
}

/**
 * The batch in an order the engine can replay without a partial tree.
 *
 * React builds a mount bottom-up, so a naive queue interleaves `append` of a child with the
 * `create` of the next sibling. Every node is made first and the wiring follows in commit order,
 * which leaves the root's own append last.
 */
function orderedOps(ops: readonly CssOp[]): CssOp[] {
  const made = ops.filter((op) => !wires(op));
  return made.length === ops.length ? [...ops] : [...made, ...ops.filter(wires)];
}

/** The reconciler entry points this host calls; react-reconciler's own generics are 20 positional slots. */
interface IReconciler {
  createContainer(...args: readonly unknown[]): unknown;
  updateContainerSync(
    element: unknown,
    container: unknown,
    parent: unknown,
    callback: unknown,
  ): void;
  flushSyncWork(): void;
}

// quality-allow: react-reconciler's generics are 20 positional slots; narrowed once to IReconciler.
const createReconciler = ReactReconciler as unknown as (config: unknown) => IReconciler;

export interface ICssUiRootOptions {
  /** The realm the bridge installs into. Defaults to `globalThis`; injected by tests and by hosts. */
  readonly scope?: Record<string, unknown>;
  /**
   * Called with any error React could not recover from — an unsupported tag, an unresolvable prop.
   * The default logs it; nothing swallows it, because a UI that silently lost half its tree and a
   * UI that was never asked for both look like an empty screen.
   */
  readonly onError?: (error: Error) => void;
}

export interface ICssUiRoot {
  /** Mount or update the tree. Synchronous, so the caller can assert on the frame immediately. */
  render(element: ReactNode): void;
  /** Unmount the tree, publish the removal, and stop listening to the bridge. */
  dispose(): void;
  /** How many mutation ops this root has sent. For budgets and tests. */
  readonly opCount: number;
  /** How many frames this root has posted. A commit that changed nothing posts nothing. */
  readonly postCount: number;
}

/**
 * The host config, per root rather than per module: `createInstance` is called with no parent, so
 * the counter, the op queue and the handler table have to be reachable from the config itself, and
 * a module-level one would hand the second root the first root's state.
 */
function hostConfig(root: ICssRoot, flush: () => void): unknown {
  let priority: number = NoEventPriority;
  /** Every structural op also keeps the JS child list, which is how a removal finds its subtree. */
  const append = (parent: ICssElement, child: ICssNode): void => {
    const existing = parent.children.indexOf(child);
    if (existing >= 0) parent.children.splice(existing, 1);
    parent.children.push(child);
    root.pending.push({ op: "append", parent: parent.id, child: child.id });
  };
  const insert = (parent: ICssElement, child: ICssNode, before: ICssNode): void => {
    const existing = parent.children.indexOf(child);
    if (existing >= 0) parent.children.splice(existing, 1);
    parent.children.splice(parent.children.indexOf(before), 0, child);
    root.pending.push({
      op: "insertBefore",
      parent: parent.id,
      child: child.id,
      before: before.id,
    });
  };
  const remove = (parent: ICssElement, child: ICssNode): void => {
    const at = parent.children.indexOf(child);
    if (at >= 0) parent.children.splice(at, 1);
    free(root, child);
    root.pending.push({ op: "remove", id: child.id });
  };
  return {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: false,
    noTimeout: -1 as const,
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,

    createInstance: (tag: string, props: Record<string, unknown>) => {
      const element = makeElement(takeId(root), tag, props);
      root.byId.set(element.id, element);
      root.pending.push({ op: "create", id: element.id, tag });
      for (const op of attrOps(element, props)) root.pending.push(op);
      for (const op of handlerOps(element, props)) root.pending.push(op);
      return element;
    },
    createTextInstance: (text: string): ICssText => {
      const node: ICssText = { id: takeId(root), kind: "text", text };
      root.pending.push({ op: "text", id: node.id, text });
      return node;
    },
    shouldSetTextContent: () => false,
    getPublicInstance: (instance: ICssNode) => instance,
    getRootHostContext: () => HOST_CONTEXT,
    getChildHostContext: () => HOST_CONTEXT,

    // `appendInitialChild` is the same wire op as `appendChild`: React assembles a detached subtree
    // in the render phase, and the engine has to be handed that same subtree before the root's own
    // append, which is the last op of the batch.
    appendInitialChild: (parent: ICssElement, child: ICssNode) => append(parent, child),
    appendChild: (parent: ICssElement, child: ICssNode) => append(parent, child),
    appendChildToContainer: (target: ICssElement, child: ICssNode) => append(target, child),
    insertBefore: (parent: ICssElement, child: ICssNode, before: ICssNode) =>
      insert(parent, child, before),
    insertInContainerBefore: (target: ICssElement, child: ICssNode, before: ICssNode) =>
      insert(target, child, before),
    removeChild: (parent: ICssElement, child: ICssNode) => remove(parent, child),
    removeChildFromContainer: (target: ICssElement, child: ICssNode) => remove(target, child),
    clearContainer: (target: ICssElement) => {
      for (const child of [...target.children]) remove(target, child);
    },
    finalizeInitialChildren: () => false,
    commitUpdate: (
      instance: ICssElement,
      _tag: string,
      _prev: unknown,
      next: Record<string, unknown>,
    ) => {
      for (const op of attrOps(instance, next)) root.pending.push(op);
      for (const op of handlerOps(instance, next)) root.pending.push(op);
    },
    commitTextUpdate: (instance: ICssText, _old: string, next: string) => {
      instance.text = next;
      root.pending.push({ op: "setText", id: instance.id, text: next });
    },

    prepareForCommit: () => null,
    resetAfterCommit: () => flush(),
    preparePortalMount: () => undefined,
    detachDeletedInstance: () => undefined,
    beforeActiveInstanceBlur: () => undefined,
    afterActiveInstanceBlur: () => undefined,
    prepareScopeUpdate: () => undefined,
    getInstanceFromNode: () => null,
    getInstanceFromScope: () => null,

    setCurrentUpdatePriority: (value: number) => {
      priority = value;
    },
    getCurrentUpdatePriority: () => priority,
    // Discrete, as in the quad backend: an update lands on the sync lane, so a game loop's
    // `flushSyncWork()` is all that is ever needed and the UI never waits on a scheduler.
    resolveUpdatePriority: () => (priority !== NoEventPriority ? priority : DiscreteEventPriority),
    getCurrentEventPriority: () => DiscreteEventPriority,

    shouldAttemptEagerTransition: () => false,
    requestPostPaintCallback: () => undefined,
    maySuspendCommit: () => false,
    preloadInstance: () => true,
    startSuspendingCommit: () => undefined,
    suspendInstance: () => undefined,
    waitForCommitToBeReady: () => null,
    resetFormInstance: () => undefined,
    trackSchedulerEvent: () => undefined,
    resolveEventType: () => null,
    resolveEventTimeStamp: () => -1.1,
    // quality-allow: the key is react-reconciler's own host API spelling and cannot be renamed.
    // biome-ignore lint/style/useNamingConvention: exact React reconciler host API name.
    NotPendingTransition: null,
    // quality-allow: the key is react-reconciler's own host API spelling and cannot be renamed.
    // biome-ignore lint/style/useNamingConvention: exact React reconciler host API name.
    HostTransitionContext: {
      $$typeof: Symbol.for("react.context"),
      // quality-allow: the key is react-reconciler's own host API spelling and cannot be renamed.
      // biome-ignore lint/style/useNamingConvention: exact React context API name.
      Provider: null,
      // quality-allow: the key is react-reconciler's own host API spelling and cannot be renamed.
      // biome-ignore lint/style/useNamingConvention: exact React context API name.
      Consumer: null,
      _currentValue: null,
      _currentValue2: null,
      _threadCount: 0,
    },

    flush,
  };
}

const HOST_CONTEXT = {};

/**
 * Mount React into a native CSS engine.
 *
 * @situation mount a React HUD on the desktop host with no DOM in the runtime
 * @situation write one React component and run it on the web and on the desktop host
 * @constraint desktop only, and the game host must be built with the CSS backend (`TN_ENABLE_CSS_UI=1`); Android, iOS and web phones render a React HUD in a web overlay instead
 * @constraint import `react`, never `react-dom`, from a native entry
 * @constraint styling is CSS resolved by the native engine; JS only mirrors the element tree
 * @example const root = createCssUiRoot();
 * @example root.render(createElement("section", { className: "fixed inset-0 bg-zinc-900/90" }, "READY"));
 */
export function createCssUiRoot(options: ICssUiRootOptions = {}): ICssUiRoot {
  const bridge = connectUiBridge({ end: "game", scope: options.scope });
  const root: ICssRoot = {
    byId: new Map(),
    nextId: ROOT_ID,
    opCount: 0,
    pending: [],
    postCount: 0,
    root: {
      attrs: new Map(),
      children: [],
      handlers: new Map(),
      id: ROOT_ID,
      kind: "element",
      listened: new Set(),
      tag: "body",
    },
  };
  const report = (error: unknown): void => {
    const named = error instanceof Error ? error : new Error(String(error));
    if (options.onError !== undefined) options.onError(named);
    else console.error(named.message);
  };
  const flush = (): void => {
    const ops = orderedOps(root.pending);
    if (ops.length === 0) return;
    root.pending.length = 0;
    root.opCount += ops.length;
    root.postCount += 1;
    bridge.post({ ops, type: CSS_UI_MESSAGE } satisfies IUiMessage);
  };
  const reconciler = createReconciler(hostConfig(root, flush));
  const fiberRoot = reconciler.createContainer(
    root.root,
    0,
    null,
    false,
    null,
    "tn",
    report,
    report,
    report,
    null,
  );

  let eventDispatch: string | undefined;
  let propagationStopped = false;
  const unsubscribe = bridge.onMessage((message: IUiMessage) => {
    const { type } = message;
    if (!EVENT_NAMES.has(type)) return;
    const id = message.id;
    if (typeof id !== "number") return;
    const dispatch = typeof message.dispatch === "string" ? message.dispatch : undefined;
    if (dispatch === undefined || dispatch !== eventDispatch) {
      eventDispatch = dispatch;
      propagationStopped = false;
    }
    if (propagationStopped) return;
    const handler = root.byId.get(id)?.handlers.get(type);
    if (handler === undefined) return;
    try {
      handler({
        preventDefault: () => undefined,
        stopPropagation: () => {
          if (dispatch !== undefined && dispatch === eventDispatch) propagationStopped = true;
        },
        target: { id },
        type,
      });
    } catch (error) {
      // A control that throws is a game's bug, and a bridge listener that throws with it takes
      // every later event down too.
      report(error);
    }
  });

  return {
    render(element: ReactNode) {
      reconciler.updateContainerSync(element, fiberRoot, null, null);
      reconciler.flushSyncWork();
    },
    dispose() {
      reconciler.updateContainerSync(null, fiberRoot, null, null);
      reconciler.flushSyncWork();
      unsubscribe();
      bridge.close();
      root.byId.clear();
    },
    get opCount() {
      return root.opCount;
    },
    get postCount() {
      return root.postCount;
    },
  };
}
