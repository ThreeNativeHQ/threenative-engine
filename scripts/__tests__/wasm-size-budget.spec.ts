import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { enforceBudgets } from "../check-budgets.js";

describe("shipped web Wasm engine size budget", () => {
  it.each([4_194_303, 4_194_304])("accepts %i bytes", async (bytes) => {
    const root = await wasmFixture(bytes);
    await expect(enforceBudgets(root)).resolves.toBeDefined();
  });

  it("rejects a file one byte over 4 MiB", async () => {
    const root = await wasmFixture(4_194_305);
    await expect(enforceBudgets(root)).rejects.toThrow(
      "TN_WEB_ENGINE_OVER_BUDGET: measured 4194305 bytes, allowed 4194304 bytes",
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
