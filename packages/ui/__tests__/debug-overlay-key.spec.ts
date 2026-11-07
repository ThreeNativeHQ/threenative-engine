// The overlay cannot import the dev global's name from core: a static cross-package reference keeps
// core's `dev-global` module — and `__THREENATIVE__` with it — alive in every game's production
// chunk, which `scripts/check-core-boundary.ts` rejects on a built scaffold. It keeps a local copy
// instead, and this spec is what stops that copy from drifting away from the single owner: a rename
// in core fails here rather than leaving the overlay reading nothing at runtime.
import { DEV_GLOBAL_KEY } from "@threenative/core";
import { describe, expect, it } from "vitest";

describe("the debug overlay's dev-global key", () => {
  it("reads the same name core publishes under", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/DebugOverlay.tsx", import.meta.url), "utf8"),
    );
    const local = /const DEV_GLOBAL_KEY = "([^"]+)"/u.exec(source)?.[1];
    expect(local).toBe(DEV_GLOBAL_KEY);
  });
});
