import { HIT_REGIONS_MESSAGE, type IUiBridge } from "./ui-bridge.js";

/**
 * The interactive-rect registry — how a touch decides whether it belongs to the UI or the game.
 *
 * A web view is a native view with a **rectangular** hit-test region owned by the platform.
 * CSS hit-testing happens inside that surface, after the native view has already claimed the
 * gesture, so `pointer-events: none` does not hand a touch back to the game beneath. It is a
 * useful property inside the page and it is not the pass-through mechanism.
 *
 * The mechanism is this: the page marks its interactive islands with `data-tn-interactive`,
 * this registry publishes where they are, and the native input host does the hit test before
 * either surface sees the gesture.
 *
 * ```tsx
 * <button data-tn-interactive onClick={restart}>Restart</button>
 * ```
 *
 * Three properties make it correct, and each one is a defect this file exists to prevent:
 *
 * - **Published, never queried.** The host owns a snapshot. Asking the page per touch means an
 *   async round trip inside the input path: latency, and a race with the frame that moved it.
 * - **Decided on pointer-down, held to pointer-up.** That rule belongs to the host, because
 *   only the host sees the whole gesture; this file just keeps the snapshot true.
 * - **Republished per frame while a transition is live.** A sliding menu is drawn where the
 *   compositor put it this frame, and a rect published before the slide points at empty space.
 *
 * Rects are **normalized to the viewport**, 0..1, so no host has to know about CSS pixels,
 * device pixel ratio, or the page's zoom to place them on its own surface. That is also what
 * lets a sibling-layer host and an offscreen-texture host read the same payload.
 */

/** One interactive rectangle, normalized to the UI viewport: `0,0` top-left, `1,1` bottom-right. */
export interface IHitRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface IHitRegionRegistry {
  /** Recompute and publish now. Called for you; exposed for a game that moves a rect itself. */
  refresh(): void;
  /** The regions as last published. */
  regions(): readonly IHitRegion[];
  /** Stop observing and publish an empty set, so the host stops consuming touches. */
  stop(): void;
}

interface IRegistryOptions {
  /** The connected bridge whose `ui` end publishes the regions. */
  readonly bridge: IUiBridge;
  /** The realm to observe. Defaults to `globalThis`; injected by tests. */
  readonly scope?: IScopeLike;
  /** The marker attribute. Defaults to `data-tn-interactive`; a game should not change it. */
  readonly attribute?: string;
}

/** The attribute a game puts on an element it wants to receive touches. */
export const INTERACTIVE_ATTRIBUTE = "data-tn-interactive";

interface IRectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface IElementLike {
  getClientRects?: () => ArrayLike<IRectLike>;
  getBoundingClientRect: () => IRectLike;
  /** Used only to name an unmarked control in the development warning below. */
  closest?: (selector: string) => IElementLike | null;
  tagName?: string;
  id?: string;
  className?: string;
}

/** A `MutationObserver` or a `ResizeObserver`, as the two things this file asks of either. */
interface IObserverLike {
  observe: (target: unknown, options?: unknown) => void;
  disconnect: () => void;
}

/** Anything that can be listened to. The document and the window both satisfy it structurally. */
interface IEventTargetLike {
  addEventListener?: (type: string, listener: () => void, options?: unknown) => void;
  removeEventListener?: (type: string, listener: () => void, options?: unknown) => void;
}

interface IDocumentLike extends IEventTargetLike {
  querySelectorAll: (selector: string) => ArrayLike<IElementLike>;
  documentElement?: { clientWidth?: number; clientHeight?: number };
}

/**
 * The realm the registry observes, as the parts of it this file actually touches.
 *
 * Declared structurally rather than as `Window`, because the registry has to be drivable from a
 * test with no DOM — and because the host it really runs in is a web view whose globals the type
 * system here has never seen.
 */
interface IScopeLike extends IEventTargetLike {
  // Indexed because a real realm carries far more than this, and a fake one is free to.
  [key: string]: unknown;
  document?: IDocumentLike;
  console?: { warn?: (message: string) => void };
  innerWidth?: number;
  innerHeight?: number;
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  // `MutationObserver` and `ResizeObserver` are read through the index signature above rather than
  // declared here: they are browser globals and keep the host's capitalisation, which the naming
  // rule is right to reject for an ordinary property.
}

/** A `MutationObserver` or a `ResizeObserver`, as the two things this file asks of either. */
interface IObserverLike {
  observe: (target: unknown, options?: unknown) => void;
  disconnect: () => void;
}

