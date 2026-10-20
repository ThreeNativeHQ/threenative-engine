import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { qualityConfig } from "../src/quality/index.js";

let root: string;
const FILES = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      lib: ["ES2022", "DOM"],
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      target: "ES2022",
      jsx: "react-jsx",
    },
    include: ["src"],
  }),
};

beforeAll(async () => {
  root = await makeTempDir("tn-quality-");
  mkdirSync(path.join(root, "src"));
  for (const [name, text] of Object.entries(FILES)) writeFileSync(path.join(root, name), text);
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
});
afterAll(() => rmSync(root, { force: true, recursive: true }));

async function lint(name: string, source: string, withReact = false) {
  const file = path.join(root, "src", name);
  writeFileSync(file, source);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", dependencies: withReact ? { react: "19.2.0" } : {} }),
  );
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: qualityConfig({ root }),
    overrideConfigFile: true,
  });
  const [result] = await eslint.lintFiles([file]);
  if (result === undefined) throw new Error("no lint result");
  return {
    before: readFileSync(file, "utf8"),
    messages: result.messages.map((m) => ({ rule: m.ruleId, severity: m.severity })),
    source,
  };
}
const rules = (r: { messages: Array<{ rule: string | null }> }) => r.messages.map((m) => m.rule);

describe("generated-game quality config", () => {
  it("rejects a floating Promise and passes the repaired file", async () => {
    const bad = await lint(
      "a.ts",
      "async function load(): Promise<number> { return 1; }\nexport function start(): void { load(); }\n",
    );
    expect(rules(bad)).toContain("@typescript-eslint/no-floating-promises");
    expect(
      bad.messages.find((m) => m.rule === "@typescript-eslint/no-floating-promises")?.severity,
    ).toBe(2);
    const ok = await lint(
      "a.ts",
      "async function load(): Promise<number> { return 1; }\nexport async function start(): Promise<void> { await load(); }\nexport function again(): void { load().catch(() => undefined); }\n",
    );
    expect(ok.messages).toEqual([]);
  });

  it("accepts an explicit `void` and still rejects the bare call", async () => {
    const source = (call: string) =>
      `async function load(): Promise<void> {}\nexport function start(): void { ${call} }\n`;
    expect((await lint("a.ts", source("void load();"))).messages).toEqual([]);
    expect(rules(await lint("a.ts", source("load();")))).toContain(
      "@typescript-eslint/no-floating-promises",
    );
  });

  it("rejects an async callback given to a synchronous slot", async () => {
    const r = await lint(
      "a.ts",
      "export function run(cb: () => void): void { cb(); }\nrun(async () => { await Promise.resolve(); });\n",
    );
    expect(rules(r)).toContain("@typescript-eslint/no-misused-promises");
  });

  it("flags an unused binding but allows `_` parameters and type-only imports", async () => {
    const r = await lint(
      "a.ts",
      'import type { Foo } from "./b.js";\nexport const f = (_dt: number): Foo | undefined => undefined;\nconst unused = 1;\n',
    );
    expect(rules(r)).toEqual(["@typescript-eslint/no-unused-vars"]);
  });

  it("requires a reason on a suppression and rejects an unused one", async () => {
    const noReason = await lint("a.ts", "// eslint-disable-next-line no-debugger\ndebugger;\n");
    expect(rules(noReason)).toContain("@eslint-community/eslint-comments/require-description");
    const unused = await lint(
      "a.ts",
      "// eslint-disable-next-line no-debugger -- not needed\nexport const x = 1;\n",
    );
    expect(unused.messages.some((m) => m.rule === null && m.severity === 2)).toBe(true);
  });

  it("applies the hook rules to TSX only when React is installed", async () => {
    const tsx =
      'import { useEffect, useState } from "react";\nexport function C({ a }: { a: boolean }) {\n  if (a) useState(0);\n  useEffect(() => { void a; }, []);\n  return null;\n}\n';
    const without = await lint("c.tsx", tsx);
    expect(rules(without).some((id) => id?.startsWith("react-hooks/"))).toBe(false);
    const withReact = await lint("c.tsx", tsx, true);
    expect(rules(withReact)).toEqual(
      expect.arrayContaining(["react-hooks/rules-of-hooks", "react-hooks/exhaustive-deps"]),
    );
  });
});

const SCENE = (body: string) =>
  `import { Scene } from "@threenative/core";\nimport { Vector3 as V3 } from "three";\nimport * as THREE from "three";\nexport class Play extends Scene {\n  static readonly used = [V3, THREE];\n${body}\n}\n`;

describe("threenative/hot-callback-allocation", () => {
  it("warns, without failing, on math constructors in Scene.update through aliases and namespaces", async () => {
    const r = await lint(
      "s.ts",
      SCENE(
        "  override update(): void { const a = new V3(); const b = new THREE.Quaternion(); void a; void b; }",
      ),
    );
    const hot = r.messages.filter((m) => m.rule === "threenative/hot-callback-allocation");
    expect(hot).toHaveLength(2);
    expect(hot.every((m) => m.severity === 1)).toBe(true);
    expect(r.messages.some((m) => m.severity === 2)).toBe(false);
  });

  it("warns inside a directly registered ctx.beforeRender callback", async () => {
    const r = await lint(
      "s.ts",
      SCENE(
        "  override load(ctx: { beforeRender(fn: () => void): void }): void { ctx.beforeRender(() => { void new V3(); }); }",
      ),
    );
    expect(rules(r)).toEqual(["threenative/hot-callback-allocation"]);
  });

  it("stays quiet for startup allocation, deferred functions, non-scene classes and unrelated classes", async () => {
    const quiet = await lint(
      "s.ts",
      SCENE(
        "  readonly #start = new V3();\n  override load(): void { void new V3(); }\n  override update(): void { const later = () => new V3(); void later; }",
      ),
    );
    expect(quiet.messages).toEqual([]);
    const other = await lint(
      "o.ts",
      'import { Vector3 } from "three";\nclass Other { update(): void { void new Vector3(); } }\nclass Vector2 {}\nexport class P { render(): void { void new Vector2(); } }\nexport { Other };\n',
    );
    expect(other.messages).toEqual([]);
  });

  it("leaves authored bytes unchanged", async () => {
    const r = await lint("s.ts", SCENE("  override update(): void { void new V3(); }"));
    expect(r.before).toBe(r.source);
  });
});
