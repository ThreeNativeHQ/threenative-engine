import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const shipped = new URL("../wasm/", import.meta.url);
const realBinary = new Uint8Array(readFileSync(new URL("riglogic.wasm", shipped)));
const realManifest = new Uint8Array(readFileSync(new URL("checksums.json", shipped)));
// Only its length is checked before the module loads, so one byte is enough to reach the checksum.
const dna = Uint8Array.of(1);

/** Serves the two package files a load fetches, keyed by file name. */
function serve(files: Record<string, Uint8Array>): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    const body = files[url.slice(url.lastIndexOf("/") + 1)];
    return body === undefined
      ? new Response(null, { status: 404 })
      : new Response(Uint8Array.from(body));
  });
}

/** The module caches its first load, so each case gets a fresh copy of it. */
async function createEvaluator(): Promise<unknown> {
  vi.resetModules();
  const { RigEvaluator } = await import("../src/wasm-evaluator.js");
  return RigEvaluator.create(dna);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("riglogic.wasm checksum", () => {
  it("passes the shipped binary against its shipped manifest", async () => {
    serve({ "riglogic.wasm": realBinary, "checksums.json": realManifest });
    // The DNA is not a real rig, so the load may fail after the checksum; it must not fail on it.
    const outcome = await createEvaluator().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).not.toMatchObject({ code: "TN_MH_WASM_CHECKSUM" });
  });

  it("rejects a binary with one changed byte", async () => {
    const tampered = Uint8Array.from(realBinary);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    serve({ "riglogic.wasm": tampered, "checksums.json": realManifest });
    await expect(createEvaluator()).rejects.toMatchObject({ code: "TN_MH_WASM_CHECKSUM" });
  });

  it("rejects a half-written binary", async () => {
    const halfWritten = realBinary.subarray(0, realBinary.length >> 1);
    serve({ "riglogic.wasm": halfWritten, "checksums.json": realManifest });
    await expect(createEvaluator()).rejects.toMatchObject({ code: "TN_MH_WASM_CHECKSUM" });
  });

  it("rejects a manifest that records no hash for the binary", async () => {
    serve({
      "riglogic.wasm": realBinary,
      "checksums.json": new TextEncoder().encode('{"files":{}}'),
    });
    await expect(createEvaluator()).rejects.toMatchObject({ code: "TN_MH_WASM_CHECKSUM" });
  });
});
