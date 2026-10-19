import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { makeTempDir } from "../../test-support/temp-dir.js";
import { main } from "../content-census.js";

describe("pnpm census:content", () => {
  it("exits non-zero when a .glb cannot be read", async () => {
    const root = await makeTempDir("threenative-content-census-");
    await writeFile(path.join(root, "broken.glb"), "not a glTF container");
    expect(await main([root, "--json"])).toBe(1);
  });

  it("exits 0 when every .glb reads", async () => {
    const root = await makeTempDir("threenative-content-census-");
    expect(await main([root, "--json"])).toBe(0);
  });
});
