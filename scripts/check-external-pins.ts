/**
 * Fails when a `threenative-*` package that this repo pins from npm is older than npm's `latest`.
 * Those packages ship from their own repos (the asset and sculpt MCP servers), so a release there
 * moves nothing here until somebody bumps the pin, and nobody was told when they forgot.
 * It runs in `release:prepare` and in the nightly audit, never on a pull request: a publish
 * elsewhere would turn every open PR red.
 */
import fs from "node:fs";
import path from "node:path";
import { type RegistryLookup, npmLookup } from "./check-publish-state.js";

const REPO = path.resolve(import.meta.dirname, "..");
const EXACT = /^\d+\.\d+\.\d+$/u;

/** One line per pinned external package that npm has moved past. Unreachable npm throws. */
export function externalPinFindings(repo: string, lookup: RegistryLookup): readonly string[] {
  const core = JSON.parse(
    fs.readFileSync(path.join(repo, "packages", "core", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const findings: string[] = [];
  for (const [name, pinned] of Object.entries(core.dependencies ?? {})) {
    if (!name.startsWith("threenative-") || !EXACT.test(pinned)) continue;
    const facts = lookup(name);
    if (facts.state === "unreachable")
      throw new Error(
        `TN_EXTERNAL_PIN_REGISTRY_UNREACHABLE: could not read the npm latest version of ${name}.`,
      );
    if (facts.state === "present" && facts.version !== pinned)
      findings.push(
        `${name} is pinned at ${pinned}, npm latest is ${facts.version}. Bump the pin in packages/core/package.json, then run pnpm install and pnpm tsx scripts/capture-asset-mcp-tools.ts.`,
      );
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = externalPinFindings(REPO, npmLookup(REPO));
  for (const finding of findings) process.stderr.write(`TN_EXTERNAL_PIN_STALE: ${finding}\n`);
  if (findings.length === 0) process.stdout.write("External pins match npm latest.\n");
  process.exitCode = findings.length === 0 ? 0 : 1;
}
