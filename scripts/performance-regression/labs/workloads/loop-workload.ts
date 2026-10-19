// Pure workload fixture for the selected checkout's fixed-step loop and callback dispatch. It
// imports no benchmark library; the Labs adapter and the focused tests both consume it. Only
// measurement subjects are imported — the loop and phase implementation itself is never copied.
import { importSelectedSource } from "./selected-source.js";

export interface ILoopCase {
  readonly name: string;
  readonly callbacks: number;
}

export const LOOP_ZERO: ILoopCase = { callbacks: 0, name: "dispatch 0" };
export const LOOP_SMALL: ILoopCase = { callbacks: 32, name: "dispatch 32" };
export const LOOP_LARGE: ILoopCase = { callbacks: 256, name: "dispatch 256" };
export const LOOP_CASES: readonly ILoopCase[] = [LOOP_ZERO, LOOP_SMALL, LOOP_LARGE];

/** Fixed steps in one measured unit. */
export const LOOP_FRAMES = 120;

/**
 * 1/64 s is exact in binary, so one `stepFrame` at a 1000/64 ms interval advances exactly one step
 * with no accumulator drift. A 1/60 step rounds, and over 120 frames the real accumulator can then
 * miss or repeat an update, which would make the correctness count flaky rather than fixed.
 */
const STEP = 1 / 64;
const STEP_MS = 1000 / 64;

interface IAfterPhysicsPhase {
  clear(): void;
  register(callback: (dt: number) => void): () => void;
  run(dt: number): void;
}

interface IFixedStepLoop {
  tick(): number;
  start(now?: number): void;
  stop(): void;
  stepFrame(now: number): number;
}

interface IFixedStepLoopOptions {
  readonly step?: number;
  readonly maxSteps?: number;
  readonly onUpdate: (dt: number) => void;
  readonly onAfterPhysics?: (dt: number) => void;
  readonly requestFrame?: (callback: (time: number) => void) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly now?: () => number;
}

interface ILoopModule {
  readonly FixedStepLoop: new (options: IFixedStepLoopOptions) => IFixedStepLoop;
  createAfterPhysicsPhase(): IAfterPhysicsPhase;
}

export interface ILoopWorkload {
  run(): number;
  verify(): void;
  dispose(): void;
}

function assertEqual(actual: number, expected: number, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

/** Exercise registration, ordering, removal and input validation of the real dispatch phase. */
function checkDispatchSemantics(core: ILoopModule): void {
  const phase = core.createAfterPhysicsPhase();
  const order: number[] = [];
  const removeFirst = phase.register(() => order.push(1));
  phase.register(() => order.push(2));
  phase.run(STEP);
  if (order.join(",") !== "1,2") throw new Error(`dispatch order was [${order.join(",")}]`);
  removeFirst();
  order.length = 0;
  phase.run(STEP);
  if (order.join(",") !== "2") throw new Error("a removed callback was still dispatched");
  phase.clear();
  order.length = 0;
  phase.run(STEP);
  if (order.length !== 0) throw new Error("clear left callbacks registered");
  let rejected = false;
  try {
    phase.run(0);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("the dispatch phase accepted a non-positive dt");
}

export async function createLoopWorkload(
  loopCase: ILoopCase,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ILoopWorkload> {
  const core = await importSelectedSource<ILoopModule>("packages/core/src/loop.ts", env);
  checkDispatchSemantics(core);

  const phase = core.createAfterPhysicsPhase();
  let dispatched = 0;
  let checksum = 0;
  let observedDt = STEP;
  for (let index = 0; index < loopCase.callbacks; index++) {
    const id = index;
    phase.register((dt) => {
      dispatched += 1;
      checksum += id;
      if (id === 0) observedDt = dt;
    });
  }

  let updates = 0;
  const loop = new core.FixedStepLoop({
    maxSteps: 1,
    now: () => 0,
    onAfterPhysics: (dt) => phase.run(dt),
    onUpdate: () => {
      updates += 1;
    },
    requestFrame: () => 0,
    step: STEP,
  });
  let clock = 0;
  loop.start(clock);

  const expectedChecksum = LOOP_FRAMES * ((loopCase.callbacks * (loopCase.callbacks - 1)) / 2);
  let lastUpdates = 0;
  let lastTick = 0;
  let lastDispatched = 0;
  let lastChecksum = 0;

  return {
    dispose(): void {
      phase.clear();
      loop.stop();
    },
    run(): number {
      const startUpdates = updates;
      const startTick = loop.tick();
      const startDispatched = dispatched;
      const startChecksum = checksum;
      for (let frame = 0; frame < LOOP_FRAMES; frame++) {
        clock += STEP_MS;
        loop.stepFrame(clock);
      }
      lastUpdates = updates - startUpdates;
      lastTick = loop.tick() - startTick;
      lastDispatched = dispatched - startDispatched;
      lastChecksum = checksum - startChecksum;
      return lastUpdates;
    },
    verify(): void {
      assertEqual(lastUpdates, LOOP_FRAMES, "updates per run");
      assertEqual(lastTick, LOOP_FRAMES, "counted ticks per run");
      assertEqual(lastDispatched, LOOP_FRAMES * loopCase.callbacks, "dispatches per run");
      assertEqual(lastChecksum, expectedChecksum, "dispatch checksum");
      if (loopCase.callbacks > 0 && observedDt !== STEP) {
        throw new Error(`callback dt drifted from the fixed step: ${observedDt}`);
      }
    },
  };
}
