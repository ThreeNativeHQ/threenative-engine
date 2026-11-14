/**
 * PRD-886: a bake on a stale `dist` stops by name.
 *
 * A bake imports the package's built `dist`, never its `src`, so an edit since the last build used
 * to cook the previous world silently. `assertDistFresh` is the guard every producer calls; this
 * spec proves it stops on a stale pair and passes on a fresh one, on a throwaway copy of the layout
 * (touching the real tree's mtimes would race every other spec in this suite).
 */
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { assertDistFresh } from "../src/dist-fresh.js";

/** A package root with one source file and the four built files a bake needs. */
async function layout(sourceAt: Date, builtAt: Date): Promise<string> {
  const root = await makeTempDir("tn-dist-");
  await mkdir(join(root, "src"));
  await mkdir(join(root, "dist", "mcp"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  for (const entry of [
    "index.js",
    "kit.js",
    join("mcp", "cook-child.js"),
    join("mcp", "server.js"),
  ])
    await writeFile(join(root, "dist", entry), "");
  await utimes(join(root, "src", "index.ts"), sourceAt, sourceAt);
  for (const entry of [
    "index.js",
    "kit.js",
    join("mcp", "cook-child.js"),
    join("mcp", "server.js"),
  ])
    await utimes(join(root, "dist", entry), builtAt, builtAt);
  return root;
}

describe("stale dist guard", () => {
  it("stops by name when src is newer than dist, and names the one command", async () => {
    const build = new Date(Date.now() - 60_000);
    const edit = new Date();
    const root = await layout(edit, build);
    expect(() => assertDistFresh(root)).toThrow(/pnpm --filter @threenative\/terrain build/u);
    expect(() => assertDistFresh(root)).toThrow(/older than packages\/terrain\/src/u);
  });

  it("passes when dist is newer, and on an installed package with no src", async () => {
    const edit = new Date(Date.now() - 60_000);
    const build = new Date();
    const fresh = await layout(edit, build);
    expect(() => assertDistFresh(fresh)).not.toThrow();
    const installed = await makeTempDir("tn-dist-installed-");
    await mkdir(join(installed, "dist"), { recursive: true });
    expect(() => assertDistFresh(installed)).not.toThrow();
  });
});
