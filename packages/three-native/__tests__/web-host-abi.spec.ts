/**
 * The facade and the web engine agree on the tnw_* calls by one number, web_host.cpp `kWebHostAbi`
 * and browser-renderer.ts `WEB_HOST_ABI`, and init refuses a pair whose numbers differ. A signature
 * change that kept the number would still pair an old facade with the new module (39295d1f3 added
 * tnw_web_render's overlay argument, and an older facade's frame number was read as the flag), so
 * the signatures are pinned per number: change one, bump both numbers, then add a row. Never edit a row.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WEB_HOST_ABI } from "../src/browser-renderer.js";

const NATIVE = path.join(process.cwd(), "packages/runtime-native");
const PINNED: Record<number, string> = {
  2: "49a13523783fbb35",
  3: "4afe732b2264c45b",
  4: "61297e45c5c4af17",
  5: "19de888acc9a07f4",
  6: "6bc06825761fcf35",
  7: "8947e7786e5634b2",
  8: "3c6476b841380e81",
  9: "9cc4cfcd1b657e41",
  // 10 = tnw_web_read_mrt (a PassNode's custom MRT attachment) and tnw_web_device_limit.
  10: "c641a6bba0370d6f",
  // 11 = the merged host: develop's 9 (tnw_web_clear_target, render-target flags) beside the Strata lane's
  // 9 and 10 (init/copy texture, read_mrt, device_limit) met under one number, so both moved up.
  11: "6ca2e45be11e2c12",
  // 12 = tnw_web_load_gltf_begin / tnw_web_load_gltf_done (PRD-860: a glTF parses on the loader thread).
  12: "a60bf14ce843fbf8",
  // 13 = the merged host: the Strata lane's 12 (tnw_web_load_gltf returns every scene and their count, so a
  // model's LOD scenes load, PRD-762) and 13 (tnw_web_device_feature, PRD-857) over PRD-860's 12; the loader
  // thread's tnw_web_load_gltf_finish returns the scenes too.
  13: "ce02034f812ee60e",
};

function signatures(): string[] {
  const found = ["src/engine/wasm/web_host.cpp", "src/engine/abi/abi.cpp"].flatMap((file) =>
    [
      ...readFileSync(path.join(NATIVE, file), "utf8").matchAll(
        /extern "C" [^;{]*?\btnw_\w+\([^)]*\)/gu,
      ),
    ].map(([text]) => text.replace(/\s+/gu, " ")),
  );
  return found.sort();
}

describe("the web host ABI", () => {
  it("is one number on both sides", () => {
    const host = readFileSync(path.join(NATIVE, "src/engine/wasm/web_host.cpp"), "utf8");
    expect(Number(/constexpr uint32_t kWebHostAbi = (\d+);/u.exec(host)?.[1])).toBe(WEB_HOST_ABI);
  });

  it("pins the tnw_* signatures for that number", () => {
    const digest = createHash("sha256").update(signatures().join("\n")).digest("hex").slice(0, 16);
    expect(
      digest,
      "a tnw_* signature changed: bump kWebHostAbi and WEB_HOST_ABI, then pin the new digest in a new row",
    ).toBe(PINNED[WEB_HOST_ABI]);
  });

  it("covers every tnw_* call the web engine exports", () => {
    const cmake = readFileSync(path.join(NATIVE, "cmake/NativeEngineCore.cmake"), "utf8");
    const list = /-sEXPORTED_FUNCTIONS=([^"]*_tnw_web_init[^"]*)"/u.exec(cmake)?.[1] ?? "";
    const exported = list.split(",").filter((name) => name.startsWith("_tnw_"));
    expect(exported.length).toBeGreaterThan(0);
    const defined = new Set(signatures().map((text) => /\b(tnw_\w+)\(/u.exec(text)?.[1]));
    expect(exported.filter((name) => !defined.has(name.slice(1)))).toEqual([]);
  });
});
