import { CORE_PACKAGE_VERSION } from "./mcp-servers.js";

/** `major.minor.patch`, with any prerelease or build suffix, as numbers; `undefined` otherwise. */
function parts(value: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  if (match === null) return undefined;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parsed.every(Number.isSafeInteger) ? parsed : undefined;
}

/**
 * `0.3.13` -> `>=0.3.13`, matching what the templates ship. The scaffolder writes the specifier and
 * the gates compare against it, so both spellings live in one place.
 */
export const CORE_TEMPLATE_FLOOR = `>=${CORE_PACKAGE_VERSION}`;

/**
 * Whether a game's installed core can carry the authoring layer this create-threenative writes.
 *
 * Any release at or after the one this package was built against, and never an older one. The
 * templates ship `>=`, so a game scaffolded today installs whatever the registry calls newest —
 * regularly newer than the create-threenative that wrote it — and exact equality turned every one
 * of those into a refusal on a correct install. The case this check exists for is the opposite
 * one: a game whose install is behind the CLI, where the layer would name MCP shims its core does
 * not have (PRD-829). `assertMcpShims` and the engine's own `tn_version_handshake` still fail
 * closed on a pair that cannot work; this is the readable error in front of them.
 */
export function pairsWithCore(installed: string | undefined): boolean {
  if (installed === undefined) return false;
  const have = parts(installed);
  const paired = parts(CORE_PACKAGE_VERSION);
  if (have === undefined || paired === undefined) return false;
  const [haveMajor, haveMinor, havePatch] = have;
  const [pairedMajor, pairedMinor, pairedPatch] = paired;
  if (haveMajor !== pairedMajor) return haveMajor > pairedMajor;
  if (haveMinor !== pairedMinor) return haveMinor > pairedMinor;
  return havePatch >= pairedPatch;
}
