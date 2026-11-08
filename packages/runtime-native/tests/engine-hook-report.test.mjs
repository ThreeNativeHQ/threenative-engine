// The V8 adapter's math install checks that the host's Object3D carries the world-matrix hook core
// copies matrices out through, and says so once when it does not. A host that renamed the hook
// would otherwise send every caller down the aliasing read with no sign of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOOK = "__tnCopyMatrixWorld";

async function install(target) {
  vi.resetModules();
  await import("../src/adapters/v8/math/entry.js");
  const installer = globalThis.__tnMathInstall;
  expect(typeof installer).toBe("function");
  try {
    // The layout is the C++ host's to publish. An empty one stops the install after the check, which
    // is all this test reads; the throw that follows is the missing layout, not the hook.
    installer(target, "{}");
  } catch {
    // expected: no layout
  }
}

describe("the adapter's engine hook report", () => {
  let reports;
  beforeEach(() => {
    reports = [];
    vi.spyOn(console, "error").mockImplementation((line) => reports.push(String(line)));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__tnMathInstall;
  });

  it("reports exactly once, naming the hook, when the host's Object3D lacks it", async () => {
    await install({ Box3: class {}, Object3D: class {} });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("TN_ENGINE_HOOK_MISSING");
    expect(reports[0]).toContain(HOOK);
  });

  it("reports when the host has no Object3D at all", async () => {
    await install({ Box3: class {} });
    expect(reports).toHaveLength(1);
  });

  it("stays silent when the host's Object3D carries the hook", async () => {
    const Object3D = class {};
    Object3D.prototype[HOOK] = function copyMatrixWorld() {};
    await install({ Box3: class {}, Object3D });
    expect(reports).toEqual([]);
  });
});
