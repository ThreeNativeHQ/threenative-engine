import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cloudTextures } from "../unreal-look/scaffold/render/clouds.js";

const digest = (data: Float32Array): string =>
  createHash("sha256")
    .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest("hex");

describe("cloud noise textures", () => {
  // The generator is seeded and pure: a faster loop must leave every float where it was, or the sky moves.
  it("keeps the exact textures of seed 631, to the bit", () => {
    const { pattern, volume } = cloudTextures(631);
    expect({ pattern: digest(pattern), volume: digest(volume) }).toEqual({
      pattern: "0f45fa26ee5cb45723570fb2bb3f316dccb19b21480fd3cc618f78999ce590dd",
      volume: "1165a61000c67b8c68958279b4cb0c095d8a264e3e8d80705accbf9215c04b85",
    });
  }, 60_000);
});
