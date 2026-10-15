import type { IGamePluginHooks, IGamePluginRuntime } from "./game.js";
import { type IReplayRecording, parseReplayRecording } from "./replay-protocol.js";
import { CORE_VERSION } from "./version.js";
const currentAgent = typeof navigator === "undefined" ? "node" : navigator.userAgent;
type Pointer = readonly [number, number, number, number, number];
type Point = readonly [number, number, number];
type ReplayContext = { renderer?: { domElement: HTMLCanvasElement } };
type Random = NonNullable<IGamePluginRuntime["random"]>;
let replayDepth = 0;
export type Recording = IReplayRecording;
export interface IReplayOptions {
  /** Allow a recording to be replayed by a different host with the same simulation contract. */
  readonly portable?: boolean;
}
function fail(message: string, code = "TN_REPLAY_INVALID"): never {
  throw new Error(`${code}: ${message}`);
}
const event = (type: string, init: object): Event => Object.assign(new Event(type), init);
const pointerEvent = (type: string, [clientX, clientY, buttons]: Point) =>
  event(type, { buttons, clientX, clientY, pointerId: 0 });
function pointerViewport(ctx: ReplayContext, point: Point = [0, 0, 0]): Pointer {
  // Read every tick on purpose: a canvas can move or resize with no observable signal, and a
  // stale offset would silently corrupt recorded pointer coordinates. Only the comparisons
  // below are optimised — tuple fields, not joined strings.
  const canvas = ctx.renderer?.domElement;
  const rect = canvas?.getBoundingClientRect?.();
  return [
    point[0] - (rect?.left ?? 0),
    point[1] - (rect?.top ?? 0),
    point[2],
    canvas?.clientWidth || globalThis.innerWidth || 1,
    canvas?.clientHeight || globalThis.innerHeight || 1,
  ];
}

function samePointer(previous: Pointer, next: Pointer): boolean {
  return (
    previous[0] === next[0] &&
    previous[1] === next[1] &&
    previous[2] === next[2] &&
    previous[3] === next[3] &&
    previous[4] === next[4]
  );
}

function sameKeys(previous: string[], next: string[]): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1)
    if (previous[index] !== next[index]) return false;
  return true;
}
const pointerType = (previous: number, next: number) =>
  previous && !next ? "pointerup" : !previous && next ? "pointerdown" : "pointermove";
