// A `src/render/` file that ships byte-identical in every kit that carries it and is not in the
// shared list is a copy nobody restamps: fix one kit and the others keep the old behaviour, with
// every gate green. `c93b427d0` touched 552 files for one look change because of exactly that.
//
// The rule: same bytes everywhere it ships, in two or more kits ⇒ listed. A file that differs in
// any kit is a per-kit look (or a look that drifted on purpose) and stays out, because restamping
// it would overwrite that kit's choice; a file only one kit ships is that kit's own.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADDED_RENDER_SOURCES,
  SHARED_RENDER_SOURCES,
  canonicalRenderSourcePath,
  templateRoot,
} from "../src/index.js";

const RENDER_PREFIX = "src/render/";

interface IIdenticalCopy {
  readonly relativePath: string;
  readonly kits: readonly string[];
}

function renderCopies(): Map<string, Map<string, readonly string[]>> {
  const root = templateRoot();
  const copies = new Map<string, Map<string, readonly string[]>>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const render = path.join(root, entry.name, "src", "render");
    if (!existsSync(render)) continue;
    for (const file of readdirSync(render)) {
      if (!file.endsWith(".ts") || !existsSync(path.join(render, file))) continue;
      const digest = createHash("sha256")
        .update(readFileSync(path.join(render, file)))
        .digest("hex");
      const byDigest =
        copies.get(`${RENDER_PREFIX}${file}`) ?? new Map<string, readonly string[]>();
      byDigest.set(digest, [...(byDigest.get(digest) ?? []), entry.name]);
      copies.set(`${RENDER_PREFIX}${file}`, byDigest);
    }
  }
  return copies;
}

/** Every render source that ships the same bytes in two or more kits, and in no other form. */
function identicalCopies(): readonly IIdenticalCopy[] {
  const identical: IIdenticalCopy[] = [];
  for (const [relativePath, byDigest] of renderCopies()) {
    // More than one digest means some kit decided to differ: that is a look, not a copy.
    if (byDigest.size !== 1) continue;
    for (const kits of byDigest.values()) {
      if (kits.length < 2) continue;
      identical.push({ kits: [...kits].sort(), relativePath });
    }
  }
  return identical.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

describe("shared render sources", () => {
  it("should list every render source that ships byte-identical in two or more kits", () => {
    const unlisted = identicalCopies()
      .filter((copy) => !SHARED_RENDER_SOURCES.includes(copy.relativePath))
      .map((copy) => `${copy.relativePath} (${copy.kits.length} kits: ${copy.kits.join(", ")})`);
    expect(unlisted).toEqual([]);
  });

  it("should resolve every shared entry to the file it restamps from", () => {
    const missing = SHARED_RENDER_SOURCES.filter(
      (relativePath) => !existsSync(canonicalRenderSourcePath(relativePath)),
    );
    expect(missing).toEqual([]);
  });

  // The duplicate check above cannot see a listed file one kit edited: it stops being identical, so
  // it drops out of the grouping and nothing compares it with the copy it is supposed to follow.
  // That edit is silent until `pnpm stamp:template-render` overwrites it, which is the drift this
  // whole guard exists for.
  it("should keep every shipped copy of a listed file byte-identical to the canonical one", () => {
    const drifted: string[] = [];
    for (const relativePath of SHARED_RENDER_SOURCES) {
      const canonical = readFileSync(canonicalRenderSourcePath(relativePath));
      // Every kit that ships the file, across the digests: a drifted copy is in a different group.
      const copies = [...(renderCopies().get(relativePath)?.values() ?? [])].flat();
      for (const copy of copies) {
        const file = path.join(templateRoot(), copy, relativePath);
        if (!readFileSync(file).equals(canonical)) drifted.push(file);
      }
    }
    expect(drifted).toEqual([]);
  });

  it("should keep the added set inside the shared set", () => {
    const stray = ADDED_RENDER_SOURCES.filter(
      (relativePath) => !SHARED_RENDER_SOURCES.includes(relativePath),
    );
    expect(stray).toEqual([]);
  });
});