/** Five decimals of a normalized rect is a tenth of a pixel on a 10k display. */
function quantize(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** Events that mean "something is moving and its published rect is now a frame behind". */
const TRANSITION_START = ["transitionrun", "transitionstart", "animationstart"] as const;
const TRANSITION_END = [
  "transitionend",
  "transitioncancel",
  "animationend",
  "animationcancel",
] as const;
/** Events that change layout without changing the DOM, so no observer would fire. */
const LAYOUT_EVENTS = ["resize", "orientationchange", "scroll"] as const;

/**
 * Start publishing interactive rectangles over `bridge`.
 *
 * Fail closed: with no document there is nothing to measure, and a registry that quietly
 * published nothing would look exactly like a UI with no buttons — every touch would fall
 * through to the game and the bug would present as "the button does nothing".
 * @situation give native input hosts the rectangles claimed by UI controls
 * @situation keep touch hit testing aligned with a moving web or native HUD
 * @example const regions = publishHitRegions({ bridge });
 */
export function publishHitRegions(options: IRegistryOptions): IHitRegionRegistry {
  const scope: IScopeLike = options.scope ?? (globalThis as IScopeLike);
  const document = scope.document;
  if (document === undefined || typeof document.querySelectorAll !== "function") {
    throw new Error(
      "TN_UI_HIT_REGIONS_NO_DOCUMENT: the interactive-rect registry runs in the UI page and found no document.",
    );
  }
  const selector = `[${options.attribute ?? INTERACTIVE_ATTRIBUTE}]`;
  const bridge = options.bridge;
  if (bridge.end !== "ui") {
    throw new Error(
      `TN_UI_HIT_REGIONS_WRONG_END: hit regions are published by the 'ui' end, not '${bridge.end}'.`,
    );
  }

  const unmarkedWarning = { warned: false };
  let published: readonly IHitRegion[] = [];
  let publishedFrame = "";
  let stopped = false;
  let liveTransitions = 0;
  let frameHandle: number | undefined;

  const viewport = (): { width: number; height: number } => ({
    width: scope.innerWidth ?? document.documentElement?.clientWidth ?? 0,
    height: scope.innerHeight ?? document.documentElement?.clientHeight ?? 0,
  });

  /**
   * `getClientRects()` and not `getBoundingClientRect()`: a wrapped inline control is several
   * boxes, and their union covers empty page between them.
   */
  const boxesOf = (element: IElementLike): IRectLike[] => {
    const list = element.getClientRects?.();
    if (list === undefined || list.length === 0) return [element.getBoundingClientRect()];
    const boxes: IRectLike[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const rect = list[index];
      if (rect !== undefined) boxes.push(rect);
    }
    return boxes;
  };

  /**
   * A zero-area box is a hidden element. Publishing it would let the host swallow a touch on a
   * control the player cannot see.
   */
  const normalize = (boxes: readonly IRectLike[], width: number, height: number): IHitRegion[] =>
    boxes
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        x: quantize(rect.left / width),
        y: quantize(rect.top / height),
        width: quantize(rect.width / width),
        height: quantize(rect.height / height),
      }));

  const measure = (): IHitRegion[] => {
    const { width, height } = viewport();
    if (width <= 0 || height <= 0) return [];
    const regions: IHitRegion[] = [];
    const elements = document.querySelectorAll(selector);
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (element !== undefined) regions.push(...normalize(boxesOf(element), width, height));
    }
    warnAboutUnmarkedControls(document, selector, scope, unmarkedWarning);
    return regions;
  };

  const publish = (regions: readonly IHitRegion[]): void => {
    const frame = JSON.stringify(regions);
    if (frame === publishedFrame) return;
    publishedFrame = frame;
    published = regions;
    bridge.post({ type: HIT_REGIONS_MESSAGE, regions });
  };

  const refresh = (): void => {
    if (stopped) return;
    publish(measure());
  };

  const requestFrame = scope.requestAnimationFrame;
  const cancelFrame = scope.cancelAnimationFrame;

  /**
   * While anything is transitioning, the published rect is a frame behind wherever the
   * compositor drew it, so this republishes every frame until the last transition ends. It is
   * deliberately not the steady-state path: a HUD that republishes 60 times a second when
   * nothing moved is a message per frame across a process boundary for no reason.
   */
  const pump = (): void => {
    frameHandle = undefined;
    if (stopped || liveTransitions <= 0) return;
    refresh();
    if (requestFrame !== undefined) frameHandle = requestFrame(pump);
  };

  const onTransitionStart = (): void => {
    liveTransitions += 1;
    if (frameHandle === undefined && requestFrame !== undefined) frameHandle = requestFrame(pump);
  };
  const onTransitionEnd = (): void => {
    liveTransitions = Math.max(0, liveTransitions - 1);
    // One last measurement at the resting position: the final frame of a transition can land
    // after the last rAF this pump scheduled.
    refresh();
  };

  const listen = (
    on: "addEventListener" | "removeEventListener",
    host: IEventTargetLike,
    types: readonly string[],
    listener: () => void,
  ): void => {
    const method = host[on];
    if (typeof method !== "function") return;
    for (const type of types) method.call(host, type, listener, true);
  };

  listen("addEventListener", document, TRANSITION_START, onTransitionStart);
  listen("addEventListener", document, TRANSITION_END, onTransitionEnd);
  listen("addEventListener", scope, LAYOUT_EVENTS, refresh);

  const MutationObserverCtor = scope.MutationObserver as
    | (new (
        callback: () => void,
      ) => IObserverLike)
    | undefined;
  const mutations =
    MutationObserverCtor === undefined ? undefined : new MutationObserverCtor(refresh);
  mutations?.observe(document, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });

  const ResizeObserverCtor = scope.ResizeObserver as
    | (new (
        callback: () => void,
      ) => IObserverLike)
    | undefined;
  const resizes = ResizeObserverCtor === undefined ? undefined : new ResizeObserverCtor(refresh);
  if (resizes !== undefined && document.documentElement !== undefined) {
    resizes.observe(document.documentElement);
  }

  refresh();

  return {
    refresh,
    regions: () => published,
    stop() {
      if (stopped) return;
      stopped = true;
      if (frameHandle !== undefined && cancelFrame !== undefined) cancelFrame(frameHandle);
      frameHandle = undefined;
      listen("removeEventListener", document, TRANSITION_START, onTransitionStart);
      listen("removeEventListener", document, TRANSITION_END, onTransitionEnd);
      listen("removeEventListener", scope, LAYOUT_EVENTS, refresh);
      mutations?.disconnect();
      resizes?.disconnect();
      // Publishing the empty set is the point of stopping: a host still holding the last
      // snapshot would keep eating touches over a UI that is gone.
      published = [];
      publishedFrame = "[]";
      bridge.post({ type: HIT_REGIONS_MESSAGE, regions: [] });
    },
  };
}

