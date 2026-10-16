import { startBehaviorScene } from "./scene-support.js";
import { verifyQueueWriteBuffer } from "./queue-write-buffer-proof.js";

export function startScene(canvas, dimensions) {
  return startBehaviorScene(canvas, dimensions, "queue-write-buffer-zero", async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("writeBuffer proof requires a GPU adapter");
    const device = await adapter.requestDevice();
    return verifyQueueWriteBuffer(device);
  });
}
