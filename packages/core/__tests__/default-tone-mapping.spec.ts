import { ACESFilmicToneMapping, AgXToneMapping, CustomToneMapping, NoToneMapping } from "three";
import { describe, expect, it, vi } from "vitest";
import { applyRendererToneMapping } from "../src/look/default-tone-mapping.js";
import { createRenderer } from "../src/renderer.js";

// Owner 2026-10-22: a renderer with no look options starts with a fresh Unreal 5.8.3 project's tone curve.
function webgpu(withLibrary: boolean) {
  const addToneMapping = vi.fn();
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  const raw: Record<string, unknown> = {
    domElement: canvas,
    init: async () => undefined,
    render: () => undefined,
    setSize: () => undefined,
    ...(withLibrary ? { library: { addToneMapping } } : {}),
  };
  return {
    addToneMapping,
    raw,
    options: {
      canvas: canvas as HTMLCanvasElement,
      pipelineCensus: false as const,
      source: {
        createCanvas: () => canvas as HTMLCanvasElement,
        hasWebGPU: () => true,
        observeResize: () => () => undefined,
        readSize: () => [320, 180] as const,
      },
      webgpuFactory: () => raw,
    },
  };
}

describe("default tone mapping", () => {
  it("starts a WebGPU renderer on Unreal's filmic curve with no options", async () => {
    const f = webgpu(true);
    const renderer = await createRenderer(f.options);
    expect(f.raw.toneMapping).toBe(CustomToneMapping);
    expect(f.addToneMapping).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it.each([
    ["aces", ACESFilmicToneMapping],
    ["agx", AgXToneMapping],
    ["none", NoToneMapping],
  ] as const)("keeps %s as the named override and installs no curve", async (mode, three) => {
    const f = webgpu(true);
    const renderer = await createRenderer({ ...f.options, toneMapping: mode });
    expect(f.raw.toneMapping).toBe(three);
    expect(f.addToneMapping).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("reports a renderer that cannot run the curve and keeps ACES", async () => {
    const report = vi.fn();
    const f = webgpu(false);
    const renderer = await createRenderer({ ...f.options, report });
    expect(f.raw.toneMapping).toBe(ACESFilmicToneMapping);
    expect(report).toHaveBeenCalledWith(expect.stringContaining("TN_TONEMAP"));
    renderer.dispose();
  });

  it("throws on an unknown mode instead of falling back", () => {
    expect(() => applyRendererToneMapping({}, "lumen" as never, () => undefined)).toThrow(
      /Unknown toneMapping 'lumen'/,
    );
  });
});
