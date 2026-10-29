import { assertGpuValidationApi } from "./gpu-validation-scope.js";
import { assertCondition, startVisualScene } from "./scene-support.js";
import { assertSubmittedWorkPromise } from "./screenshot-completion.js";
import { buildVirtualShadowScene } from "./virtual-shadow.js";

export function assertVirtualShadowFirstFrameProof(stats, validationError) {
  assertCondition(stats?.frame === 1, "virtual shadow first frame was not observed");
  assertCondition(stats.levels === 3 && stats.rendered > 0 && stats.rendersTotal > 0,
    "first frame did not submit virtual shadow levels");
  assertCondition(validationError === null,
    "virtual shadow first frame validation observation missing or failed (Destroyed texture)");
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "virtual-shadow-first-frame", async (context) => {
    const { renderer, scene, camera } = context;
    const device = renderer.backend?.device;
    assertGpuValidationApi(device);
    assertCondition(typeof device.queue?.onSubmittedWorkDone === "function", "GPU queue missing");
    device.pushErrorScope("validation");
    const subject = buildVirtualShadowScene(context);
    renderer.render(scene, camera);
    const stats = subject.node.stats;
    const completion = device.queue.onSubmittedWorkDone();
    assertSubmittedWorkPromise(completion, "virtual-shadow-first-frame");
    await completion;
    const validationError = await device.popErrorScope();
    assertVirtualShadowFirstFrameProof(stats, validationError);
    return { ...subject, detail: { firstFrame: stats.frame, renderedLevels: stats.rendered, validationErrors: 0 } };
  }, { deferInitialRender: true });
}
