import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * PRD-927: core's `releaseMouse()` (input.ts) asks the page's document for `exitPointerLock` whenever
 * the document is an event target, and throws when it has none. The engine player's document became
 * an event target (PRD-906) without it, so Midway's TAKE THE DECK, which releases the mouse, failed
 * on every desktop with `TN_UI_RECEIVE_FAILED: Pointer capture release is unavailable`.
 *
 * The mutation that reddens this file: remove `exitPointerLock` from `kDocumentShim` in v8_main.cpp.
 */
const v8Main = readFileSync(
  join(import.meta.dirname, "..", "src", "engine", "player", "v8_main.cpp"),
  "utf8",
);
const start = v8Main.indexOf('kDocumentShim = R"JS(');
const shim = v8Main.slice(v8Main.indexOf("\n", start), v8Main.indexOf(')JS";', start));

describe("engine player document", () => {
  it("releases pointer capture through the canvas lock core-host installs", () => {
    const exitPointerLock = vi.fn();
    const global: Record<string, unknown> = { console, canvas: { exitPointerLock } };
    runInNewContext(shim, global);
    const document = global.document as Record<string, unknown>;

    // Core picks the document as the lock owner because it is an event target.
    expect(typeof document.addEventListener).toBe("function");
    expect(typeof document.exitPointerLock).toBe("function");
    (document.exitPointerLock as () => void)();
    expect(exitPointerLock).toHaveBeenCalledOnce();
  });
});
