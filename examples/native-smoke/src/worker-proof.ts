const WORKER_ITERATIONS = 20_000_000;
/**
 * Frames the worker gets to acknowledge and deliver before the proof calls it dead.
 *
 * This is a liveness backstop, not the assertion: the proof waits for an explicit worker
 * acknowledgement, advances two normal frames, and only then dispatches the deterministic
 * computation. That makes frame overlap a protocol invariant instead of a guess about how long a
 * fixed CPU loop takes on a JIT-less host. The bounded loop still catches a bad checksum without
 * making iOS JSC spend the whole four-second delivery window in an interpreter.
 */
const WORKER_DELIVERY_FRAME_BOUND = 240;
const WORKER_SEED = 0x12345678;

export const WORKER_INPUT_CHECKSUM = (WORKER_ITERATIONS ^ WORKER_SEED) >>> 0;
export const WORKER_OUTPUT_CHECKSUM = 2_110_598_008;
export const WORKER_MINIMUM_FRAMES = 2;

const WORKER_SOURCE = `
self.onmessage = function(event) {
  var input = event.data;
  if (input.kind === "start") {
    postMessage({
      kind: "started",
      order: input.order,
      workerIdentity: typeof document === "undefined" ? "dedicated-worker" : "game-thread"
    });
    return;
  }
  if (input.kind !== "compute") throw new Error("unexpected worker proof message");
  console.info("TN_NATIVE_WORKER_PROOF_COMPUTE_ENTER:" + JSON.stringify({ atMs: Date.now(), iterations: input.iterations }));
  var checksum = input.seed >>> 0;
  var iterations = input.iterations;
  var imul = Math.imul;
  for (var index = 0; index < iterations; index += 1) {
    checksum = (imul((checksum ^ index) >>> 0, 1664525) + 1013904223) >>> 0;
  }
  console.info("TN_NATIVE_WORKER_PROOF_COMPUTE_COMPLETE:" + JSON.stringify({ atMs: Date.now(), checksum: checksum }));
  postMessage({
    kind: "result",
    order: input.order,
    inputChecksum: (input.iterations ^ input.seed) >>> 0,
    outputChecksum: checksum,
    workerIdentity: typeof document === "undefined" ? "dedicated-worker" : "game-thread"
  });
  console.info("TN_NATIVE_WORKER_PROOF_RESULT_POSTED:" + JSON.stringify({ atMs: Date.now() }));
  postMessage({ kind: "late", order: input.order + 1 });
};
`;

export interface IWorkerProofResult {
  callbacksAfterTerminate: number;
  completionOrder: number[];
  framesAdvanced: number;
  inputChecksum: number;
  outputChecksum: number;
  sourceForm: "classic-blob";
  workerIdentity: "dedicated-worker";
}

export interface IWorkerProof {
  observeFrame(frame: number): void;
}

interface IWorkerResultMessage {
  inputChecksum: number;
  kind: "result";
  order: number;
  outputChecksum: number;
  workerIdentity: "dedicated-worker" | "game-thread";
}

interface IWorkerStartedMessage {
  kind: "started";
  order: number;
  workerIdentity: "dedicated-worker" | "game-thread";
}

interface IWorkerLateMessage {
  kind: "late";
  order: number;
}

type IWorkerMessage = IWorkerLateMessage | IWorkerResultMessage | IWorkerStartedMessage;

function fail(worker: Worker, reason: string): never {
  const marker = `RED observed: ${reason}`;
  // Native termination joins the worker; record the deadline before that wait can obscure it.
  console.error(`TN_NATIVE_WORKER_PROOF_FAIL:${marker} atMs=${Date.now()}`);
  worker.terminate();
  throw new Error(marker);
}

