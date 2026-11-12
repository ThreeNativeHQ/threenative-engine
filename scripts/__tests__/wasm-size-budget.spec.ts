import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { enforceBudgets } from "../check-budgets.js";

describe("shipped web Wasm engine size budget", () => {
  it.each([4_325_375, 4_325_376])("accepts %i bytes", async (bytes) => {
    const root = await wasmFixture(bytes);
    await expect(enforceBudgets(root)).resolves.toBeDefined();
  });

  it("rejects a file one byte over 4 MiB + 128 KiB", async () => {
    const root = await wasmFixture(4_325_377);
    await expect(enforceBudgets(root)).rejects.toThrow(
      "TN_WEB_ENGINE_OVER_BUDGET: measured 4325377 bytes, allowed 4325376 bytes",
    );
  });

  it("holds the threaded engine to the same budget", async () => {
    const root = await wasmFixture(4_325_376);
    await writeFile(
      path.join(root, "packages/runtime-native/build/web/tn-native-engine-web-threads.wasm"),
      Buffer.alloc(4_325_377),
    );
    await expect(enforceBudgets(root)).rejects.toThrow(
      "TN_WEB_ENGINE_OVER_BUDGET: measured 4325377 bytes, allowed 4325376 bytes",
    );
  });

  // PRD-867 raised the table in check-budgets.ts and left the build action at 4 MiB. The cache hid it
  // until the action's key moved, and the first fresh engine (4,213,808 bytes) failed build-artifacts.
  it("is the same number the web engine build action enforces", () => {
    const action = readFileSync(
      path.join(import.meta.dirname, "../../.github/actions/native-engine-wasm/action.yml"),
      "utf8",
    );
    expect(action).toMatch(/^\s*allowed_bytes=4325376$/m);
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
