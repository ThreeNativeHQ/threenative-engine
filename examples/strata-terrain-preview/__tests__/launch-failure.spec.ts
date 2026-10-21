import type { ILaunchFailure } from "@threenative/core";
import { describe, expect, it } from "vitest";
import { showLaunchFailures } from "../src/launchFailure.js";

function page(webdriver = false) {
  const shown: Array<{ textContent: string | null; role?: string }> = [];
  const storage = new Map<string, string>();
  let reloads = 0;
  let listener: ((failure: ILaunchFailure) => void) | undefined;
  const failures = showLaunchFailures(
    {
      document: {
        createElement: () => {
          const element = {
            textContent: "",
            style: { cssText: "" },
            setAttribute(name: string, value: string) {
              if (name === "role") element.role = value;
            },
            role: undefined as string | undefined,
          };
          return element;
        },
        body: { append: (element: { textContent: string | null; role?: string }) => shown.push(element) },
      },
      location: { reload: () => reloads++ },
      navigator: { webdriver },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
    (next: (failure: ILaunchFailure) => void) => {
      listener = next;
      return () => undefined;
    },
  );
  const fail = (failure: ILaunchFailure) => listener?.(failure);
  return { failures, fail, shown, reloads: () => reloads };
}

const lost: ILaunchFailure = { kind: "device-lost", message: "The GPU device was lost: gone" };

describe("launch failures on the preview page", () => {
  it("reloads once for a lost device, then shows the failure", () => {
    // The loading screen is drawn with WebGPU, so after a device loss only the DOM can speak.
    const view = page();
    view.fail(lost);
    expect(view.reloads()).toBe(1);
    expect(view.shown).toEqual([]);
    view.fail(lost);
    expect(view.reloads()).toBe(1);
    expect(view.shown.map((element) => [element.textContent, element.role])).toEqual([
      [lost.message, "alert"],
    ]);
  });

  it("allows another reload once a launch has reached the world", () => {
    const view = page();
    view.fail(lost);
    view.failures.ready();
    view.fail(lost);
    expect(view.reloads()).toBe(2);
  });

  it("never reloads under automation, so a playtest still sees the loss", () => {
    const view = page(true);
    view.fail(lost);
    expect(view.reloads()).toBe(0);
    expect(view.shown.map((element) => element.textContent)).toEqual([lost.message]);
  });

  it("shows any other launch failure at once", () => {
    const view = page();
    view.fail({ kind: "stalled", message: "The game stopped loading." });
    expect(view.reloads()).toBe(0);
    expect(view.shown.map((element) => element.textContent)).toEqual(["The game stopped loading."]);
  });
});
