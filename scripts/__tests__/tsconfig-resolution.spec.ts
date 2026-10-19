import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../..");
const config = ts.readConfigFile(path.join(repo, "tsconfig.json"), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, repo).options;
const resolve = (name: string) =>
  ts.resolveModuleName(name, path.join(repo, "scripts/typecheck-probe.ts"), options, ts.sys)
    .resolvedModule?.resolvedFileName;

it("resolves the public core playtest subpath against the same source cohort as core", () => {
  expect(resolve("@threenative/core/playtest")).toBe(
    path.join(repo, "packages/core/src/playtest.ts"),
  );
});

it("keeps private core modules behind the package export boundary", () => {
  expect(resolve("@threenative/core/animation")).toBeUndefined();
});
