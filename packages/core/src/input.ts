import { Vector2 } from "three";

/**
 * One action, read either as a button through `pressed`/`justPressed`, a 2D axis through
 * `vector`, or a scalar axis through `axis`. Which one you get depends on the fields you fill in,
 * and mixing the two is what makes bindings confusing to read:
 *
 * ```ts
 * jump: { keys: ["Space"], buttons: [0] }                 // a button: key or *gamepad* button 0
 * fire: { keys: ["Space"], mouseButtons: [0] }            // a button: key or *left mouse*
 * move: { up: ["KeyW"], down: ["KeyS"], left: [...], right: [...] }  // an axis
 * ```
 *
 * **`buttons` is the gamepad, `mouseButtons` is the mouse.** They are separate devices and
 * `buttons: [0]` on a machine with no gamepad plugged in silently never fires.
 *
 * `up`/`down`/`left`/`right` are **directions of an axis**, not "the keys that press this".
 * They are named after the vector they build, so `pressed("move")` is true whenever any
 * direction is held — including `ArrowDown`. For a button, use `keys`.
 */
export interface IInputAction {
  /** **Gamepad** button indices that press this action. For the mouse, see `mouseButtons`. */
  readonly buttons?: readonly number[];
  /** **Gamepad** axis indices whose values contribute to `axis(name)`. */
  readonly gamepadAxes?: readonly number[];
  /**
   * **Mouse** button indices that press this action, numbered as `MouseEvent.button`:
   * `0` left, `1` middle, `2` right. Binding `2` also suppresses the browser context menu on
   * the pointer target, because a right-click binding is unusable while the menu eats it.
   */
  readonly mouseButtons?: readonly number[];
  /**
   * Keyboard codes that press this action. Use this for a button — `jump`, `restart`, `fire`.
   * A key listed here never contributes to `vector`.
   */
  readonly keys?: readonly string[];
  /** The **−y** direction of `vector(name)`. Not "the keys that press this action" — see `keys`. */
  readonly down?: readonly string[];
  /** The −x direction of `vector(name)`. */
  readonly left?: readonly string[];
  /** Any active pointer or touch presses this action. */
  readonly pointer?: boolean;
  /** Add normalized browser/native wheel motion to `axis(name)`; negative DOM deltaY (toward-user) is positive. */
  readonly scroll?: boolean;
  /** Add the signed two-pointer distance change to `axis(name)`; moving apart is positive. */
  readonly pinch?: boolean;
  /**
   * Add raw mouse movement since the last input tick to `vector(name)`. A click on the pointer
   * target automatically asks for pointer capture when this binding is present; call
   * `captureMouse()` explicitly when a game needs to start capture from another named gesture.
   */
  readonly pointerRelative?: boolean;
  /** Disable the automatic click capture for a relative binding that has its own gesture. */
  readonly captureOnClick?: boolean;
  /** The +x direction of `vector(name)`. */
  readonly right?: readonly string[];
  /** The +y direction of `vector(name)`. */
  readonly up?: readonly string[];
}

export type InputBindings = Record<string, IInputAction>;

/**
 * What the browser context menu does over the game surface. `"suppress"` is the default: a
 * right-click binding cannot work while the menu opens on the same press, and a context menu
 * over a game canvas is almost never what anyone wants. `"allow"` restores the browser default.
 */
export type ContextMenuPolicy = "allow" | "suppress";

/**
 * `MouseEvent.button` (0 left, 1 middle, 2 right) to the `PointerEvent.buttons` bit that is set
 * while it is held (1 left, 4 middle, 2 right). The two numbering schemes disagree for the
 * middle and right buttons, which is why this is a table rather than a shift.
 */
const MOUSE_BUTTON_BITS: readonly number[] = [1, 4, 2, 8, 16];

function mouseButtonMask(button: number): number {
  return MOUSE_BUTTON_BITS[button] ?? 0;
}

export interface IInputGamepad {
  readonly axes: ArrayLike<number>;
  readonly buttons: readonly { readonly pressed: boolean }[];
}

