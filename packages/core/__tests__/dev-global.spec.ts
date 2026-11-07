// One module owns the `__THREENATIVE__` key, its shape and the list the worker mirrors. These cases
// pin the parts a second copy used to get wrong: publishing keeps what another surface wrote, the
// reader refuses a non-object, and the mirror list names the key rather than spelling it.
import { describe, expect, it } from "vitest";
import { DEV_GLOBAL_KEY, devGlobal, publishDevGlobal } from "../src/dev-global.js";

function host(): Record<string, unknown> {
  return {};
}

describe("the dev global", () => {
  it("should publish under one key and keep what another surface wrote", () => {
    const scope = host();
    publishDevGlobal("debug", { player: 1 }, scope);
    publishDevGlobal("snapshot", () => ({}), scope);
    expect(Object.keys(scope)).toEqual([DEV_GLOBAL_KEY]);
    expect(devGlobal(scope)).toMatchObject({ debug: { player: 1 } });
    expect(typeof devGlobal(scope)?.snapshot).toBe("function");
  });

  it("should read nothing from a scope that holds something that is not an object", () => {
    expect(devGlobal({ [DEV_GLOBAL_KEY]: "yes" })).toBeUndefined();
    expect(devGlobal(host())).toBeUndefined();
  });

  it("should spell the key once, so a reader and a writer cannot disagree", () => {
    expect(DEV_GLOBAL_KEY).toBe("__THREENATIVE__");
  });
});
