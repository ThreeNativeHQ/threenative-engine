// Pure workload fixture for the selected checkout's coalesced state store. It imports no benchmark
// library; the Labs adapter and the focused tests both consume it. The real `createGameStore` is
// imported from the selected checkout, and its actual `zustand/vanilla` dependency resolves from
// that checkout's own tree.
import { importSelectedSource } from "./selected-source.js";

export interface IStateCase {
  readonly name: string;
  readonly subscribers: number;
}

export const STATE_ZERO: IStateCase = { name: "0 subscribers", subscribers: 0 };
export const STATE_ONE: IStateCase = { name: "1 subscriber", subscribers: 1 };
export const STATE_MANY: IStateCase = { name: "32 subscribers", subscribers: 32 };
export const STATE_CASES: readonly IStateCase[] = [STATE_ZERO, STATE_ONE, STATE_MANY];

/** Coalesced writes followed by one explicit flush in every measured unit. */
export const STATE_WRITES = 32;

type StoreShape = { value: number };

interface IGameStore {
  getState(): StoreShape;
  getPublishedState(): StoreShape;
  set(patch: Partial<StoreShape>): void;
  flush(): void;
  subscribe(listener: (state: StoreShape) => void): () => void;
  stop(): void;
}

interface IStateModule {
  createGameStore(initial: StoreShape, intervalMs?: number): IGameStore;
}

export interface IStateWorkload {
  run(): number;
  verify(): void;
  dispose(): void;
}

function assertEqual(actual: number, expected: number, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

export async function createStateWorkload(
  stateCase: IStateCase,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IStateWorkload> {
  const core = await importSelectedSource<IStateModule>("packages/core/src/state.ts", env);
  const store = core.createGameStore({ value: 0 });
  const immediateIdentity = store.getState();

  let notifications = 0;
  const listeners: Array<() => void> = [];
  for (let index = 0; index < stateCase.subscribers; index++) {
    listeners.push(
      store.subscribe(() => {
        notifications += 1;
      }),
    );
  }

  let writes = 0;
  let last = {
    immediateBeforeFlush: 0,
    notifications: 0,
    publishedAfterFlush: 0,
    publishedBeforeFlush: 0,
    writes: 0,
  };

  return {
    dispose(): void {
      for (const unsubscribe of listeners) unsubscribe();
      listeners.length = 0;
      store.stop();
    },
    run(): number {
      const before = notifications;
      for (let index = 0; index < STATE_WRITES; index++) {
        writes += 1;
        store.set({ value: writes });
      }
      const immediateBeforeFlush = store.getState().value;
      const publishedBeforeFlush = store.getPublishedState().value;
      store.flush();
      last = {
        immediateBeforeFlush,
        notifications: notifications - before,
        publishedAfterFlush: store.getPublishedState().value,
        publishedBeforeFlush,
        writes,
      };
      return last.publishedAfterFlush;
    },
    verify(): void {
      assertEqual(last.immediateBeforeFlush, last.writes, "immediate read before the flush");
      assertEqual(last.publishedBeforeFlush, last.writes - STATE_WRITES, "coalesced publication");
      assertEqual(last.publishedAfterFlush, last.writes, "published value after the flush");
      assertEqual(last.notifications, stateCase.subscribers, "publication notifications");
      if (store.getState() !== immediateIdentity) {
        throw new Error("the immediate snapshot identity changed across writes");
      }
    },
  };
}
