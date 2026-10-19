import { afterEach, describe, expect, it } from "vitest";
import { renderListValidationRequested } from "../src/profiling/render-list-validate.js";

const FLAG = "TN_RENDERLIST_VALIDATE";
const original = process.env[FLAG];

afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
  (globalThis as { location?: unknown }).location = undefined;
  (globalThis as { __tnRenderListValidate?: unknown }).__tnRenderListValidate = undefined;
});

describe("renderListValidationRequested flag parsing", () => {
  it("gives false for =0 and =false, true for any other non-empty value", () => {
    process.env[FLAG] = "0";
    expect(renderListValidationRequested()).toBe(false);
    process.env[FLAG] = "false";
    expect(renderListValidationRequested()).toBe(false);
    process.env[FLAG] = "";
    expect(renderListValidationRequested()).toBe(false);
    process.env[FLAG] = "1";
    expect(renderListValidationRequested()).toBe(true);
    process.env[FLAG] = "yes";
    expect(renderListValidationRequested()).toBe(true);
  });

  it("gives false for a =0 or =false query value, true otherwise", () => {
    delete process.env[FLAG];
    (globalThis as { location?: unknown }).location = { search: "?tnRenderListValidate=0" };
    expect(renderListValidationRequested()).toBe(false);
    (globalThis as { location?: unknown }).location = { search: "?tnRenderListValidate=false" };
    expect(renderListValidationRequested()).toBe(false);
    (globalThis as { location?: unknown }).location = { search: "?tnRenderListValidate=1" };
    expect(renderListValidationRequested()).toBe(true);
  });

  it("honours the global switch only when it is true or '1'", () => {
    delete process.env[FLAG];
    (globalThis as { __tnRenderListValidate?: unknown }).__tnRenderListValidate = false;
    expect(renderListValidationRequested()).toBe(false);
    (globalThis as { __tnRenderListValidate?: unknown }).__tnRenderListValidate = "0";
    expect(renderListValidationRequested()).toBe(false);
    (globalThis as { __tnRenderListValidate?: unknown }).__tnRenderListValidate = true;
    expect(renderListValidationRequested()).toBe(true);
    (globalThis as { __tnRenderListValidate?: unknown }).__tnRenderListValidate = "1";
    expect(renderListValidationRequested()).toBe(true);
  });
});
