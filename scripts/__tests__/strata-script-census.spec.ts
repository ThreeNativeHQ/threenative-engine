import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("strata-terrain-preview script and playtest census", () => {
  it("ensures every file under scripts/ and playtests/ is documented in AGENTS.md", () => {
    const exampleRoot = path.resolve(__dirname, "../../examples/strata-terrain-preview");
    const scriptsDir = path.join(exampleRoot, "scripts");
    const playtestsDir = path.join(exampleRoot, "playtests");

    function collectFiles(dir: string, relPrefix: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      let out: string[] = [];
      for (const entry of entries) {
        const rel = path.join(relPrefix, entry.name);
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out = out.concat(collectFiles(full, rel));
        } else if (entry.isFile()) {
          out.push(rel);
        }
      }
      return out;
    }

    const scriptFiles = collectFiles(scriptsDir, "scripts");
    const playtestFiles = collectFiles(playtestsDir, "playtests");
    const allFiles = [...scriptFiles, ...playtestFiles].sort();

    expect(allFiles.length).toBeGreaterThan(0);

    const agents = readFileSync(path.join(exampleRoot, "AGENTS.md"), "utf8");
    const documented = new Set(Array.from(agents.matchAll(/`([^`]+)`/g), (m) => m[1]));

    const undocumented = allFiles.filter((file) => !documented.has(file));
    expect(undocumented).toEqual([]);
  });
});