export type InputPlatformSource = () => readonly (IInputGamepad | null)[];

export interface IRawInputPointer {
  readonly id: number;
  buttons: number;
  readonly position: Vector2;
}

export interface IRawInputPointerEdge {
  readonly buttons: number;
  readonly id: number;
  readonly position: Vector2;
  readonly type: "cancel" | "down" | "up";
}

export interface IRawInputState {
  readonly keys: ReadonlySet<string>;
  readonly pointer: {
    buttons: number;
    captured: boolean;
    down: boolean;
    readonly position: Vector2;
    /** Accumulated relative mouse motion since the last `tick`, in canvas pixels. */
    readonly relative: Vector2;
  };
  /** Pointer transitions captured since the previous input tick, grouped by pointer id. */
  readonly pointerEdges: ReadonlyMap<number, readonly IRawInputPointerEdge[]>;
  readonly pointers: ReadonlyMap<number, IRawInputPointer>;
  readonly gamepad: {
    axes: readonly number[];
    buttons: readonly boolean[];
  };
}

const DEFAULT_BINDINGS: InputBindings = {
  move: {
    down: ["KeyS", "ArrowDown"],
    left: ["KeyA", "ArrowLeft"],
    right: ["KeyD", "ArrowRight"],
    up: ["KeyW", "ArrowUp"],
  },
};

const WHEEL_LINE_PIXELS = 16;
const WHEEL_PAGE_PIXELS = 800;
const WHEEL_PIXELS_PER_AXIS = 100;
const PINCH_DEAD_ZONE = 0.01;

function eventCode(event: Event): string | undefined {
  const candidate = event as Event & { code?: string; key?: string };
  return candidate.code ?? candidate.key;
}

type PointerLockTarget = EventTarget & {
  exitPointerLock?: () => void | Promise<void>;
  requestPointerLock?: () => void | Promise<void>;
};

type PointerLockDocument = EventTarget & {
  exitPointerLock?: () => void | Promise<void>;
  pointerLockElement?: unknown;
};

function pointerLockDocument(): PointerLockDocument | undefined {
  const candidate = (globalThis as typeof globalThis & { document?: unknown }).document;
  if (candidate === null || typeof candidate !== "object") return undefined;
  if (typeof (candidate as { addEventListener?: unknown }).addEventListener !== "function") {
    return undefined;
  }
  return candidate as PointerLockDocument;
}

const browserGamepads: InputPlatformSource = () =>
  (globalThis.navigator as Navigator | undefined)?.getGamepads?.() ?? [];

/**
 * Ask the browser to lock the pointer to `target`, the capture every first-person mouse look needs.
 *
 * Returns the platform's own promise when it has one, so the caller can wait for the lock the way
 * the browser reports it, and `undefined` when the platform answered synchronously. A target that
 * cannot capture at all throws rather than leaving a game with a camera that never turns.
 */
export function captureMouse(target: EventTarget): Promise<void> | undefined {
  const lockTarget = target as PointerLockTarget;
  if (typeof lockTarget.requestPointerLock !== "function") {
    throw new Error("Pointer capture is unavailable on the input target.");
  }
  const result = lockTarget.requestPointerLock();
  return result === undefined ? undefined : Promise.resolve(result);
}