function targetPointerPosition(pointer: Pointer, target: EventTarget): Point {
  const viewport = target as unknown as HTMLCanvasElement & Window;
  const rect = viewport.getBoundingClientRect?.();
  const width = viewport.clientWidth || viewport.innerWidth || rect?.width || pointer[3];
  const height = viewport.clientHeight || viewport.innerHeight || rect?.height || pointer[4];
  return [
    (pointer[0] * width) / pointer[3] + (rect?.left ?? 0),
    (pointer[1] * height) / pointer[4] + (rect?.top ?? 0),
    pointer[2],
  ];
}
function dispatchKeys(target: EventTarget, current: Set<string>, keys: readonly string[]): void {
  for (const key of current)
    if (!keys.includes(key)) target.dispatchEvent(event("keyup", { code: key }));
  for (const key of keys)
    if (!current.has(key)) target.dispatchEvent(event("keydown", { code: key }));
  current.clear();
  for (const key of keys) current.add(key);
}
function releasePointer(pointer: Pointer, target: EventTarget): void {
  if (pointer[2] === 0) return;
  const released = [pointer[0], pointer[1], 0, pointer[3], pointer[4]] as Pointer;
  target.dispatchEvent(pointerEvent("pointerup", targetPointerPosition(released, target)));
}
function dispatchPointer(previous: Pointer, next: Pointer, target: EventTarget): Pointer {
  if (previous.join() === next.join()) return previous;
  target.dispatchEvent(
    pointerEvent(pointerType(previous[2], next[2]), targetPointerPosition(next, target)),
  );
  return next;
}
type ReplayPublic = { readonly recording: Recording | undefined; readonly runId: symbol };
export function replay<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
>(options: IReplayOptions = {}): IGamePluginHooks<TState, TPhysics> & ReplayPublic {
  const runId = Symbol("replay");
  const portable = options.portable === true;
  const samples: Array<Recording["input"][number]> = [];
  let header: Omit<Recording, "input" | "ticks"> | undefined;
  let ticks = 0;
  let previousKeys: string[] = [];
  let previousPointer: Pointer = [0, 0, 0, 1, 1];
  return {
    get recording() {
      if (header === undefined) return undefined;
      return {
        ...header,
        input: [...samples],
        ticks,
      };
    },
    runId,
    setup: (ctx, runtime) => {
      if (runtime?.seed === null || runtime?.seed === undefined)
        fail("replay requires a seed", "TN_REPLAY_UNSEEDED");
      const { rapier, seed, step } = runtime;
      header = {
        randomState: ctx.random.state,
        runtime: {
          agent: currentAgent,
          core: CORE_VERSION,
          ...(portable ? { portable: true } : {}),
          rapier: rapier ?? null,
          step,
        },
        seed,
        version: 1,
      };
      samples.length = ticks = 0;
      [previousKeys, previousPointer] = [[], pointerViewport(ctx)];
      return undefined;
    },
    beforeUpdate: (ctx) => {
      if (replayDepth > 0) return;
      const keys = [...ctx.input.raw.keys].sort();
      const { position, buttons } = ctx.input.raw.pointer;
      const pointer = pointerViewport(ctx, [position.x, position.y, buttons]);
      const pointerChanged = !samePointer(previousPointer, pointer);
      if (pointerChanged || !sameKeys(previousKeys, keys)) {
        samples.push({ keys, ...(pointerChanged ? { pointer } : {}), tick: ticks });
        [previousKeys, previousPointer] = [keys, pointer];
      }
      ticks += 1;
    },
  };
}
function validateRuntime(runtime: IGamePluginRuntime, recording: Recording): Random {
  const random = runtime.random;
  if (
    runtime.seed !== recording.seed ||
    runtime.step !== recording.runtime.step ||
    (runtime.rapier ?? null) !== (recording.runtime.rapier ?? null) ||
    recording.runtime.core !== CORE_VERSION ||
    (recording.runtime.portable !== true && recording.runtime.agent !== currentAgent) ||
    random === undefined
  )
    fail("recording runtime does not match the current build", "TN_REPLAY_RUNTIME_MISMATCH");
  return random;
}
function restoreRandomState(random: Random, state: number): Random {
  try {
    random.state = state;
    if (random.state !== state) throw new Error();
  } catch {
    fail("runtime random state cannot be restored", "TN_REPLAY_RUNTIME_MISMATCH");
  }
  return random;
}
export function createReplayDriver(
  recording: Recording,
  target: EventTarget,
  pointerTarget = target,
) {
  const value = parseReplayRecording(recording);
  const samples = new Map(value.input.map((sample) => [sample.tick, sample]));
  let preparedRandom: Pick<Random, "state"> | undefined;
  const driver = Object.assign(
    (runtime: IGamePluginRuntime) => {
      const random = validateRuntime(runtime, value);
      if (preparedRandom !== random) restoreRandomState(random, value.randomState);
      preparedRandom = undefined;
      target.dispatchEvent(new Event("blur"));
      const keys = new Set<string>();
      let pointer: Pointer = [0, 0, 0, 1, 1];
      replayDepth += 1;
      try {
        for (let tick = 0; tick < value.ticks; tick += 1) {
          const sample = samples.get(tick);
          if (sample !== undefined) {
            dispatchKeys(target, keys, sample.keys);
            if (sample.pointer !== undefined)
              pointer = dispatchPointer(pointer, sample.pointer, pointerTarget);
          }
          runtime.fixedStep(1);
        }
        dispatchKeys(target, keys, []);
        releasePointer(pointer, pointerTarget);
        return value.ticks;
      } finally {
        replayDepth -= 1;
      }
    },
    {
      prepare: (runtime: IGamePluginRuntime) => {
        preparedRandom = restoreRandomState(validateRuntime(runtime, value), value.randomState);
      },
      runId: Symbol("replay-driver"),
    },
  );
  return driver;
}
