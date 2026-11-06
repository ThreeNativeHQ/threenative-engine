import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  collectQualityFindings,
  fatalQualityFindings,
  loadQualityBaseline,
  runQuality,
  updateQualityBaseline,
} from "../check-quality";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await makeTempDir("threenative-quality-");
  temporaryRoots.push(root);
  await writeFile(path.join(root, "biome.json"), JSON.stringify({ files: { ignore: [] } }));
  await mkdir(path.join(root, "packages", "core", "src"), { recursive: true });
  return root;
}

async function sourceFile(root: string, source: string): Promise<void> {
  await sourceFileAt(root, "core", "fixture.ts", source);
}

async function sourceFileAt(
  root: string,
  packageName: string,
  fileName: string,
  source: string,
): Promise<void> {
  const directory = path.join(root, "packages", packageName, "src");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, fileName), source);
}

describe("quality gate", () => {
  it("reports a file over the threshold and ignores one under it", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, `${"const line = 1;\n".repeat(401)}`);
    const findings = await collectQualityFindings(root);
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "file-length", value: 401, threshold: 400 }),
    );

    await sourceFile(root, `${"const line = 1;\n".repeat(399)}`);
    expect(await collectQualityFindings(root)).not.toContainEqual(
      expect.objectContaining({ signal: "file-length" }),
    );
  });

  it("reports only Biome ignores that overlap a package source root", async () => {
    const root = await fixtureRoot();
    const biomePath = path.join(root, "biome.json");

    await writeFile(
      biomePath,
      JSON.stringify({ files: { ignore: ["packages/core/vendor/generated.js"] } }),
    );
    expect(await collectQualityFindings(root)).not.toContainEqual(
      expect.objectContaining({ signal: "lint-coverage-hole" }),
    );

    for (const pattern of [
      "packages/core/src",
      "packages/core/src/generated.ts",
      "packages/core/**",
    ]) {
      await writeFile(biomePath, JSON.stringify({ files: { ignore: [pattern] } }));
      expect(await collectQualityFindings(root)).toContainEqual(
        expect.objectContaining({
          file: "packages/core/src",
          signal: "lint-coverage-hole",
        }),
      );
    }
  });

  it("reports generic and multiline object aliases but exempts mapped and other type aliases", async () => {
    const root = await fixtureRoot();
    await sourceFile(
      root,
      `type GenericBox<T> = {};
type MultilineBox = {
  value: string;
};
type GenericMapped<T> = { [K in keyof T]?: T[K] };
type ObjectUnion = { value: string } | null;
type Primitive = string;
type Callback = (value: string) => void;
type Tuple = [string];
`,
    );

    const findings = await collectQualityFindings(root);
    const objectAliases = findings.filter((item) => item.signal === "interface-in-disguise");
    expect(objectAliases).toHaveLength(2);
    expect(objectAliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 1, value: "object type alias" }),
        expect.objectContaining({ line: 2, value: "object type alias" }),
      ]),
    );
    expect(objectAliases).not.toContainEqual(expect.objectContaining({ line: 5 }));
  });

  it("honours a reasoned waiver and reports a reasonless waiver", async () => {
    const root = await fixtureRoot();
    await sourceFile(
      root,
      `// quality-allow: fixture intentionally exceeds the notice line\n${"const line = 1;\n".repeat(401)}`,
    );
    await updateQualityBaseline(root);
    await expect(runQuality(root)).resolves.toContainEqual(
      expect.objectContaining({ signal: "file-length", state: "waived" }),
    );

    await sourceFile(root, `// quality-allow:\n${"const line = 1;\n".repeat(401)}`);
    const findings = await collectQualityFindings(root);
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "waiver-without-reason", value: "" }),
    );
  });

  it("matches a line-order waiver to the following suppression before file length", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, `${"const line = 1;\n".repeat(401)}`);
    await updateQualityBaseline(root);

    await sourceFile(
      root,
      `// quality-allow: fixture suppression is intentional
// biome-ignore lint/suspicious/noExplicitAny
${"const line = 1;\n".repeat(399)}`,
    );
    const findings = await runQuality(root);
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "suppression/biome-ignore", line: 2, state: "waived" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "file-length", line: 1, state: "inherited" }),
    );
    expect(fatalQualityFindings(findings)).not.toContainEqual(
      expect.objectContaining({ signal: "suppression/biome-ignore" }),
    );
  });

  it("keeps a stale waiver actionable instead of waiving its own finding", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, "// quality-allow: the old finding was removed\nconst ready = true;\n");
    const baselinePath = path.join(root, "docs", "verification");
    await mkdir(baselinePath, { recursive: true });
    await writeFile(
      path.join(baselinePath, "quality-baseline.json"),
      JSON.stringify({ version: 1, generatedAt: "2026-08-11", counts: {}, findings: [] }),
    );

    const findings = await runQuality(root);
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "stale-waiver", state: "new" }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ signal: "stale-waiver", state: "waived" }),
    );
  });

  it("fails closed when the baseline is missing or malformed", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, "const ready = true;\n");
    await expect(loadQualityBaseline(root)).rejects.toThrow(/baseline missing/u);

    const baselinePath = path.join(root, "docs", "verification");
    await mkdir(baselinePath, { recursive: true });
    await writeFile(path.join(baselinePath, "quality-baseline.json"), "not json");
    await expect(loadQualityBaseline(root)).rejects.toThrow(/malformed quality baseline/iu);

    await writeFile(
      path.join(baselinePath, "quality-baseline.json"),
      JSON.stringify({ version: 1, generatedAt: "2026-08-11", counts: {}, findings: [{}] }),
    );
    await expect(loadQualityBaseline(root)).rejects.toThrow(/every finding needs/u);

    await writeFile(
      path.join(baselinePath, "quality-baseline.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-08-11",
        counts: { "file-length": 2 },
        findings: [
          {
            file: "packages/core/src/fixture.ts",
            line: 1,
            signal: "file-length",
            value: 401,
            threshold: 400,
          },
        ],
      }),
    );
    await expect(loadQualityBaseline(root)).rejects.toThrow(/counts must match findings/u);
  });

  it("writes a baseline whose counts describe its findings", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, `${"const line = 1;\n".repeat(401)}`);
    const baseline = await updateQualityBaseline(root);
    const onDisk = JSON.parse(
      await readFile(path.join(root, "docs", "verification", "quality-baseline.json"), "utf8"),
    ) as { counts: Record<string, number>; findings: { signal: string }[] };
    expect(onDisk.findings).toHaveLength(baseline.findings.length);
    expect(onDisk.counts["file-length"]).toBe(1);
  });

  it("regenerates suppression thresholds without stale values", async () => {
    const root = await fixtureRoot();
    await sourceFile(
      root,
      `const value = input as unknown as string;
// biome-ignore lint/suspicious/noExplicitAny
const ignored: any = value;
`,
    );

    const baseline = await updateQualityBaseline(root);
    const suppressionFindings = baseline.findings.filter((item) =>
      item.signal.startsWith("suppression/"),
    );
    expect(suppressionFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: "suppression/unknown-cast", threshold: 10 }),
        expect.objectContaining({ signal: "suppression/biome-ignore", threshold: 1 }),
      ]),
    );
    expect(suppressionFindings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threshold: 14 }),
        expect.objectContaining({ threshold: 2 }),
      ]),
    );
  });

  // scenario.ts-shaped: the same file:signal records a larger measured value than the
  // baseline's — that is growth, not an inherited coordinate.
  it("should mark a hotspot grew when its value rises past the baseline", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, `${"const line = 1;\n".repeat(401)}`);
    await updateQualityBaseline(root);

    await sourceFile(root, `${"const line = 1;\n".repeat(450)}`);
    const findings = await runQuality(root);
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "file-length", value: 450, state: "grew" }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ signal: "file-length", state: "inherited" }),
    );
  });

  it("should stay inherited when only the line moved", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, "const value = input as unknown as string;\n");
    await updateQualityBaseline(root);

    await sourceFile(
      root,
      "// a comment shifts the finding down one line\nconst value = input as unknown as string;\n",
    );
    const findings = await runQuality(root);
    expect(findings).toContainEqual(
      expect.objectContaining({
        signal: "suppression/unknown-cast",
        line: 2,
        state: "inherited",
      }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ signal: "suppression/unknown-cast", state: "new" }),
    );
  });

  it("keeps a new same-signal suppression fatal after a waived inherited finding", async () => {
    const root = await fixtureRoot();
    const inherited =
      "// quality-allow: the first suppression is intentionally inherited\n" +
      "// biome-ignore lint/suspicious/noExplicitAny\nconst value: any = 1;\n";
    await sourceFile(root, inherited);
    await updateQualityBaseline(root);

    await sourceFile(
      root,
      `${inherited}// biome-ignore lint/suspicious/noExplicitAny\nconst next: any = value;\n`,
    );
    const findings = await runQuality(root);
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "suppression/biome-ignore", line: 2, state: "waived" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "suppression/biome-ignore", line: 4, state: "new" }),
    );
    expect(fatalQualityFindings(findings)).toContainEqual(
      expect.objectContaining({ signal: "suppression/biome-ignore", line: 4, state: "new" }),
    );
  });

  it("does not spend an inherited same-signal baseline row on a waived addition", async () => {
    const root = await fixtureRoot();
    const suppression = "// biome-ignore lint/suspicious/noExplicitAny\n";
    const inherited = `${suppression}const existing: any = 1;\n`;
    await sourceFile(root, inherited);
    await updateQualityBaseline(root);

    await sourceFile(
      root,
      `// quality-allow: the new suppression is intentional\n${suppression}const added: any = 1;\n${inherited}`,
    );
    const waivedFindings = await runQuality(root);
    expect(waivedFindings).toContainEqual(
      expect.objectContaining({ signal: "suppression/biome-ignore", line: 2, state: "waived" }),
    );
    expect(waivedFindings).toContainEqual(
      expect.objectContaining({ signal: "suppression/biome-ignore", line: 4, state: "inherited" }),
    );
    expect(fatalQualityFindings(waivedFindings)).toEqual([]);

    await sourceFile(root, `${suppression}const added: any = 1;\n${inherited}`);
    const unwaivedFindings = await runQuality(root);
    expect(fatalQualityFindings(unwaivedFindings)).toContainEqual(
      expect.objectContaining({ signal: "suppression/biome-ignore", state: "new" }),
    );
  });

  it("should keep fail-closed baseline validation", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, "const ready = true;\n");
    const baselinePath = path.join(root, "docs", "verification");
    await mkdir(baselinePath, { recursive: true });
    await writeFile(
      path.join(baselinePath, "quality-baseline.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-08-22",
        counts: {},
        findings: [{ file: "packages/core/src/fixture.ts", signal: "file-length" }],
      }),
    );
    await expect(loadQualityBaseline(root)).rejects.toThrow(/every finding needs/u);
  });

  it("makes new suppression-class findings fatal while keeping advisory length findings report-only", async () => {
    const root = await fixtureRoot();
    await sourceFile(
      root,
      `${"const line = 1;\n".repeat(401)}// biome-ignore lint/suspicious/noExplicitAny\nconst value: any = 1;\n`,
    );
    await updateQualityBaseline(root);
    await sourceFile(
      root,
      `${"const line = 1;\n".repeat(401)}// biome-ignore lint/suspicious/noExplicitAny\nconst value: any = 1;\n// biome-ignore lint/suspicious/noExplicitAny\nconst next: any = value;\n`,
    );

    const fatal = fatalQualityFindings(await runQuality(root));
    expect(fatal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: "suppression/biome-ignore", state: "new" }),
      ]),
    );
    expect(fatal).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ signal: "file-length" })]),
    );
  });

  it("makes an unwaived runtime-native suppression fatal", async () => {
    const root = await fixtureRoot();
    await sourceFileAt(root, "runtime-native", "fixture.ts", "const ready = true;\n");
    await updateQualityBaseline(root);
    await sourceFileAt(
      root,
      "runtime-native",
      "fixture.ts",
      "// biome-ignore lint/suspicious/noExplicitAny\nconst value: any = 1;\n",
    );

    const findings = await runQuality(root);
    expect(findings).toContainEqual(
      expect.objectContaining({
        file: "packages/runtime-native/src/fixture.ts",
        signal: "suppression/biome-ignore",
        state: "new",
      }),
    );
    expect(fatalQualityFindings(findings)).toContainEqual(
      expect.objectContaining({ file: "packages/runtime-native/src/fixture.ts" }),
    );
  });

  // PRD-800 phase 1, green on the pre-cap code: 3 000 lines is only a report-only `file-length`.
  it("reports a file just over the 3 000-line cap without failing the gate", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, `${"const line = 1;\n".repeat(3001)}`);
    await updateQualityBaseline(root);
    const findings = await runQuality(root);
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "file-length", value: 3001, state: "inherited" }),
    );
    expect(fatalQualityFindings(findings)).toEqual([]);
  });

  // AC-1: a file the baseline does not record, over the cap, fails and names the file.
  it("fails a source file over the 3 000-line cap that no baseline records", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, `${"const line = 1;\n".repeat(2999)}`);
    await updateQualityBaseline(root);

    await sourceFile(root, `${"const line = 1;\n".repeat(3001)}`);
    const findings = await runQuality(root);
    expect(findings).toContainEqual(
      expect.objectContaining({ signal: "file-cap", value: 3001, threshold: 3000, state: "new" }),
    );
    expect(fatalQualityFindings(findings)).toContainEqual(
      expect.objectContaining({ file: "packages/core/src/fixture.ts", signal: "file-cap" }),
    );
  });

  // AC-2: a baselined file may shrink and may not grow; shrinking tightens the entry.
  it("fails a baselined file that grows past the cap and tightens one that shrinks", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, `${"const line = 1;\n".repeat(3100)}`);
    await updateQualityBaseline(root);

    await sourceFile(root, `${"const line = 1;\n".repeat(3150)}`);
    expect(fatalQualityFindings(await runQuality(root))).toContainEqual(
      expect.objectContaining({ signal: "file-cap", value: 3150, state: "grew" }),
    );

    await sourceFile(root, `${"const line = 1;\n".repeat(3050)}`);
    const shrank = await runQuality(root);
    expect(shrank).toContainEqual(
      expect.objectContaining({ signal: "file-cap", value: 3050, state: "inherited" }),
    );
    expect(fatalQualityFindings(shrank)).toEqual([]);

    const tightened = await updateQualityBaseline(root);
    expect(tightened.findings).toContainEqual(
      expect.objectContaining({ signal: "file-cap", value: 3050, threshold: 3000 }),
    );

    await sourceFile(root, `${"const line = 1;\n".repeat(3000)}`);
    const dropped = await updateQualityBaseline(root);
    expect(dropped.findings).not.toContainEqual(expect.objectContaining({ signal: "file-cap" }));
  });

  it("makes a waiver without a reason fatal", async () => {
    const root = await fixtureRoot();
    await sourceFile(root, "// quality-allow:\nconst value = 1;\n");
    await updateQualityBaseline(root);
    const fatal = fatalQualityFindings(await runQuality(root));
    expect(fatal).toContainEqual(expect.objectContaining({ signal: "waiver-without-reason" }));
  });
});
