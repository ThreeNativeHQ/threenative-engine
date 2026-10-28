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
  5: "0f129b407339bbd1",
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