export class InputMap {
  readonly raw: IRawInputState;
  #bindings: InputBindings;
  #bindingNames: string[] = [];
  #vectors = new Map<string, Vector2>();
  #target: EventTarget;
  #heldKeys = new Set<string>();
  #pointerPosition = new Vector2();
  #pointerRelative = new Vector2();
  #relativeSample = new Vector2();
  #scrollDelta = 0;
  #scrollSample = 0;
  #pointerButtons = 0;
  #pointers = new Map<number, IRawInputPointer>();
  #pointerEdges = new Map<number, readonly IRawInputPointerEdge[]>();
  #pendingPointerEdges = new Map<number, IRawInputPointerEdge[]>();
  #pinchPair: readonly [number, number] | undefined;
  #pinchDistance = 0;
  #pinchSample = 0;
  #gamepadAxes: number[] = [];
  #gamepadButtons: boolean[] = [];
  #previousPressed = new Map<string, boolean>();
  #justPressed = new Set<string>();
  #justReleased = new Set<string>();
  /**
   * Presses seen since the last `tick`, kept even if the input was already released.
   *
   * Device state alone is sampled once a frame, so a press that starts and ends between two
   * ticks is simply not there when the frame looks — and a mouse click is normally shorter than
   * a frame at 60Hz. Without this latch a quick click does nothing at all, intermittently,
   * which reads as a broken game rather than a dropped edge.
   */
  #latchedKeys = new Set<string>();
  #latchedPointerButtons = 0;
  #latchedPointer = false;
  #pointerTarget: EventTarget;
  #source: InputPlatformSource;
  #tracksPinch = false;
  #listeners: Array<[EventTarget, string, EventListener]> = [];

