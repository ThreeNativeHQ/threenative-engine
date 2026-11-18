import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { externalPinFindings } from "../check-external-pins.js";
import type { RegistryLookup } from "../check-publish-state.js";

function repoWith(dependencies: Record<string, string>): string {
  const repo = makeTempDirSync("tn-pins-");
  fs.mkdirSync(path.join(repo, "packages", "core"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "packages", "core", "package.json"),
    JSON.stringify({ name: "@threenative/core", dependencies }),
  );
  return repo;
}
const latest =
  (versions: Record<string, string>): RegistryLookup =>
  (name) =>
    name in versions
      ? { state: "present", version: versions[name] as string }
      : { state: "absent" };

describe("external pins", () => {
  it("names a pinned threenative-* package that npm has moved past", () => {
    const repo = repoWith({ "threenative-asset-mcp": "0.16.1", three: "0.170.0" });
    expect(externalPinFindings(repo, latest({ "threenative-asset-mcp": "0.17.0" }))).toEqual([
      expect.stringContaining("threenative-asset-mcp is pinned at 0.16.1, npm latest is 0.17.0"),
    ]);
  });

  it("passes a current pin and ignores workspace and third-party dependencies", () => {
    const repo = repoWith({
      "threenative-asset-mcp": "0.17.0",
      "@threenative/physics": "workspace:*",
      three: "0.170.0",
    });
    expect(externalPinFindings(repo, latest({ "threenative-asset-mcp": "0.17.0" }))).toEqual([]);
  });

  it("fails closed when the registry cannot answer", () => {
    const repo = repoWith({ "threenative-asset-mcp": "0.16.1" });
    expect(() => externalPinFindings(repo, () => ({ state: "unreachable" }))).toThrow(
      /TN_EXTERNAL_PIN_REGISTRY_UNREACHABLE/u,
    );
  });
});