export function startWorkerProof(
  initialFrame: number,
  onPass: (result: IWorkerProofResult) => void,
): IWorkerProof {
  const sourceUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const worker = new Worker(sourceUrl);
  URL.revokeObjectURL(sourceUrl);

  let callbacksAfterTerminate = 0;
  let completionFrame: number | undefined;
  let currentFrame = initialFrame;
  let result: IWorkerResultMessage | undefined;
  let startedFrame: number | undefined;
  let computeDispatched = false;
  let terminated = false;
  let published = false;

  worker.onerror = (event) => fail(worker, `worker error: ${event.message}`);
  worker.onmessage = (event: MessageEvent<IWorkerMessage>) => {
    if (terminated) {
      callbacksAfterTerminate += 1;
      return;
    }
    if (event.data.kind === "started") {
      if (startedFrame !== undefined) fail(worker, "worker acknowledged start more than once");
      startedFrame = currentFrame;
      console.info(`TN_NATIVE_WORKER_PROOF_STARTED:${JSON.stringify({ frame: currentFrame })}`);
      return;
    }
    if (event.data.kind !== "result") {
      fail(worker, `worker completion order was ${event.data.order}, expected result after start`);
    }
    if (!computeDispatched) {
      fail(worker, "worker completed before the computation was dispatched");
    }
    if (event.data.order !== 2) {
      fail(worker, `worker completion order was ${event.data.order}, expected result second`);
    }
    result = event.data;
    completionFrame = currentFrame;
    terminated = true;
    worker.terminate();
  };

  worker.postMessage({ kind: "start", order: 1 });

  const publishResult = (): void => {
    if (result === undefined || completionFrame === undefined) return;
    if (callbacksAfterTerminate !== 0) {
      fail(worker, `${callbacksAfterTerminate} callback(s) fired after termination`);
    }
    const framesAdvanced = completionFrame - initialFrame;
    if (result.workerIdentity !== "dedicated-worker") {
      fail(worker, "worker executed on the game thread");
    }
    if (framesAdvanced < WORKER_MINIMUM_FRAMES) {
      fail(
        worker,
        `only ${framesAdvanced} frame(s) advanced while worker computation was in flight`,
      );
    }
    if (
      result.inputChecksum !== WORKER_INPUT_CHECKSUM ||
      result.outputChecksum !== WORKER_OUTPUT_CHECKSUM
    ) {
      fail(
        worker,
        `checksum mismatch: input=${result.inputChecksum} output=${result.outputChecksum}`,
      );
    }

    const observation: IWorkerProofResult = {
      callbacksAfterTerminate,
      completionOrder: [result.order],
      framesAdvanced,
      inputChecksum: result.inputChecksum,
      outputChecksum: result.outputChecksum,
      sourceForm: "classic-blob",
      workerIdentity: result.workerIdentity,
    };
    published = true;
    console.info(`TN_NATIVE_WORKER_PROOF_PASS:${JSON.stringify(observation)}`);
    onPass(observation);
  };

  return {
    observeFrame(frame) {
      currentFrame = frame;
      if (published) return;
      if (result === undefined) {
        if (
          startedFrame !== undefined &&
          !computeDispatched &&
          frame - startedFrame >= WORKER_MINIMUM_FRAMES
        ) {
          computeDispatched = true;
          console.info(
            `TN_NATIVE_WORKER_PROOF_COMPUTE_DISPATCH:${JSON.stringify({ frame, atMs: Date.now() })}`,
          );
          worker.postMessage({
            kind: "compute",
            iterations: WORKER_ITERATIONS,
            order: 2,
            seed: WORKER_SEED,
          });
        }
        if (frame - initialFrame >= WORKER_DELIVERY_FRAME_BOUND) {
          // Latch before failing. `fail` throws, the frame loop swallows it, and observeFrame is
          // called again next frame — an iOS run logged this same failure 441,582 times and left a
          // 76MB artifact, which buries the one line that mattered.
          published = true;
          fail(worker, "worker result was not delivered before the frame bound");
        }
        return;
      }
      if (completionFrame === undefined || frame - completionFrame < 2) return;
      publishResult();
    },
  };
}
