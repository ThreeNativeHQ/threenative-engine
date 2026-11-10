import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { enforceBudgets } from "../check-budgets.js";

describe("shipped web Wasm engine size budget", () => {
  it.each([4_259_839, 4_259_840])("accepts %i bytes", async (bytes) => {
    const root = await wasmFixture(bytes);
    await expect(enforceBudgets(root)).resolves.toBeDefined();
  });

  it("rejects a file one byte over 4 MiB + 64 KiB", async () => {
    const root = await wasmFixture(4_259_841);
    await expect(enforceBudgets(root)).rejects.toThrow(
      "TN_WEB_ENGINE_OVER_BUDGET: measured 4259841 bytes, allowed 4259840 bytes",
    );
  });

  it("holds the threaded engine to the same budget", async () => {
    const root = await wasmFixture(4_259_840);
    await writeFile(
      path.join(root, "packages/runtime-native/build/web/tn-native-engine-web-threads.wasm"),
      Buffer.alloc(4_259_841),
    );
    await expect(enforceBudgets(root)).rejects.toThrow(
      "TN_WEB_ENGINE_OVER_BUDGET: measured 4259841 bytes, allowed 4259840 bytes",
    );
  });

  it("skips an unbuilt Wasm engine", async () => {
    const root = await makeTempDir("threenative-wasm-budget-");
    await expect(enforceBudgets(root)).resolves.toBeDefined();
  });
});

async function wasmFixture(bytes: number): Promise<string> {
  const root = await makeTempDir("threenative-wasm-budget-");
  const directory = path.join(root, "packages/runtime-native/build/web");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "tn-native-engine-web.wasm"), Buffer.alloc(bytes));
  return root;
}
