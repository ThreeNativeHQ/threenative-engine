/**
 * Engine-installed `onBeforeRender` / `onAfterRender` callbacks, and the one place that knows
 * which of them are the engine's own.
 *
 * The scene-render projection declines a frame when an object carries a render hook, because three
 * hands the callback the object it is about to draw and neither a batch nor a proxy can hand back
 * the game's own object. That is right for a *game* hook and wrong for the engine's: `WorldCells`
 * borrows `onBeforeRender` on each prewarmed batch to count its first submitted draw, so on a
 * streamed world almost every batch is "hooked" and the projection never engages at all — the very
 * collapse it exists for.
 *
 * A borrow marked here is bookkeeping about the draw, not a claim on the object, so the mirror is
 * free to fold it. Anything unmarked is the game's and still blocks the frame.
 */
const engineRenderHooks = new WeakSet<object>();

/** Mark a render callback the engine installed on an object as its own bookkeeping. */
export function markEngineRenderHook(hook: unknown): void {
  if (typeof hook === "function") engineRenderHooks.add(hook);
}

/** True when `hook` is an engine-installed render callback rather than the game's own. */
export function isEngineRenderHook(hook: unknown): boolean {
  return typeof hook === "function" && engineRenderHooks.has(hook);
}

function hasRenderHookSetter(object: object, prop: "onBeforeRender" | "onAfterRender"): boolean {
  let proto: object | null = Object.getPrototypeOf(object);
  while (proto !== null) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc !== undefined) return typeof desc.set === "function";
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Snapshot whether `object` carries a prior render hook before a temporary engine borrow.
 *
 * Plain three keeps a data no-op on `Object3D.prototype`, so only an own property is a hook;
 * `three-native` exposes a prototype getter/setter returning `null` until a function is assigned,
 * so `Object.hasOwn` is false even when a hook is installed.
 */
export function captureRenderHook(
  object: object,
  prop: "onBeforeRender" | "onAfterRender",
): { readonly hadOwn: boolean; readonly own: unknown } {
  const current = Reflect.get(object, prop) as unknown;
  const hadOwn =
    (Object.hasOwn(object, prop) && current !== undefined) ||
    (hasRenderHookSetter(object, prop) && typeof current === "function");
  return { hadOwn, own: hadOwn ? current : undefined };
}

/**
 * Restore `onBeforeRender` or `onAfterRender` after a temporary engine borrow.
 *
 * On plain three, deleting the own property restores the prototype no-op function (an own
 * `undefined` would shadow it and throw). On `three-native`, `delete` against a prototype setter
 * is a no-op that leaks the callback in C++, so `null` must be written through the setter.
 */
export function restoreRenderHook(
  object: object,
  prop: "onBeforeRender" | "onAfterRender",
  hadOwn: boolean,
  own: unknown,
): void {
  if (hadOwn) {
    Reflect.set(object, prop, own);
    return;
  }
  if (hasRenderHookSetter(object, prop)) Reflect.set(object, prop, null);
  else Reflect.deleteProperty(object, prop);
}
