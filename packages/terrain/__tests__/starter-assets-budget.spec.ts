import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The redistributable art pack's ceiling, on disk (owner, 2026-11-14: "careful with the size"). */
const STARTER_ASSETS_MAX_BYTES = 100 * 1000 * 1000;
const dir = fileURLToPath(new URL("../starter-assets", import.meta.url));

describe("the starter art pack", () => {
  it("stays at or under 100 MB on disk", () => {
    const bytes = readdirSync(dir, { recursive: true })
      .map((name) => statSync(join(dir, String(name))))
      .filter((info) => info.isFile())
      .reduce((sum, info) => sum + info.size, 0);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(STARTER_ASSETS_MAX_BYTES);
  });
});
