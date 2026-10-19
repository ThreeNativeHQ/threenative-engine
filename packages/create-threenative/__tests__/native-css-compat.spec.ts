import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { extractUiStylesheets } from "../src/build.js";
import { findNativeCssViolations } from "../src/native-css-compat.js";

const scan = (css: string) => findNativeCssViolations("index.css", css);

describe("native-css Core profile scan", () => {
  it("passes a stylesheet that stays inside the profile", () => {
    const css = `
      @layer base { *, ::before, ::after { box-sizing: border-box; } }
      @property --tw-x { syntax: "*"; inherits: false; }
      .a { display: flex; gap: 8px; transform: translate(10px, 4px) rotate(3deg); transition: opacity 200ms; }
      .b:hover { background: oklch(62% .2 250); animation: none; float: none; }
      @media (min-width: 640px) { .c { grid-template-columns: repeat(3, 1fr); } }
      @supports (display: grid) { .d { display: grid; } }
    `;
    expect(scan(css)).toEqual([]);
  });

  it("names each outside-profile property, at-rule and selector with its location", () => {
    const css = [
      ".blur { backdrop-filter: blur(8px); }", //                    line 1
      ".pin { position: sticky; top: 0; }", //                       line 2
      ".spin { animation: spin 1s linear infinite; }", //            line 3
      "@keyframes spin { to { transform: rotate(360deg); } }", //    line 4
      ".tilt { transform: rotateX(20deg); }", //                     line 5
      ".card:has(img) { color: red; }", //                           line 6
      "@container (min-width: 400px) { .x { color: red; } }", //     line 7
    ].join("\n");
    const found = scan(css).map((f) => [f.line, f.what.split(": ")[0]]);
    expect(found).toEqual([
      [1, "backdrop-filter"],
      [2, "position"],
      [3, "animation"],
      [4, "@keyframes"],
      [5, "transform"],
      [6, ":has()"],
      [7, "@container"],
    ]);
    expect(scan(css)[0]).toMatchObject({ file: "index.css", line: 1, column: 9 });
  });

  it("does not trust @supports, a custom property, a comment or a string", () => {
    const css = `
      /* filter: blur(4px); */
      @supports (backdrop-filter: blur(1px)) { .a { backdrop-filter: blur(1px); } }
      .b { --filter: blur(2px); content: "filter: blur(1px);"; }
    `;
    const found = scan(css);
    expect(found.map((f) => f.what)).toEqual(["backdrop-filter"]);
    expect(found[0]?.line).toBe(3);
  });
});

describe("extractUiStylesheets compatibility gate", () => {
  async function build(css: string): Promise<{ root: string; run: () => Promise<string[]> }> {
    const root = await makeTempDir("tn-native-css-compat-");
    const ui = path.join(root, "ui");
    await mkdir(path.join(ui, "assets"), { recursive: true });
    await writeFile(path.join(ui, "assets", "index.css"), css);
    await mkdir(path.join(root, "build"));
    return { root, run: () => extractUiStylesheets(ui, path.join(root, "build", "ui-css")) };
  }

  it("fails the build naming every finding, and still writes the report", async () => {
    const { root, run } = await build(".a{filter:blur(2px)}\n.b{mix-blend-mode:multiply}\n");
    try {
      await expect(run()).rejects.toThrow(
        /TN_CSS_UI_UNSUPPORTED_CSS: 2 active rule\(s\)[\s\S]*filter[\s\S]*mix-blend-mode/u,
      );
      const report = JSON.parse(
        await readFile(path.join(root, "build", "native-css-compat.json"), "utf8"),
      );
      expect(report.findings).toHaveLength(2);
      // No project root, so no map, so a finding names the emitted stylesheet alone.
      expect(report.findings[0]).not.toHaveProperty("authored");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes an empty report for a clean stylesheet", async () => {
    const { root, run } = await build(".a{display:flex;gap:4px}\n");
    try {
      expect(await run()).toEqual(["index.css"]);
      const report = JSON.parse(
        await readFile(path.join(root, "build", "native-css-compat.json"), "utf8"),
      );
      expect(report).toEqual({ profile: "core", findings: [] });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("stages the raster images the UI build emitted, which no stylesheet names", async () => {
    const { root, run } = await build(".a{display:flex}\n");
    try {
      await writeFile(
        path.join(root, "ui", "assets", "icon-abc123.png"),
        Buffer.from([137, 80, 78, 71]),
      );
      await writeFile(path.join(root, "ui", "assets", "index-xyz.js"), "export {}");
      expect((await run()).sort()).toEqual(["icon-abc123.png", "index.css"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
