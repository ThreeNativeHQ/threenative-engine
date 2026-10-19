import { PerspectiveCamera, Scene } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixedStepLoop } from "../src/loop.js";
import { createRenderer } from "../src/renderer.js";

afterEach(() => vi.unstubAllGlobals());

describe("GPU timestamp frame sampling", () => {
  it.each([1, 3, 8])(
    "keeps every pass on the same %i-frame cadence with or without a pyramid",
    async (interval) => {
      vi.stubGlobal("navigator", { gpu: {} });
      const canvas = new EventTarget() as HTMLCanvasElement;
      const camera = new PerspectiveCamera();
      const main = new Scene();
      main.name = "main";
      const auxiliary = new Scene();
      auxiliary.name = "auxiliary";
      const overlay = new Scene();
      overlay.name = "overlay";
      const mainSamples: boolean[][] = [];
      const frameCalls: { pass: string; frame: number; sampled: boolean; presented: number }[] = [];
      for (const pyramid of [false, true]) {
        const info = { frame: 0 };
        const backend = { trackTimestamp: true };
        const calls: { pass: string; frame: number; sampled: boolean; presented: number }[] = [];
        let presented = 0;
        const record = (pass: string) =>
          calls.push({
            pass,
            frame: info.frame,
            sampled: backend.trackTimestamp,
            presented,
          });
        const renderer = await createRenderer({
          canvas,
          gpuTimestampFrameInterval: interval,
          webgpuFactory: () => ({
            backend,
            domElement: canvas,
            info,
            init: async () => undefined,
            compute: (node: unknown) => record(node === "pyramid" ? "pyramid" : "compute"),
            render: (scene: Scene) => record(scene.name),
            setSize: () => undefined,
          }),
        });
        const loop = new FixedStepLoop({
          onBeginFrame: () => renderer.beginFrame?.(),
          onUpdate: () => renderer.compute("simulation"),
          onRender: () => {
            renderer.compute("cull");
            if (pyramid) renderer.compute("pyramid", "depthPyramid");
            renderer.render(auxiliary, camera);
            renderer.render(main, camera);
            renderer.renderOverlay(overlay, camera);
            return undefined;
          },
        });
        try {
          for (presented = 0; presented < 24; presented += 1) {
            // Include a catch-up frame with several simulation dispatches.
            loop.stepFrame(presented * 17 + (presented >= 4 ? 100 : 0));
          }
          const samples = calls.filter((call) => call.pass === "main").map((call) => call.sampled);
          mainSamples.push(samples);
          frameCalls.push(...calls);
        } finally {
          renderer.dispose();
        }
      }
      expect(mainSamples[1]).toEqual(mainSamples[0]);
      expect(mainSamples[0]).toEqual(
        Array.from({ length: 24 }, (_, frame) => frame % interval === 0),
      );
      for (const call of frameCalls) {
        expect(call.frame, call.pass).toBe(call.presented);
        expect(call.sampled, call.pass).toBe(call.presented % interval === 0);
      }
    },
  );
});