  constructor(
    bindings: InputBindings = DEFAULT_BINDINGS,
    target: EventTarget = globalThis,
    pointerTarget: EventTarget = target,
    source: InputPlatformSource = browserGamepads,
    contextMenu: ContextMenuPolicy = "suppress",
  ) {
    this.#bindings = { ...DEFAULT_BINDINGS, ...bindings };
    // Bindings are fixed at construction; freezing the key list keeps tick() from calling
    // Object.keys every step.
    this.#bindingNames = Object.keys(this.#bindings);
    this.#target = target;
    this.#pointerTarget = pointerTarget;
    this.#source = source;
    this.#tracksPinch = this.#bindingNames.some((name) => this.#bindings[name]?.pinch === true);
    this.raw = {
      gamepad: { axes: this.#gamepadAxes, buttons: this.#gamepadButtons },
      keys: this.#heldKeys,
      pointer: {
        buttons: this.#pointerButtons,
        captured: false,
        down: false,
        position: this.#pointerPosition,
        relative: this.#pointerRelative,
      },
      pointerEdges: this.#pointerEdges,
      pointers: this.#pointers,
    };
    this.#listen(this.#target, "keydown", (event) => {
      const code = eventCode(event);
      if (code !== undefined) {
        this.#heldKeys.add(code);
        this.#latchedKeys.add(code);
      }
    });
    this.#listen(this.#target, "keyup", (event) => {
      const code = eventCode(event);
      if (code !== undefined) this.#heldKeys.delete(code);
    });
    this.#listen(this.#target, "mousemove", (event) => this.#mouseEvent(event));
    if (
      this.#bindingNames.some(
        (name) =>
          this.#bindings[name]?.pointerRelative === true &&
          this.#bindings[name]?.captureOnClick !== false,
      )
    ) {
      this.#listen(this.#pointerTarget, "click", (event) => {
        // Touch and pen gestures must not enter desktop relative-mouse mode.
        const pointerType = (event as PointerEvent).pointerType;
        if (pointerType && pointerType !== "mouse") return;
        this.#captureFromClick();
      });
    }
    this.#listen(this.#pointerTarget, "pointerdown", (event) => this.#pointerEvent(event, "down"));
    if (this.#bindingNames.some((name) => this.#bindings[name]?.scroll === true))
      this.#listen(this.#target, "wheel", (event) => this.#wheelEvent(event));
    this.#listen(this.#pointerTarget, "pointermove", (event) => this.#pointerEvent(event));
    this.#listen(this.#pointerTarget, "pointerup", (event) => this.#pointerEvent(event, "up"));
    this.#listen(this.#pointerTarget, "pointercancel", (event) =>
      this.#pointerEvent(event, "cancel"),
    );
    this.#listen(this.#target, "blur", () => this.clear());
    // The browser context menu is suppressed on the game surface by default. A right-click
    // binding is simply unusable while the menu eats the press, and no game yet built here has
    // wanted the menu over its own canvas. `contextMenu: "allow"` restores the browser default
    // for the rare case that does.
    if (contextMenu !== "allow") {
      this.#listen(this.#pointerTarget, "contextmenu", (event) => event.preventDefault());
    }
    const lockDocument = pointerLockDocument();
    const lockTargets = new Set<EventTarget>([this.#target, this.#pointerTarget]);
    if (lockDocument !== undefined) lockTargets.add(lockDocument);
    for (const target of lockTargets) {
      this.#listen(target, "pointerlockchange", () => this.#syncCaptured());
    }
  }

  /**
   * Returns a 2D action vector where +y is up. On a conventional XZ ground plane whose
   * forward direction is -z, map `vector.y` to `-z`. This differs from Godot's
   * `Input.get_vector`, where up is -y.
   */
  vector(name: string): Vector2 {
    let vector = this.#vectors.get(name);
    if (vector === undefined) {
      vector = new Vector2();
      this.#vectors.set(name, vector);
    }
    const binding = this.#bindings[name];
    if (binding === undefined) return vector.set(0, 0);
    vector.set(this.#isHeld(binding.left) ? -1 : 0, this.#isHeld(binding.down) ? -1 : 0);
    if (this.#isHeld(binding.right)) vector.x += 1;
    if (this.#isHeld(binding.up)) vector.y += 1;
    if (name === "move" && this.#gamepadAxes.length >= 2) {
      vector.x += this.#gamepadAxes[0] ?? 0;
      vector.y += -(this.#gamepadAxes[1] ?? 0);
    }
    if (binding.pointerRelative === true) vector.add(this.#relativeSample);
    return binding.pointerRelative === true ? vector : vector.clampLength(0, 1);
  }

  /**
   * Returns a scalar action for this fixed-step tick, clamped to `[-1, 1]`.
   *
   * `scroll: true` normalizes wheel deltas to pixels before scaling them: one line is 16 pixels,
   * one page is 800 pixels, and 100 pixels is one axis unit. Browser and native wheel events use
   * the same DOM sign convention, so scrolling the wheel toward the user (negative DOM `deltaY`) is
   * positive and scrolling away (positive DOM `deltaY`) is negative. `pinch: true` reports the relative distance change of the first two active pointers;
   * a third pointer is ignored and a changing pair starts a new gesture without a jump.
   */
  axis(name: string): number {
    const binding = this.#bindings[name];
    if (binding === undefined) return 0;
    let value = 0;
    if (binding.scroll === true) value += this.#scrollSample;
    if (binding.pinch === true) value += this.#pinchSample;
    const axes = binding.gamepadAxes;
    if (axes !== undefined) {
      for (let index = 0; index < axes.length; index += 1) {
        const axisIndex = axes[index] as number;
        const axis = this.#gamepadAxes[axisIndex];
        if (axis !== undefined && Number.isFinite(axis)) value += axis;
      }
    }
    return Math.max(-1, Math.min(1, value));
  }

  /** Request pointer capture explicitly from a named game gesture. Relative bindings request it on canvas click by default. */
  captureMouse(): void {
    if (this.raw.pointer.captured) return;
    const result = captureMouse(this.#pointerTarget);
    if (result === undefined) {
      this.#syncCaptured(true);
      return;
    }
    void result.then(
      () => this.#syncCaptured(true),
      (error: unknown) => {
        this.raw.pointer.captured = false;
        throw error;
      },
    );
  }

  /** Release pointer capture. A browser refusal remains an unhandled rejection. */
  releaseMouse(): void {
    const document = pointerLockDocument();
    const target = (document ?? this.#pointerTarget) as PointerLockTarget;
    const exit = target.exitPointerLock;
    if (typeof exit !== "function") {
      throw new Error("Pointer capture release is unavailable on the input target.");
    }
    const result = exit.call(target);
    if (result === undefined) {
      this.#syncCaptured(false);
      return;
    }
    void result.then(
      () => this.#syncCaptured(false),
      (error: unknown) => {
        throw error;
      },
    );
  }

  pressed(name: string): boolean {
    const binding = this.#bindings[name];
    if (binding === undefined) return false;
    if (
      this.#isHeld(binding.keys) ||
      this.#isHeld(binding.down) ||
      this.#isHeld(binding.left) ||
      this.#isHeld(binding.right) ||
      this.#isHeld(binding.up) ||
      (binding.pointer === true && this.#pointers.size > 0)
    )
      return true;
    const mouseButtons = binding.mouseButtons;
    if (mouseButtons !== undefined) {
      for (let index = 0; index < mouseButtons.length; index += 1) {
        if ((this.#pointerButtons & mouseButtonMask(mouseButtons[index] as number)) !== 0)
          return true;
      }
    }
    const gamepadButtons = binding.buttons;
    if (gamepadButtons !== undefined) {
      for (let index = 0; index < gamepadButtons.length; index += 1) {
        if (this.#gamepadButtons[gamepadButtons[index] as number] === true) return true;
      }
    }
    return false;
  }

  justPressed(name: string): boolean {
    return this.#justPressed.has(name);
  }

  justReleased(name: string): boolean {
    return this.#justReleased.has(name);
  }

  tick(): void {
    this.#publishPointerEdges();
    this.#relativeSample.copy(this.#pointerRelative);
    this.#pointerRelative.set(0, 0);
    this.#scrollSample = this.#clampAxis(this.#scrollDelta);
    this.#scrollDelta = 0;
    this.#samplePinch();
    const sources = this.#source();
    let gamepad: IInputGamepad | undefined;
    for (let index = 0; index < sources.length; index += 1) {
      const candidate = sources[index];
      if (candidate !== null) {
        gamepad = candidate;
        break;
      }
    }
    // Reused buffers: fresh arrays here were four allocations per update step, device or not.
    this.#gamepadAxes.length = 0;
    this.#gamepadButtons.length = 0;
    if (gamepad?.axes) {
      const axes = gamepad.axes;
      for (let axis = 0; axis < axes.length; axis += 1)
        this.#gamepadAxes.push(axes[axis] as number);
    }
    if (gamepad?.buttons) {
      for (let index = 0; index < gamepad.buttons.length; index += 1)
        this.#gamepadButtons.push(gamepad.buttons[index]?.pressed ?? false);
    }
    this.raw.gamepad.axes = this.#gamepadAxes;
    this.raw.gamepad.buttons = this.#gamepadButtons;
    this.#justPressed.clear();
    this.#justReleased.clear();
    for (let index = 0; index < this.#bindingNames.length; index += 1) {
      const name = this.#bindingNames[index] as string;
      // A press that came and went inside this frame still counts as a press. `pressed()` stays
      // instantaneous — it answers "is it down right now" — while the edge is latched, so a tap
      // reports justPressed on this frame and justReleased on the next one.
      const current = this.pressed(name) || this.#latchedPressed(name);
      const previous = this.#previousPressed.get(name) ?? false;
      if (current && !previous) this.#justPressed.add(name);
      if (!current && previous) this.#justReleased.add(name);
      this.#previousPressed.set(name, current);
    }
    this.#latchedKeys.clear();
    this.#latchedPointerButtons = 0;
    this.#latchedPointer = false;
  }

  clear(): void {
    this.#heldKeys.clear();
    this.#latchedKeys.clear();
    this.#latchedPointerButtons = 0;
    this.#latchedPointer = false;
    this.#pointerEdges.clear();
    this.#pendingPointerEdges.clear();
    this.#pointers.clear();
    this.#pointerButtons = 0;
    this.#pointerPosition.set(0, 0);
    this.#pointerRelative.set(0, 0);
    this.#relativeSample.set(0, 0);
    this.#scrollDelta = 0;
    this.#scrollSample = 0;
    this.raw.pointer.buttons = 0;
    this.raw.pointer.down = false;
    this.#pinchPair = undefined;
    this.#pinchDistance = 0;
    this.#pinchSample = 0;
    this.#previousPressed.clear();
    this.#justPressed.clear();
    this.#justReleased.clear();
  }

  dispose(): void {
    if (this.raw.pointer.captured) {
      try {
        this.releaseMouse();
      } catch {
        this.raw.pointer.captured = false;
      }
    }
    for (const [target, type, listener] of this.#listeners)
      target.removeEventListener(type, listener);
    this.#listeners = [];
    this.clear();
  }

  /** Was this action pressed at any point since the last tick, even if already released? */
  #latchedPressed(name: string): boolean {
    const binding = this.#bindings[name];
    if (binding === undefined) return false;
    if (
      this.#isLatched(binding.keys) ||
      this.#isLatched(binding.down) ||
      this.#isLatched(binding.left) ||
      this.#isLatched(binding.right) ||
      this.#isLatched(binding.up) ||
      (binding.pointer === true && this.#latchedPointer)
    )
      return true;
    const mouseButtons = binding.mouseButtons;
    if (mouseButtons !== undefined) {
      for (let index = 0; index < mouseButtons.length; index += 1) {
        if ((this.#latchedPointerButtons & mouseButtonMask(mouseButtons[index] as number)) !== 0)
          return true;
      }
    }
    return false;
  }

  #isHeld(codes: readonly string[] | undefined): boolean {
    if (codes === undefined) return false;
    for (let index = 0; index < codes.length; index += 1) {
      if (this.#heldKeys.has(codes[index] as string)) return true;
    }
    return false;
  }

  #isLatched(codes: readonly string[] | undefined): boolean {
    if (codes === undefined) return false;
    for (let index = 0; index < codes.length; index += 1) {
      if (this.#latchedKeys.has(codes[index] as string)) return true;
    }
    return false;
  }

  #listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.#listeners.push([target, type, listener]);
  }

  #publishPointerEdges(): void {
    this.#pointerEdges.clear();
    for (const [id, edges] of this.#pendingPointerEdges) this.#pointerEdges.set(id, edges);
    this.#pendingPointerEdges.clear();
  }

  #mouseEvent(event: Event): void {
    const mouse = event as MouseEvent;
    if (Number.isFinite(mouse.movementX)) this.#pointerRelative.x += mouse.movementX;
    if (Number.isFinite(mouse.movementY)) this.#pointerRelative.y += mouse.movementY;
  }

  #wheelEvent(event: Event): void {
    // The game's wheel listener lives on the window so a game with no HUD still zooms anywhere.
    // A wheel that landed on a DOM overlay (a scrollable settings list, say) belongs to that
    // overlay: bubbling it into the game would zoom the camera while the player scrolls the HUD.
    const eventTarget = event.target;
    if (
      eventTarget !== null &&
      eventTarget !== undefined &&
      eventTarget !== this.#target &&
      eventTarget !== this.#pointerTarget
    )
      return;
    const wheel = event as Event & { deltaMode?: number; deltaY?: number };
    const deltaY = wheel.deltaY;
    if (deltaY === undefined || !Number.isFinite(deltaY)) return;
    const deltaMode = wheel.deltaMode;
    const pixelsPerDelta =
      deltaMode === 1 ? WHEEL_LINE_PIXELS : deltaMode === 2 ? WHEEL_PAGE_PIXELS : 1;
    this.#scrollDelta += (-deltaY * pixelsPerDelta) / WHEEL_PIXELS_PER_AXIS;
  }

  #samplePinch(): void {
    if (!this.#tracksPinch) return;
    const pointers = this.#pointers.values();
    const first = pointers.next().value as IRawInputPointer | undefined;
    const second = pointers.next().value as IRawInputPointer | undefined;
    if (first === undefined || second === undefined) {
      this.#pinchPair = undefined;
      this.#pinchDistance = 0;
      this.#pinchSample = 0;
      return;
    }

    const distance = first.position.distanceTo(second.position);
    const pair = this.#pinchPair;
    if (
      pair === undefined ||
      pair[0] !== first.id ||
      pair[1] !== second.id ||
      !Number.isFinite(distance)
    ) {
      this.#pinchPair = [first.id, second.id];
      this.#pinchDistance = distance;
      this.#pinchSample = 0;
      return;
    }

    const previousDistance = this.#pinchDistance;
    this.#pinchDistance = distance;
    if (previousDistance <= 0 || !Number.isFinite(previousDistance)) {
      this.#pinchSample = 0;
      return;
    }
    const delta = distance / previousDistance - 1;
    this.#pinchSample = Math.abs(delta) <= PINCH_DEAD_ZONE ? 0 : this.#clampAxis(delta);
  }

  #clampAxis(value: number): number {
    return Math.max(-1, Math.min(1, value));
  }

  #syncCaptured(fallback?: boolean): void {
    const document = pointerLockDocument();
    if (document?.pointerLockElement !== undefined) {
      this.raw.pointer.captured = document.pointerLockElement === this.#pointerTarget;
    } else if (fallback !== undefined) {
      this.raw.pointer.captured = fallback;
    }
  }

  #captureFromClick(): void {
    this.captureMouse();
  }

  #pointerEvent(event: Event, edgeType?: IRawInputPointerEdge["type"]): void {
    const pointer = event as PointerEvent;
    const id = pointer.pointerId ?? 0;
    const buttons = pointer.buttons ?? 0;
    const x = pointer.clientX ?? 0;
    const y = pointer.clientY ?? 0;
    this.#recordPointerEdge(id, buttons, x, y, edgeType);
    if (buttons !== 0) this.#latchedPointerButtons |= buttons;
    if (edgeType === "down") this.#latchedPointer = true;
    const tracked = this.#pointers.get(id);
    if (edgeType === "down") {
      if (tracked === undefined) {
        this.#pointers.set(id, { buttons, id, position: new Vector2(x, y) });
      } else {
        tracked.buttons = buttons;
        tracked.position.set(x, y);
      }
    } else if (edgeType === "up" || edgeType === "cancel") {
      this.#pointers.delete(id);
    } else if (tracked !== undefined) {
      tracked.buttons = buttons;
      tracked.position.set(x, y);
    }
    const primary = this.#pointers.values().next().value as IRawInputPointer | undefined;
    if (primary !== undefined) {
      this.#pointerButtons = primary.buttons;
      this.#pointerPosition.copy(primary.position);
    } else if (edgeType === undefined || tracked !== undefined) {
      this.#pointerButtons = buttons;
      this.#pointerPosition.set(x, y);
    }
    this.raw.pointer.buttons = this.#pointerButtons;
    this.raw.pointer.down = primary !== undefined;
    const capture = this.#pointerTarget as EventTarget & {
      releasePointerCapture?: (id: number) => void;
      setPointerCapture?: (id: number) => void;
    };
    // Browser conformance injects untrusted PointerEvents with dispatchEvent(). Chromium
    // rejects pointer capture for those events because no physical pointer is active.
    // Real browser input remains captured; native hosts may omit isTrusted and keep their stub.
    if (pointer.isTrusted !== false) {
      try {
        if (edgeType === "down") capture.setPointerCapture?.(id);
        if (edgeType === "up" || edgeType === "cancel") capture.releasePointerCapture?.(id);
      } catch (error) {
        // A pointer-lock transition can make a trusted event temporarily uncapturable.
        if (!(error instanceof Error && error.name === "InvalidStateError")) throw error;
      }
    }
  }

  #recordPointerEdge(
    id: number,
    buttons: number,
    x: number,
    y: number,
    edgeType: IRawInputPointerEdge["type"] | undefined,
  ): void {
    if (edgeType === undefined) return;
    let edges = this.#pendingPointerEdges.get(id);
    if (edges === undefined) {
      edges = [];
      this.#pendingPointerEdges.set(id, edges);
    }
    edges.push({ buttons, id, position: new Vector2(x, y), type: edgeType });
  }
}
