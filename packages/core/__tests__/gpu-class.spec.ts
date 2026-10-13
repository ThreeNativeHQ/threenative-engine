import { describe, expect, it } from "vitest";
import { type GpuClass, classifyGpu } from "../src/gpu-class.js";

// Field values as `adapter.info` reports them: lowercase vendor and architecture on Chrome, a
// description that is often empty, and the native host's four fields from the same read.
const fixtures: readonly [label: string, fields: Record<string, string>, expected: GpuClass][] = [
  [
    "RTX 2080, Chrome",
    { architecture: "turing", description: "", device: "", vendor: "nvidia" },
    "discrete",
  ],
  [
    "RTX 4090, native",
    { architecture: "", description: "NVIDIA GeForce RTX 4090", device: "", vendor: "NVIDIA" },
    "discrete",
  ],
  [
    "SwiftShader",
    { architecture: "swiftshader", description: "", device: "", vendor: "google" },
    "software",
  ],
  [
    "llvmpipe",
    { architecture: "", description: "llvmpipe (LLVM 17)", device: "", vendor: "mesa" },
    "software",
  ],
  [
    "Iris Xe",
    { architecture: "gen-12lp", description: "", device: "", vendor: "intel" },
    "integrated",
  ],
  [
    "Arc A770",
    {
      architecture: "xe-hpg",
      description: "Intel(R) Arc(tm) A770 Graphics",
      device: "",
      vendor: "intel",
    },
    "discrete",
  ],
  [
    "Radeon RX 7800 XT",
    { architecture: "rdna-3", description: "AMD Radeon RX 7800 XT", device: "", vendor: "amd" },
    "discrete",
  ],
  [
    "Ryzen iGPU",
    { architecture: "rdna-2", description: "AMD Radeon(TM) Graphics", device: "", vendor: "amd" },
    "integrated",
  ],
  [
    "Mali-G715",
    { architecture: "", description: "Mali-G715-Immortalis MC11", device: "", vendor: "arm" },
    "mobile-high",
  ],
  [
    "Mali-G52",
    { architecture: "bifrost", description: "Mali-G52 MC2", device: "", vendor: "arm" },
    "mobile-low",
  ],
  [
    "Mali-G78",
    { architecture: "valhall", description: "Mali-G78", device: "", vendor: "arm" },
    "mobile-mid",
  ],
  [
    "Mali by architecture only",
    { architecture: "bifrost", description: "", device: "", vendor: "arm" },
    "mobile-low",
  ],
  [
    "Adreno 5xx",
    { architecture: "", description: "Adreno (TM) 540", device: "", vendor: "qualcomm" },
    "mobile-mid",
  ],
  [
    "Adreno 650",
    { architecture: "", description: "Adreno (TM) 650", device: "", vendor: "qualcomm" },
    "mobile-high",
  ],
  [
    "Adreno 618",
    { architecture: "", description: "Adreno (TM) 618", device: "", vendor: "qualcomm" },
    "mobile-mid",
  ],
  [
    "Adreno 740",
    { architecture: "adreno-7xx", description: "", device: "", vendor: "qualcomm" },
    "mobile-high",
  ],
  [
    "Adreno 4xx",
    { architecture: "", description: "Adreno (TM) 430", device: "", vendor: "qualcomm" },
    "mobile-low",
  ],
  [
    "Apple Silicon keeps today's start",
    { architecture: "common-3", description: "", device: "", vendor: "apple" },
    "unknown",
  ],
  ["empty fields", { architecture: "", description: "", device: "", vendor: "" }, "unknown"],
];

describe("classifyGpu", () => {
  it.each(fixtures)("%s", (_label, fields, expected) => {
    expect(classifyGpu(fields).class).toBe(expected);
  });

  it("names the rule and returns the raw fields", () => {
    const result = classifyGpu({ architecture: "turing", vendor: "nvidia" });
    expect(result).toEqual({
      class: "discrete",
      fields: { architecture: "turing", description: "", device: "", vendor: "nvidia" },
      rule: "nvidia",
    });
  });

  it("reports the none rule for an unrecognised adapter", () => {
    expect(classifyGpu({ vendor: "acme" })).toMatchObject({ class: "unknown", rule: "none" });
  });

  it("never lets a software adapter pose as hardware by vendor", () => {
    // SwiftShader reports a hardware-looking vendor string on some builds; the software row is first.
    expect(
      classifyGpu({ architecture: "swiftshader", description: "NVIDIA", vendor: "nvidia" }).class,
    ).toBe("software");
  });

  it("does not class a Tegra as a discrete card", () => {
    expect(classifyGpu({ description: "NVIDIA Tegra Orin", vendor: "nvidia" }).class).toBe(
      "unknown",
    );
  });
});