/**
 * Controls that look pressable but publish no rectangle, named once in development.
 *
 * The attribute is documented in every template's instructions as the one thing a UI must do
 * differently from a web page, and it is still the easiest thing in this layer to forget: the
 * button renders, `pointer-events-auto` looks like it should be enough, and on web it *is*. The
 * failure only appears on a device, as a button that does nothing, with no error anywhere — the
 * platform handed the gesture to the game before any CSS ran.
 *
 * So the registry says so at the moment the page runs, in the browser, which is where a UI is
 * built. Once per page: a warning repeated every frame is noise, and noise is not read.
 */
const UNMARKED_CONTROL_SELECTOR = 'button, [role="button"], a[href], input, select, textarea';

/** Once per registry, not once per process: two pages in one test run are two pages. */
interface IWarnedOnce {
  warned: boolean;
}

function warnAboutUnmarkedControls(
  document: IDocumentLike,
  selector: string,
  scope: IScopeLike,
  once: IWarnedOnce,
): void {
  if (once.warned || !isDevelopment()) return;
  if (typeof document.querySelectorAll !== "function") return;
  const candidates = document.querySelectorAll(UNMARKED_CONTROL_SELECTOR);
  const unmarked: string[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const element = candidates[index];
    if (element === undefined) continue;
    if (element.closest?.(selector) != null) continue;
    unmarked.push(describe(element));
  }
  if (unmarked.length === 0) return;
  once.warned = true;
  const names = unmarked.slice(0, 5).join(", ");
  const rest = unmarked.length > 5 ? ` and ${unmarked.length - 5} more` : "";
  scope.console?.warn?.(
    `TN_UI_UNMARKED_CONTROLS: ${unmarked.length} control(s) publish no hit region, so on native ` +
      `the press reaches the game instead: ${names}${rest}. Mark each with ` +
      `${INTERACTIVE_ATTRIBUTE}, or wrap them in an element that carries it.`,
  );
}

/** A short, recognisable name for one element: tag, id, and the first class. */
function describe(element: IElementLike): string {
  const tag = (element.tagName ?? "element").toLowerCase();
  const id = element.id === undefined || element.id === "" ? "" : `#${element.id}`;
  const first = (element.className ?? "").split(/\s+/u).filter(Boolean)[0];
  return `<${tag}${id}${first === undefined ? "" : `.${first}`}>`;
}

function isDevelopment(): boolean {
  return (
    (import.meta as ImportMeta & { env?: Record<"DEV", boolean | undefined> }).env?.DEV === true
  );
}
