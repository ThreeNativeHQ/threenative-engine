import { afterEach, expect, it, vi } from "vitest";
import { WORKER_INPUT_CHECKSUM, WORKER_OUTPUT_CHECKSUM, startWorkerProof } from "./worker-proof.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const events: string[] = [];
  class WorkerStub {
    static instances: WorkerStub[] = [];
    onmessage: ((event: MessageEvent) => void) | undefined;
    postMessage = vi.fn();
    terminate = vi.fn(() => events.push("terminate"));
    constructor() {
      WorkerStub.instances.push(this);
    }
  }
  vi.stubGlobal("Worker", WorkerStub);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation((message) => events.push(String(message)));
  const passed = vi.fn();
  const proof = startWorkerProof(10, passed);
  const worker = WorkerStub.instances[0];
  if (!worker) throw new Error("proof did not construct its worker");
  const message = (data: unknown) => worker.onmessage?.({ data } as MessageEvent);
  proof.observeFrame(29);
  message({ kind: "started", order: 1, workerIdentity: "dedicated-worker" });
  proof.observeFrame(30);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  proof.observeFrame(31);
  expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "compute" }));
  return { events, message, passed, proof, worker };
}

it("records the expired deadline before a potentially blocking termination, then latches failure", () => {
  const { events, passed, proof, worker } = setup();
  proof.observeFrame(249);
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(() => proof.observeFrame(250)).toThrow("worker result was not delivered");
  expect(events[0]).toContain("TN_NATIVE_WORKER_PROOF_FAIL:");
  expect(events[1]).toBe("terminate");
  proof.observeFrame(251);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(passed).not.toHaveBeenCalled();
});

it("accepts the correct result before the boundary and waits two frames before publishing", () => {
  const { message, passed, proof, worker } = setup();
  proof.observeFrame(249);
  message({
    kind: "result",
    order: 2,
    workerIdentity: "dedicated-worker",
    inputChecksum: WORKER_INPUT_CHECKSUM,
    outputChecksum: WORKER_OUTPUT_CHECKSUM,
  });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  proof.observeFrame(250);
  expect(passed).not.toHaveBeenCalled();
  proof.observeFrame(251);
  expect(passed).toHaveBeenCalledWith(
    expect.objectContaining({
      callbacksAfterTerminate: 0,
      framesAdvanced: 239,
      outputChecksum: WORKER_OUTPUT_CHECKSUM,
    }),
  );
});

it("executes the shipped worker's full computation with the expected checksum", async () => {
  const createUrl = vi.spyOn(URL, "createObjectURL");
  const { worker } = setup();
  const blob = createUrl.mock.calls[0]?.[0];
  if (!(blob instanceof Blob)) throw new Error("worker source was not a Blob");
  const scope = {
    self: { onmessage: (_event: unknown) => undefined },
    postMessage: vi.fn(),
    console,
  };
  new Function("self", "postMessage", "console", await blob.text())(
    scope.self,
    scope.postMessage,
    console,
  );
  const compute = worker.postMessage.mock.calls[1]?.[0];
  scope.self.onmessage({ data: compute });
  expect(scope.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "result",
      inputChecksum: WORKER_INPUT_CHECKSUM,
      outputChecksum: WORKER_OUTPUT_CHECKSUM,
      workerIdentity: "dedicated-worker",
    }),
  );
});
