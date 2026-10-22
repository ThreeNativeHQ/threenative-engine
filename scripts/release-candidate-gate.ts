import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { publicWorkspacePackages } from "./workspace-packages.js";

const REPO = resolve(import.meta.dirname, "..");
const { PREBUILT_ASSET_NAMES } = (await import(
  new URL("../packages/runtime-native/scripts/install-prebuilt.mjs", import.meta.url).href
)) as { readonly PREBUILT_ASSET_NAMES: Readonly<Record<string, string>> };

export const REQUIRED_CREDENTIALS = [
  "npmPublish",
  "linuxAttestation",
  "windowsSigning",
  "macosSigning",
  "macosNotarization",
  "androidSigning",
  "iosSigning",
  "iosExport",
] as const;

export const REQUIRED_HOSTED_CAPABILITIES = [
  "ubuntuRunner",
  "windowsRunner",
  "macosRunner",
  "androidSdk",
  "xcode",
  "timestampService",
] as const;

const REQUIRED_RUN_WORKFLOWS = {
  ci: ".github/workflows/ci.yml",
  native: ".github/workflows/native-platforms.yml",
} as const;

type CredentialName = (typeof REQUIRED_CREDENTIALS)[number];
type HostedCapabilityName = (typeof REQUIRED_HOSTED_CAPABILITIES)[number];

export const RELEASE_PLATFORMS = ["linux", "windows", "macos", "android", "ios"] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

// A release declares which platforms it ships and whether it is signed. Before this existed the
// gate demanded all eight credentials and all six capabilities unconditionally, so a repository
// holding only NPM_TOKEN could never publish anything: seven blockers, BLOCKED, exit 2, on every
// candidate. The narrowing is a declaration rather than a deletion - an unsigned release must say
// so, it is recorded in the candidate artifact, and `platforms` must still cover every asset the
// release publishes, so a platform's runner requirement cannot be dropped while its binary ships.
export interface IReleaseScope {
  readonly platforms: readonly ReleasePlatform[];
  readonly signed: boolean;
}

export const FULL_RELEASE_SCOPE: IReleaseScope = {
  platforms: RELEASE_PLATFORMS,
  signed: true,
};

const PLATFORM_SIGNING_CREDENTIALS: Readonly<Record<ReleasePlatform, readonly CredentialName[]>> = {
  linux: ["linuxAttestation"],
  windows: ["windowsSigning"],
  macos: ["macosSigning", "macosNotarization"],
  android: ["androidSigning"],
  ios: ["iosSigning", "iosExport"],
};

const PLATFORM_HOSTED_CAPABILITIES: Readonly<
  Record<ReleasePlatform, readonly HostedCapabilityName[]>
> = {
  linux: ["ubuntuRunner"],
  windows: ["windowsRunner"],
  macos: ["macosRunner"],
  android: ["ubuntuRunner", "androidSdk"],
  ios: ["macosRunner", "xcode"],
};

const PLATFORM_ASSET_PREFIXES: Readonly<Record<ReleasePlatform, string>> = {
  linux: "linux-",
  windows: "win32-",
  macos: "darwin-",
  android: "android-",
  ios: "ios-",
};

function assertDeclaredPlatforms(scope: IReleaseScope): void {
  // parseReleaseScope rejects an empty list, but these are exported: a caller reaching them
  // directly must not silently receive a near-empty requirement set.
  if (scope.platforms.length === 0)
    throw new Error("TN_RELEASE_SCOPE_EMPTY: a release scope must declare at least one platform.");
}

export function requiredCredentials(scope: IReleaseScope): readonly CredentialName[] {
  assertDeclaredPlatforms(scope);
  const names = new Set<CredentialName>(["npmPublish"]);
  if (scope.signed)
    for (const platform of scope.platforms)
      for (const credential of PLATFORM_SIGNING_CREDENTIALS[platform]) names.add(credential);
  return REQUIRED_CREDENTIALS.filter((name) => names.has(name));
}

export function requiredHostedCapabilities(scope: IReleaseScope): readonly HostedCapabilityName[] {
  assertDeclaredPlatforms(scope);
  const names = new Set<HostedCapabilityName>();
  for (const platform of scope.platforms)
    for (const capability of PLATFORM_HOSTED_CAPABILITIES[platform]) names.add(capability);
  // Only a signed release needs a trusted countersignature for its signatures.
  if (scope.signed) names.add("timestampService");
  return REQUIRED_HOSTED_CAPABILITIES.filter((name) => names.has(name));
}

/**
 * Platforms whose binaries a non-iOS release actually publishes, derived from the asset key table.
 *
 * iOS keeps its own release gate and is not a supported target: the strict consumer default and the
 * release proof cohort both publish only `!key.startsWith("ios-")` (install-prebuilt.mjs,
 * native-release.yml), and a declared scope that names iOS can never pass while `xcode` is absent.
 * Counting the iOS asset here made every non-iOS release unsatisfiable — the scope had to name iOS
 * to cover it and was then BLOCKED on the missing Xcode capability.
 */
export function platformsCoveringPublishedAssets(): readonly ReleasePlatform[] {
  const covered = new Set<ReleasePlatform>();
  for (const key of Object.keys(PREBUILT_ASSET_NAMES)) {
    if (key.startsWith("ios-")) continue;
    const platform = RELEASE_PLATFORMS.find((candidate) =>
      key.startsWith(PLATFORM_ASSET_PREFIXES[candidate]),
    );
    // An asset key matching no prefix would be silently uncovered by the scope check, which is
    // exactly the input nobody notices adding. Refuse it instead.
    if (platform === undefined)
      throw new Error(
        `TN_RELEASE_ASSET_PLATFORM_UNKNOWN: prebuilt asset key '${key}' matches no release platform prefix.`,
      );
    covered.add(platform);
  }
  return RELEASE_PLATFORMS.filter((platform) => covered.has(platform));
}
type RegistryState = "absent" | "matching";

export type ReleaseReportType = "parity" | "provenance";

export interface IReleasePackage {
  readonly name: string;
  readonly version: string;
  readonly registryState: RegistryState;
  readonly integrity?: string;
  readonly packedSha256?: string;
  readonly normalizedSha256?: string;
}

export interface IReleaseRun {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly workflowPath: string;
}

export interface IReleaseReport {
  readonly reportSchemaVersion: 1;
  readonly reportType: ReleaseReportType;
  readonly candidateSha: string;
  readonly verdict: "PASS";
  readonly reportSha256: string;
  readonly sourceRunId: number;
  readonly sourceWorkflowPath: string;
  readonly artifactName: string;
  readonly artifactPath: string;
  readonly subjects: readonly string[];
}

export interface IReleaseCandidate {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly tag: string;
  readonly candidateSha: string;
  readonly runtimeVersion: string;
  readonly packageCohort: readonly IReleasePackage[];
  readonly requiredRuns: { readonly ci: IReleaseRun; readonly native: IReleaseRun };
  readonly parity: IReleaseReport & { readonly verdict: "PASS" };
  readonly provenance: IReleaseReport & { readonly subjects: readonly string[] };
  readonly subjects: { readonly github: readonly string[]; readonly npm: readonly string[] };
  readonly credentials: Readonly<Record<CredentialName, boolean>>;
  readonly hostedCapabilities: Readonly<Record<HostedCapabilityName, boolean>>;
  readonly releaseScope: IReleaseScope;
  readonly resolution: IReleaseResolution;
}

export interface IReleaseResolution {
  readonly producerRunId: number;
  readonly source: "release-candidate-workflow";
  readonly packageSource: "workspace-manifests";
  readonly githubSubjectSource: "runtime-native-prebuilt-keys";
  readonly evidenceSource: "github-api-and-artifacts";
  readonly registrySource: "npm-version-metadata-and-tarballs";
  readonly availabilitySource: "workflow-inputs";
  readonly registryVerified: true;
  readonly evidenceVerified: true;
}

export type ReleaseCandidateStatus = "PASS" | "FAIL" | "BLOCKED";

export interface IReleaseCandidateValidation {
  readonly status: ReleaseCandidateStatus;
  readonly exitCode: 0 | 1 | 2;
  readonly errors: readonly string[];
  readonly blockers: readonly string[];
}

export interface IReleaseCandidateRequest {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly tag: string;
  readonly candidateSha: string;
  readonly runtimeVersion: string;
  readonly requiredRunIds: { readonly ci: number; readonly native: number };
  readonly reportArtifacts: {
    readonly parity: IReleaseReportReference;
    readonly provenance: IReleaseReportReference;
  };
  /** Optional on the wire; an omitted scope parses to the historical every-platform signed set. */
  readonly releaseScope: IReleaseScope;
}

export interface IReleaseReportReference {
  readonly runId: number;
  readonly workflowPath: string;
  readonly artifactName: string;
  readonly artifactPath: string;
}

export interface IReleaseAvailability {
  readonly credentials: Readonly<Record<CredentialName, boolean>>;
  readonly hostedCapabilities: Readonly<Record<HostedCapabilityName, boolean>>;
}

export interface IRegistryObservation {
  readonly state: RegistryState;
  readonly integrity?: string;
  readonly packedSha256?: string;
  readonly normalizedSha256?: string;
}

export interface IReleaseCandidateResolutionOptions {
  readonly request: unknown;
  readonly availability: unknown;
  readonly repo?: string;
  readonly expectedRepository?: string;
  readonly invokingSha: string;
  readonly producerRunId: number;
  readonly resolveRun?: (
    repository: string,
    runId: number,
    candidateSha: string,
    workflowPath: string,
  ) => IReleaseRun | Promise<IReleaseRun>;
  readonly resolveReport?: (
    repository: string,
    candidateSha: string,
    reference: IReleaseReportReference,
    reportType: ReleaseReportType,
  ) => IReleaseReport | Promise<IReleaseReport>;
  readonly registryLookup?: (
    packageName: string,
    version: string,
  ) => IRegistryObservation | Promise<IRegistryObservation>;
  readonly workspacePackageHash?: (
    packageName: string,
    version: string,
  ) => string | Promise<string>;
}

type RecordValue = Record<string, unknown>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;
const SHA1_PATTERN = /^[a-f0-9]{40}$/iu;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const PACKAGE_NAME_PATTERN = /^\S+$/u;
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const ARTIFACT_NAME_PATTERN = /^[^/\\]+$/u;
const NPM_INTEGRITY_PATTERN = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/u;

const CANDIDATE_KEYS = [
  "schemaVersion",
  "repository",
  "tag",
  "candidateSha",
  "runtimeVersion",
  "packageCohort",
  "requiredRuns",
  "parity",
  "provenance",
  "subjects",
  "credentials",
  "hostedCapabilities",
  "releaseScope",
  "resolution",
];
/** `releaseScope` is optional: omitted, it means the historical every-platform signed contract. */
const CANDIDATE_REQUIRED_KEYS = CANDIDATE_KEYS.filter((key) => key !== "releaseScope");
const PACKAGE_KEYS = [
  "name",
  "version",
  "registryState",
  "integrity",
  "packedSha256",
  "normalizedSha256",
];
const RUN_KEYS = [
  "databaseId",
  "status",
  "conclusion",
  "event",
  "headBranch",
  "headSha",
  "workflowPath",
];
const REPORT_KEYS = [
  "reportSchemaVersion",
  "reportType",
  "candidateSha",
  "verdict",
  "reportSha256",
  "sourceRunId",
  "sourceWorkflowPath",
  "artifactName",
  "artifactPath",
  "subjects",
];
const RESOLUTION_KEYS = [
  "producerRunId",
  "source",
  "packageSource",
  "githubSubjectSource",
  "evidenceSource",
  "registrySource",
  "availabilitySource",
  "registryVerified",
  "evidenceVerified",
];
const REQUEST_KEYS = [
  "schemaVersion",
  "repository",
  "tag",
  "candidateSha",
  "runtimeVersion",
  "requiredRunIds",
  "reportArtifacts",
  "releaseScope",
];
const REQUEST_REQUIRED_KEYS = REQUEST_KEYS.filter((key) => key !== "releaseScope");
const REPORT_REFERENCE_KEYS = ["runId", "workflowPath", "artifactName", "artifactPath"];

const PARITY_REPORT_SUBJECTS = ["android", "desktop", "web"] as const;
const PROVENANCE_REPORT_SHA_FIELDS = [
  "dependencyLockSha256",
  "sbomSha256",
  "licenseInventorySha256",
  "pnpmLockSha256",
  "cargoLockSha256",
] as const;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysOf(value: RecordValue): string[] {
  return Object.keys(value);
}

function checkKeys(
  value: RecordValue,
  expected: readonly string[],
  where: string,
  errors: string[],
  required = expected,
): void {
  const expectedSet = new Set(expected);
  for (const key of keysOf(value)) {
    if (!expectedSet.has(key)) errors.push(`${where} has unknown key '${key}'.`);
  }
  for (const key of required) {
    if (!(key in value)) errors.push(`${where} is missing '${key}'.`);
  }
}

function stringValue(value: unknown, where: string, errors: string[]): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${where} must be a non-empty string.`);
    return undefined;
  }
  return value;
}

function shaValue(value: unknown, where: string, errors: string[]): string | undefined {
  const result = stringValue(value, where, errors);
  if (result !== undefined && !SHA1_PATTERN.test(result)) {
    errors.push(`${where} must be a 40-character hexadecimal commit SHA.`);
    return undefined;
  }
  return result;
}

function sha256Value(value: unknown, where: string, errors: string[]): string | undefined {
  const result = stringValue(value, where, errors);
  if (result !== undefined && !SHA256_PATTERN.test(result)) {
    errors.push(`${where} must be a 64-character hexadecimal SHA-256.`);
    return undefined;
  }
  return result;
}

function positiveId(value: unknown, where: string, errors: string[]): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    errors.push(`${where} must be a positive safe integer.`);
    return undefined;
  }
  return value;
}

function safeArtifactPath(value: unknown, where: string, errors: string[]): string | undefined {
  const result = stringValue(value, where, errors);
  if (result === undefined) return undefined;
  const normalized = result.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    errors.push(`${where} must be a relative artifact path without '..'.`);
    return undefined;
  }
  return result;
}

function safeArtifactName(value: unknown, where: string, errors: string[]): string | undefined {
  const result = stringValue(value, where, errors);
  if (result === undefined) return undefined;
  if (
    !ARTIFACT_NAME_PATTERN.test(result) ||
    result === "." ||
    result === ".." ||
    [...result].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  )
    errors.push(`${where} must be a single safe artifact name.`);
  return result;
}

function validateRun(
  value: unknown,
  where: string,
  candidateSha: string | undefined,
  workflowPath: string,
  errors: string[],
): value is IReleaseRun {
  if (!isRecord(value)) {
    errors.push(`${where} must be an object.`);
    return false;
  }
  checkKeys(value, RUN_KEYS, where, errors);
  const databaseId = value.databaseId;
  if (typeof databaseId !== "number" || !Number.isSafeInteger(databaseId) || databaseId <= 0)
    errors.push(`${where}.databaseId must be a positive safe integer.`);
  for (const field of ["status", "conclusion", "event", "headBranch", "workflowPath"] as const)
    stringValue(value[field], `${where}.${field}`, errors);
  const headSha = shaValue(value.headSha, `${where}.headSha`, errors);
  if (
    headSha !== undefined &&
    candidateSha !== undefined &&
    headSha.toLowerCase() !== candidateSha.toLowerCase()
  )
    errors.push(`${where}.headSha must equal candidateSha.`);
  if (value.status !== "completed") errors.push(`${where}.status must be 'completed'.`);
  if (value.conclusion !== "success") errors.push(`${where}.conclusion must be 'success'.`);
  // native-platforms.yml never runs on push on its own: ci.yml calls it as a reusable workflow, so
  // the only standalone run of it is a manual dispatch on main. Demanding `push` for it made every
  // release candidate unsatisfiable.
  const events = workflowPath.endsWith("native-platforms.yml")
    ? ["push", "workflow_dispatch"]
    : ["push"];
  if (typeof value.event !== "string" || !events.includes(value.event))
    errors.push(`${where}.event must be ${events.map((event) => `'${event}'`).join(" or ")}.`);
  if (value.headBranch !== "main") errors.push(`${where}.headBranch must be 'main'.`);
  if (value.workflowPath !== workflowPath)
    errors.push(`${where}.workflowPath must be '${workflowPath}'.`);
  return true;
}

function validateReport(
  value: unknown,
  where: string,
  candidateSha: string | undefined,
  reportType: ReleaseReportType,
  errors: string[],
): value is IReleaseReport {
  if (!isRecord(value)) {
    errors.push(`${where} must be an object.`);
    return false;
  }
  checkKeys(value, REPORT_KEYS, where, errors);
  const contract = releaseReportContract(reportType);
  if (value.reportSchemaVersion !== 1) errors.push(`${where}.reportSchemaVersion must be 1.`);
  if (value.reportType !== reportType) errors.push(`${where}.reportType must be '${reportType}'.`);
  const reportCandidateSha = shaValue(value.candidateSha, `${where}.candidateSha`, errors);
  if (
    reportCandidateSha !== undefined &&
    candidateSha !== undefined &&
    reportCandidateSha.toLowerCase() !== candidateSha.toLowerCase()
  )
    errors.push(`${where}.candidateSha must equal candidateSha.`);
  sha256Value(value.reportSha256, `${where}.reportSha256`, errors);
  if (value.verdict !== "PASS") errors.push(`${where}.verdict must be 'PASS'.`);
  positiveId(value.sourceRunId, `${where}.sourceRunId`, errors);
  const sourceWorkflowPath = stringValue(
    value.sourceWorkflowPath,
    `${where}.sourceWorkflowPath`,
    errors,
  );
  if (sourceWorkflowPath !== contract.workflowPath)
    errors.push(`${where}.sourceWorkflowPath must equal '${contract.workflowPath}'.`);
  const artifactName = safeArtifactName(value.artifactName, `${where}.artifactName`, errors);
  if (artifactName !== undefined && artifactName !== contract.artifactName)
    errors.push(`${where}.artifactName must equal '${contract.artifactName}'.`);
  const artifactPath = safeArtifactPath(value.artifactPath, `${where}.artifactPath`, errors);
  if (artifactPath !== undefined && artifactPath !== contract.artifactPath)
    errors.push(`${where}.artifactPath must equal '${contract.artifactPath}'.`);
  const subjects = uniqueStrings(value.subjects, `${where}.subjects`, errors);
  if (JSON.stringify([...subjects].sort()) !== JSON.stringify([...contract.subjects].sort()))
    errors.push(`${where}.subjects must exactly equal the ${reportType} report subject set.`);
  return true;
}

function validateReportSource(
  value: unknown,
  where: string,
  evidenceRuns: ReadonlyMap<number, string>,
  errors: string[],
): void {
  if (!isRecord(value)) return;
  const sourceRunId = value.sourceRunId;
  const sourceWorkflowPath = value.sourceWorkflowPath;
  if (typeof sourceRunId !== "number" || typeof sourceWorkflowPath !== "string") return;
  const expectedWorkflowPath = evidenceRuns.get(sourceRunId);
  if (expectedWorkflowPath === undefined) {
    errors.push(`${where}.sourceRunId must refer to one of the required evidence runs.`);
  } else if (sourceWorkflowPath !== expectedWorkflowPath) {
    errors.push(`${where}.sourceWorkflowPath must match its source evidence run.`);
  }
}

function validateBooleanMap(
  value: unknown,
  where: string,
  expected: readonly string[],
  required: readonly string[],
  errors: string[],
  blockers: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${where} must be an object.`);
    return;
  }
  // Shape is checked against every key so a malformed availability object still fails closed;
  // only the keys this release's scope actually requires can raise a blocker.
  checkKeys(value, expected, where, errors);
  for (const key of expected) {
    if (typeof value[key] !== "boolean") errors.push(`${where}.${key} must be boolean.`);
    else if (value[key] === false && required.includes(key)) blockers.push(`${where}.${key}`);
  }
}

function parseReleaseScope(value: unknown, where: string, errors: string[]): IReleaseScope {
  if (value === undefined) return FULL_RELEASE_SCOPE;
  if (!isRecord(value)) {
    errors.push(`${where} must be an object.`);
    return FULL_RELEASE_SCOPE;
  }
  checkKeys(value, ["platforms", "signed"], where, errors);
  if (typeof value.signed !== "boolean") errors.push(`${where}.signed must be boolean.`);
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) {
    errors.push(`${where}.platforms must be a non-empty array.`);
    return FULL_RELEASE_SCOPE;
  }
  const platforms: ReleasePlatform[] = [];
  for (const entry of value.platforms) {
    if (typeof entry !== "string" || !RELEASE_PLATFORMS.includes(entry as ReleasePlatform)) {
      errors.push(`${where}.platforms must name only ${RELEASE_PLATFORMS.join(", ")}.`);
      continue;
    }
    if (platforms.includes(entry as ReleasePlatform))
      errors.push(`${where}.platforms must not repeat '${entry}'.`);
    else platforms.push(entry as ReleasePlatform);
  }
  // Fail closed on the narrowing itself: a platform whose binary this release publishes cannot
  // have its runner requirement dropped by leaving it out of the declared scope.
  const missing = platformsCoveringPublishedAssets().filter(
    (platform) => !platforms.includes(platform),
  );
  if (missing.length > 0)
    errors.push(
      `${where}.platforms must cover every published asset platform; missing ${missing.join(", ")}.`,
    );
  return { platforms, signed: value.signed === true };
}

function registryStateValue(
  value: unknown,
  where: string,
  errors: string[],
): RegistryState | undefined {
  if (value === "absent" || value === "matching") return value;
  errors.push(`${where} must be 'absent' or 'matching'.`);
  return undefined;
}

function validatePackageMetadata(
  value: RecordValue,
  where: string,
  registryState: RegistryState | undefined,
  errors: string[],
): void {
  if (
    value.integrity !== undefined &&
    (typeof value.integrity !== "string" || !/^sha(512|256)-\S+$/u.test(value.integrity))
  )
    errors.push(`${where}.integrity must be an npm integrity value.`);
  if (value.packedSha256 !== undefined)
    sha256Value(value.packedSha256, `${where}.packedSha256`, errors);
  if (value.normalizedSha256 !== undefined)
    sha256Value(value.normalizedSha256, `${where}.normalizedSha256`, errors);
  if (registryState === "absent" && value.integrity !== undefined)
    errors.push(`${where}.integrity must be omitted when the registry version is absent.`);
  if (registryState === "absent" && value.packedSha256 !== undefined)
    errors.push(`${where}.packedSha256 must be omitted when the registry version is absent.`);
  if (registryState === "absent" && value.normalizedSha256 !== undefined)
    errors.push(`${where}.normalizedSha256 must be omitted when the registry version is absent.`);
  if (registryState !== "matching") return;
  if (value.integrity === undefined)
    errors.push(`${where}.integrity is required for matching registry bytes.`);
  if (value.packedSha256 === undefined)
    errors.push(`${where}.packedSha256 is required for matching registry bytes.`);
  if (value.normalizedSha256 === undefined)
    errors.push(`${where}.normalizedSha256 is required for matching registry bytes.`);
}

function validatePackageEntry(
  value: unknown,
  index: number,
  names: Set<string>,
  errors: string[],
): IReleasePackage | undefined {
  const where = `packageCohort[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${where} must be an object.`);
    return undefined;
  }
  checkKeys(value, PACKAGE_KEYS, where, errors, ["name", "version", "registryState"]);
  const name = stringValue(value.name, `${where}.name`, errors);
  if (name !== undefined && !PACKAGE_NAME_PATTERN.test(name))
    errors.push(`${where}.name must not contain whitespace.`);
  if (name !== undefined && names.has(name)) errors.push(`${where}.name is duplicated.`);
  if (name !== undefined) names.add(name);
  const version = stringValue(value.version, `${where}.version`, errors);
  if (version !== undefined && !VERSION_PATTERN.test(version))
    errors.push(`${where}.version must be a publishable semantic version.`);
  const registryState = registryStateValue(value.registryState, `${where}.registryState`, errors);
  validatePackageMetadata(value, where, registryState, errors);
  if (name === undefined || version === undefined || registryState === undefined) return undefined;
  return {
    name,
    version,
    registryState,
    ...(typeof value.integrity === "string" ? { integrity: value.integrity } : {}),
    ...(typeof value.packedSha256 === "string" ? { packedSha256: value.packedSha256 } : {}),
    ...(typeof value.normalizedSha256 === "string"
      ? { normalizedSha256: value.normalizedSha256 }
      : {}),
  };
}

export function expectedReleasePackages(repo = REPO): readonly IReleasePackage[] {
  return publicWorkspacePackages(repo).map(({ name, version }) => ({
    name,
    version,
    registryState: "absent",
  }));
}

export function expectedGithubSubjects(): readonly string[] {
  return ["prebuilt-lock.json", ...Object.values(PREBUILT_ASSET_NAMES)].sort();
}

interface IReleaseReportContract {
  readonly artifactName: string;
  readonly artifactPath: string;
  readonly reportType: ReleaseReportType;
  readonly subjects: readonly string[];
  readonly workflowPath: string;
}

const RELEASE_REPORT_CONTRACTS: Readonly<Record<ReleaseReportType, IReleaseReportContract>> = {
  parity: {
    artifactName: "native-release-parity",
    artifactPath: "reports/parity.json",
    reportType: "parity",
    subjects: PARITY_REPORT_SUBJECTS,
    workflowPath: ".github/workflows/native-platforms.yml",
  },
  provenance: {
    artifactName: "native-release-provenance",
    artifactPath: "reports/provenance.json",
    reportType: "provenance",
    subjects: expectedGithubSubjects(),
    workflowPath: ".github/workflows/native-platforms.yml",
  },
};

function releaseReportContract(reportType: ReleaseReportType): IReleaseReportContract {
  return RELEASE_REPORT_CONTRACTS[reportType];
}

export function expectedReleaseReportSubjects(reportType: ReleaseReportType): readonly string[] {
  return [...releaseReportContract(reportType).subjects];
}

export function expectedReleaseReportReference(
  reportType: ReleaseReportType,
  runId: number,
): IReleaseReportReference {
  const contract = releaseReportContract(reportType);
  return {
    runId,
    workflowPath: contract.workflowPath,
    artifactName: contract.artifactName,
    artifactPath: contract.artifactPath,
  };
}

function validatePackageCohort(
  value: unknown,
  expectedPackages: readonly IReleasePackage[],
  errors: string[],
): readonly IReleasePackage[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("packageCohort must contain at least one package.");
    return [];
  }
  const packages: IReleasePackage[] = [];
  const names = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const packageEntry = validatePackageEntry(entry, index, names, errors);
    if (packageEntry !== undefined) packages.push(packageEntry);
  }
  const actual = new Map(packages.map((item) => [item.name, item]));
  const expected = new Map(expectedPackages.map((item) => [item.name, item]));
  if (JSON.stringify([...actual.keys()].sort()) !== JSON.stringify([...expected.keys()].sort()))
    errors.push("packageCohort must exactly equal the public workspace package set.");
  for (const [name, expectedPackage] of expected) {
    const actualPackage = actual.get(name);
    if (actualPackage !== undefined && actualPackage.version !== expectedPackage.version)
      errors.push(`packageCohort.${name} must use workspace version ${expectedPackage.version}.`);
  }
  return packages;
}

function uniqueStrings(value: unknown, where: string, errors: string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${where} must contain at least one subject.`);
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const subject = stringValue(entry, `${where}[${index}]`, errors);
    if (subject !== undefined) {
      if (seen.has(subject)) errors.push(`${where} contains duplicate '${subject}'.`);
      seen.add(subject);
      result.push(subject);
    }
  }
  return result;
}

interface ICandidateIdentity {
  readonly candidateSha: string | undefined;
  readonly runtimeVersion: string | undefined;
}

function validateCandidateIdentity(
  input: RecordValue,
  expectedRepository: string | undefined,
  errors: string[],
): ICandidateIdentity {
  checkKeys(input, CANDIDATE_KEYS, "release candidate", errors, CANDIDATE_REQUIRED_KEYS);
  if (input.schemaVersion !== 1) errors.push("release candidate.schemaVersion must be 1.");
  const repository = stringValue(input.repository, "repository", errors);
  if (repository !== undefined && !REPOSITORY_PATTERN.test(repository))
    errors.push("repository must be an OWNER/REPOSITORY value.");
  if (
    expectedRepository !== undefined &&
    repository !== undefined &&
    repository !== expectedRepository
  )
    errors.push(`repository must equal '${expectedRepository}'.`);
  const candidateSha = shaValue(input.candidateSha, "candidateSha", errors);
  const runtimeVersion = stringValue(input.runtimeVersion, "runtimeVersion", errors);
  if (runtimeVersion !== undefined && !VERSION_PATTERN.test(runtimeVersion))
    errors.push("runtimeVersion must be a publishable semantic version.");
  if (
    typeof input.tag !== "string" ||
    runtimeVersion === undefined ||
    input.tag !== `runtime-native-v${runtimeVersion}`
  )
    errors.push("tag must equal runtime-native-v<runtimeVersion>.");
  return { candidateSha, runtimeVersion };
}

function validateRequiredEvidence(
  input: RecordValue,
  candidateSha: string | undefined,
  errors: string[],
  blockers: string[],
): void {
  const evidenceRuns = new Map<number, string>();
  if (isRecord(input.requiredRuns)) {
    checkKeys(input.requiredRuns, ["ci", "native"], "requiredRuns", errors);
    const ci = input.requiredRuns.ci;
    const native = input.requiredRuns.native;
    validateRun(ci, "requiredRuns.ci", candidateSha, REQUIRED_RUN_WORKFLOWS.ci, errors);
    validateRun(native, "requiredRuns.native", candidateSha, REQUIRED_RUN_WORKFLOWS.native, errors);
    if (isRecord(ci) && typeof ci.databaseId === "number" && typeof ci.workflowPath === "string")
      evidenceRuns.set(ci.databaseId, ci.workflowPath);
    if (
      isRecord(native) &&
      typeof native.databaseId === "number" &&
      typeof native.workflowPath === "string"
    )
      evidenceRuns.set(native.databaseId, native.workflowPath);
  } else errors.push("requiredRuns must contain ci and native objects.");
  validateReport(input.parity, "parity", candidateSha, "parity", errors);
  validateReport(input.provenance, "provenance", candidateSha, "provenance", errors);
  validateReportSource(input.parity, "parity", evidenceRuns, errors);
  validateReportSource(input.provenance, "provenance", evidenceRuns, errors);
  const scope = parseReleaseScope(input.releaseScope, "releaseScope", errors);
  validateBooleanMap(
    input.credentials,
    "credentials",
    REQUIRED_CREDENTIALS,
    requiredCredentials(scope),
    errors,
    blockers,
  );
  validateBooleanMap(
    input.hostedCapabilities,
    "hostedCapabilities",
    REQUIRED_HOSTED_CAPABILITIES,
    requiredHostedCapabilities(scope),
    errors,
    blockers,
  );
}

function validateResolution(
  value: unknown,
  expectedProducerRunId: number | undefined,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push("resolution must be an object produced by the release-candidate workflow.");
    return;
  }
  checkKeys(value, RESOLUTION_KEYS, "resolution", errors);
  positiveId(value.producerRunId, "resolution.producerRunId", errors);
  if (expectedProducerRunId !== undefined && value.producerRunId !== expectedProducerRunId)
    errors.push("resolution.producerRunId must equal the successful producer run.");
  const expected: Record<string, string | boolean> = {
    source: "release-candidate-workflow",
    packageSource: "workspace-manifests",
    githubSubjectSource: "runtime-native-prebuilt-keys",
    evidenceSource: "github-api-and-artifacts",
    registrySource: "npm-version-metadata-and-tarballs",
    availabilitySource: "workflow-inputs",
    registryVerified: true,
    evidenceVerified: true,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue)
      errors.push(`resolution.${key} must equal ${JSON.stringify(expectedValue)}.`);
  }
}

function validateSubjectSet(
  value: unknown,
  packages: readonly IReleasePackage[],
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push("subjects must contain github and npm arrays.");
    return;
  }
  checkKeys(value, ["github", "npm"], "subjects", errors);
  const githubSubjects = uniqueStrings(value.github, "subjects.github", errors);
  const npmSubjects = uniqueStrings(value.npm, "subjects.npm", errors);
  const expectedNpmSubjects = packages.map((item) => `${item.name}@${item.version}`).sort();
  if (JSON.stringify([...npmSubjects].sort()) !== JSON.stringify(expectedNpmSubjects))
    errors.push("subjects.npm must exactly equal the package cohort versions.");
  if (JSON.stringify([...githubSubjects].sort()) !== JSON.stringify(expectedGithubSubjects()))
    errors.push("subjects.github must exactly equal the prebuilt release asset set.");
}

export function validateReleaseCandidate(
  input: unknown,
  expectedRepository?: string,
  expectedInvokingSha?: string,
  expectedProducerRunId?: number,
  repo = REPO,
): IReleaseCandidateValidation {
  const errors: string[] = [];
  const blockers: string[] = [];
  if (!isRecord(input)) {
    return {
      status: "FAIL",
      exitCode: 1,
      errors: ["release candidate must be a JSON object."],
      blockers: [],
    };
  }
  const { candidateSha } = validateCandidateIdentity(input, expectedRepository, errors);
  const invokingSha =
    expectedInvokingSha === undefined
      ? undefined
      : shaValue(expectedInvokingSha, "invoking commit SHA", errors);
  if (
    candidateSha !== undefined &&
    invokingSha !== undefined &&
    candidateSha.toLowerCase() !== invokingSha.toLowerCase()
  )
    errors.push("candidateSha must equal invoking commit SHA.");
  const expectedPackages = expectedReleasePackages(repo);
  const runtimePackage = expectedPackages.find(
    (item) => item.name === "@threenative/runtime-native",
  );
  if (
    runtimePackage !== undefined &&
    typeof input.runtimeVersion === "string" &&
    input.runtimeVersion !== runtimePackage.version
  )
    errors.push(
      `runtimeVersion must equal the workspace @threenative/runtime-native version ${runtimePackage.version}.`,
    );
  const packages = validatePackageCohort(input.packageCohort, expectedPackages, errors);
  validateRequiredEvidence(input, candidateSha, errors, blockers);
  validateSubjectSet(input.subjects, packages, errors);
  validateResolution(input.resolution, expectedProducerRunId, errors);

  if (errors.length > 0) return { status: "FAIL", exitCode: 1, errors, blockers: [] };
  if (blockers.length > 0) return { status: "BLOCKED", exitCode: 2, errors: [], blockers };
  return { status: "PASS", exitCode: 0, errors: [], blockers: [] };
}

class ReleaseCandidateResolutionError extends Error {
  readonly status: "FAIL" | "BLOCKED";
  readonly details: readonly string[];

  constructor(status: "FAIL" | "BLOCKED", details: readonly string[]) {
    super(details.join(" "));
    this.name = "ReleaseCandidateResolutionError";
    this.status = status;
    this.details = details;
  }
}

function resolutionFailure(...details: string[]): never {
  throw new ReleaseCandidateResolutionError("FAIL", details);
}

function resolutionBlocked(...details: string[]): never {
  throw new ReleaseCandidateResolutionError("BLOCKED", details);
}

function approvedWorkflowPath(value: string, where: string, errors: string[]): void {
  if (
    !Object.values(REQUIRED_RUN_WORKFLOWS).includes(
      value as (typeof REQUIRED_RUN_WORKFLOWS)[keyof typeof REQUIRED_RUN_WORKFLOWS],
    )
  )
    errors.push(`${where} must name an approved evidence workflow.`);
}

function parseReportReference(
  value: unknown,
  where: string,
  reportType: ReleaseReportType,
  errors: string[],
): IReleaseReportReference | undefined {
  if (!isRecord(value)) {
    errors.push(`${where} must be an object.`);
    return undefined;
  }
  checkKeys(value, REPORT_REFERENCE_KEYS, where, errors);
  const runId = positiveId(value.runId, `${where}.runId`, errors);
  const workflowPath = stringValue(value.workflowPath, `${where}.workflowPath`, errors);
  if (workflowPath !== undefined)
    approvedWorkflowPath(workflowPath, `${where}.workflowPath`, errors);
  const artifactName = safeArtifactName(value.artifactName, `${where}.artifactName`, errors);
  const artifactPath = safeArtifactPath(value.artifactPath, `${where}.artifactPath`, errors);
  const contract = releaseReportContract(reportType);
  if (workflowPath !== undefined && workflowPath !== contract.workflowPath)
    errors.push(`${where}.workflowPath must equal '${contract.workflowPath}'.`);
  if (artifactName !== undefined && artifactName !== contract.artifactName)
    errors.push(`${where}.artifactName must equal '${contract.artifactName}'.`);
  if (artifactPath !== undefined && artifactPath !== contract.artifactPath)
    errors.push(`${where}.artifactPath must equal '${contract.artifactPath}'.`);
  if (runId === undefined || workflowPath === undefined || artifactName === undefined)
    return undefined;
  if (artifactPath === undefined) return undefined;
  return { runId, workflowPath, artifactName, artifactPath };
}

interface IParsedRequestIdentity {
  readonly candidateSha: string | undefined;
  readonly repository: string | undefined;
  readonly runtimeVersion: string | undefined;
  readonly tag: string | undefined;
}

function parseRequestIdentity(
  value: RecordValue,
  expectedRepository: string | undefined,
  repo: string,
  errors: string[],
): IParsedRequestIdentity {
  if (value.schemaVersion !== 1) errors.push("release candidate request.schemaVersion must be 1.");
  const repository = stringValue(value.repository, "request.repository", errors);
  if (repository !== undefined && !REPOSITORY_PATTERN.test(repository))
    errors.push("request.repository must be an OWNER/REPOSITORY value.");
  if (
    expectedRepository !== undefined &&
    repository !== undefined &&
    repository !== expectedRepository
  )
    errors.push(`request.repository must equal '${expectedRepository}'.`);
  const tag = stringValue(value.tag, "request.tag", errors);
  const candidateSha = shaValue(value.candidateSha, "request.candidateSha", errors);
  const runtimeVersion = stringValue(value.runtimeVersion, "request.runtimeVersion", errors);
  if (runtimeVersion !== undefined && !VERSION_PATTERN.test(runtimeVersion))
    errors.push("request.runtimeVersion must be a publishable semantic version.");
  if (
    tag !== undefined &&
    runtimeVersion !== undefined &&
    tag !== `runtime-native-v${runtimeVersion}`
  )
    errors.push("request.tag must equal runtime-native-v<runtimeVersion>.");
  const runtimePackage = expectedReleasePackages(repo).find(
    (item) => item.name === "@threenative/runtime-native",
  );
  if (runtimePackage === undefined) {
    errors.push("workspace is missing the public @threenative/runtime-native package.");
  } else if (runtimeVersion !== undefined && runtimeVersion !== runtimePackage.version) {
    errors.push(
      `request.runtimeVersion must equal the workspace @threenative/runtime-native version ${runtimePackage.version}.`,
    );
  }
  return { candidateSha, repository, runtimeVersion, tag };
}

function parseRequestRunIds(
  value: unknown,
  errors: string[],
): { readonly ci: number | undefined; readonly native: number | undefined } {
  if (!isRecord(value)) {
    errors.push("request.requiredRunIds must contain ci and native IDs.");
    return { ci: undefined, native: undefined };
  }
  checkKeys(value, ["ci", "native"], "request.requiredRunIds", errors);
  return {
    ci: positiveId(value.ci, "request.requiredRunIds.ci", errors),
    native: positiveId(value.native, "request.requiredRunIds.native", errors),
  };
}

function parseRequestArtifacts(
  value: unknown,
  errors: string[],
): {
  readonly parity: IReleaseReportReference | undefined;
  readonly provenance: IReleaseReportReference | undefined;
} {
  if (!isRecord(value)) {
    errors.push("request.reportArtifacts must contain parity and provenance references.");
    return { parity: undefined, provenance: undefined };
  }
  checkKeys(value, ["parity", "provenance"], "request.reportArtifacts", errors);
  return {
    parity: parseReportReference(value.parity, "request.reportArtifacts.parity", "parity", errors),
    provenance: parseReportReference(
      value.provenance,
      "request.reportArtifacts.provenance",
      "provenance",
      errors,
    ),
  };
}

export function parseReleaseCandidateRequest(
  value: unknown,
  expectedRepository: string | undefined,
  repo: string,
): IReleaseCandidateRequest {
  const errors: string[] = [];
  if (!isRecord(value)) resolutionFailure("release candidate request must be a JSON object.");
  checkKeys(value, REQUEST_KEYS, "release candidate request", errors, REQUEST_REQUIRED_KEYS);
  const identity = parseRequestIdentity(value, expectedRepository, repo, errors);
  const requiredRunIds = parseRequestRunIds(value.requiredRunIds, errors);
  const reportArtifacts = parseRequestArtifacts(value.reportArtifacts, errors);
  const releaseScope = parseReleaseScope(value.releaseScope, "request.releaseScope", errors);
  if (errors.length > 0) throw new ReleaseCandidateResolutionError("FAIL", errors);
  return {
    schemaVersion: 1,
    repository: identity.repository as string,
    tag: identity.tag as string,
    candidateSha: identity.candidateSha as string,
    runtimeVersion: identity.runtimeVersion as string,
    requiredRunIds: { ci: requiredRunIds.ci as number, native: requiredRunIds.native as number },
    reportArtifacts: {
      parity: reportArtifacts.parity as IReleaseReportReference,
      provenance: reportArtifacts.provenance as IReleaseReportReference,
    },
    releaseScope,
  };
}

function parseReleaseAvailability(value: unknown): IReleaseAvailability {
  const errors: string[] = [];
  // Parsing checks shape only. Which absent capability blocks a release depends on the candidate's
  // declared scope, which validateRequiredEvidence applies; nothing is required here, so these
  // collected blockers are intentionally discarded.
  const blockers: string[] = [];
  if (!isRecord(value)) resolutionFailure("release availability must be a JSON object.");
  checkKeys(value, ["credentials", "hostedCapabilities"], "release availability", errors);
  validateBooleanMap(
    value.credentials,
    "availability.credentials",
    REQUIRED_CREDENTIALS,
    [],
    errors,
    blockers,
  );
  validateBooleanMap(
    value.hostedCapabilities,
    "availability.hostedCapabilities",
    REQUIRED_HOSTED_CAPABILITIES,
    [],
    errors,
    blockers,
  );
  if (errors.length > 0) throw new ReleaseCandidateResolutionError("FAIL", errors);
  return {
    credentials: value.credentials as IReleaseAvailability["credentials"],
    hostedCapabilities: value.hostedCapabilities as IReleaseAvailability["hostedCapabilities"],
  };
}

function githubJson(repo: string, repository: string, endpoint: string): unknown {
  try {
    const output = execFileSync("gh", ["api", `repos/${repository}/${endpoint}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(String(output));
  } catch {
    resolutionBlocked(`GitHub API evidence '${endpoint}' could not be read for ${repository}.`);
  }
}

export function parseGithubRun(
  raw: unknown,
  runId: number,
  candidateSha: string,
  workflowPath: string,
): IReleaseRun {
  if (!isRecord(raw)) resolutionFailure(`GitHub run ${runId} returned a non-object response.`);
  const run: unknown = {
    databaseId: raw.id,
    status: raw.status,
    conclusion: raw.conclusion,
    event: raw.event,
    headBranch: raw.head_branch,
    headSha: raw.head_sha,
    workflowPath: raw.path,
  };
  const errors: string[] = [];
  if (raw.id !== runId) errors.push(`GitHub run response ${runId} has a mismatched database ID.`);
  validateRun(run, `required evidence run ${runId}`, candidateSha, workflowPath, errors);
  if (errors.length > 0) throw new ReleaseCandidateResolutionError("FAIL", errors);
  return run as IReleaseRun;
}

function resolveRunFromGithub(
  repo: string,
  repository: string,
  runId: number,
  candidateSha: string,
  workflowPath: string,
): IReleaseRun {
  return parseGithubRun(
    githubJson(repo, repository, `actions/runs/${runId}`),
    runId,
    candidateSha,
    workflowPath,
  );
}

function artifactFilePath(directory: string, artifactPath: string): string {
  const errors: string[] = [];
  const safePath = safeArtifactPath(artifactPath, "artifactPath", errors);
  if (safePath === undefined || errors.length > 0)
    resolutionFailure(...(errors.length > 0 ? errors : ["artifactPath is unsafe."]));
  const normalized = safePath.replaceAll("\\", "/");
  const file = resolve(directory, ...normalized.split("/"));
  const withinDirectory = relative(directory, file);
  if (
    isAbsolute(withinDirectory) ||
    withinDirectory === ".." ||
    withinDirectory.startsWith(`..${"/"}`)
  )
    resolutionFailure(`artifactPath '${artifactPath}' escapes the downloaded artifact directory.`);
  if (!existsSync(file) || !statSync(file).isFile())
    resolutionFailure(`downloaded artifact is missing the exact report path '${artifactPath}'.`);
  return file;
}

interface IParsedEvidenceReport {
  readonly candidateSha: string;
  readonly subjects: readonly string[];
}

function parseEvidenceJson(contents: Buffer, artifactPath: string): RecordValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    resolutionFailure(`evidence artifact '${artifactPath}' is not valid JSON.`);
  }
  if (!isRecord(parsed))
    resolutionFailure(`evidence artifact '${artifactPath}' must contain an object.`);
  return parsed;
}

function validateEvidenceIdentity(
  parsed: RecordValue,
  candidateSha: string,
  artifactPath: string,
  reportType: ReleaseReportType,
  errors: string[],
): readonly string[] {
  const contract = releaseReportContract(reportType);
  const expectedKeys =
    reportType === "parity"
      ? [
          "schemaVersion",
          "reportType",
          "candidateSha",
          "verdict",
          "subjects",
          "registrySha256",
          "targetReports",
        ]
      : [
          "schemaVersion",
          "reportType",
          "candidateSha",
          "verdict",
          "subjects",
          "subjectHashes",
          ...PROVENANCE_REPORT_SHA_FIELDS,
        ];
  checkKeys(parsed, expectedKeys, `${reportType} evidence report`, errors);
  if (parsed.schemaVersion !== 1) errors.push(`${artifactPath}.schemaVersion must equal 1.`);
  if (parsed.reportType !== reportType)
    errors.push(`${artifactPath}.reportType must equal '${reportType}'.`);
  const observedSha = shaValue(parsed.candidateSha, `${artifactPath}.candidateSha`, errors);
  if (observedSha !== undefined && observedSha.toLowerCase() !== candidateSha.toLowerCase())
    errors.push(`${artifactPath}.candidateSha must equal the requested candidate SHA.`);
  if (parsed.verdict !== "PASS") errors.push(`${artifactPath}.verdict must equal 'PASS'.`);
  const subjects = uniqueStrings(parsed.subjects, `${artifactPath}.subjects`, errors);
  if (JSON.stringify([...subjects].sort()) !== JSON.stringify([...contract.subjects].sort()))
    errors.push(
      `${artifactPath}.subjects must exactly equal the ${reportType} report subject set.`,
    );
  return subjects;
}

function validateParityEvidenceReport(
  parsed: RecordValue,
  artifactPath: string,
  errors: string[],
): void {
  sha256Value(parsed.registrySha256, `${artifactPath}.registrySha256`, errors);
  if (!isRecord(parsed.targetReports)) {
    errors.push(`${artifactPath}.targetReports must contain android, desktop, and web reports.`);
    return;
  }
  checkKeys(parsed.targetReports, PARITY_REPORT_SUBJECTS, `${artifactPath}.targetReports`, errors);
  for (const target of PARITY_REPORT_SUBJECTS) {
    const targetReport = parsed.targetReports[target];
    if (!isRecord(targetReport)) {
      errors.push(`${artifactPath}.targetReports.${target} must be an object.`);
      continue;
    }
    checkKeys(
      targetReport,
      ["verdict", "reportSha256"],
      `${artifactPath}.targetReports.${target}`,
      errors,
    );
    if (targetReport.verdict !== "PASS")
      errors.push(`${artifactPath}.targetReports.${target}.verdict must equal 'PASS'.`);
    sha256Value(
      targetReport.reportSha256,
      `${artifactPath}.targetReports.${target}.reportSha256`,
      errors,
    );
  }
}

function validateProvenanceEvidenceReport(
  parsed: RecordValue,
  artifactPath: string,
  errors: string[],
): void {
  const contract = releaseReportContract("provenance");
  if (!isRecord(parsed.subjectHashes)) {
    errors.push(`${artifactPath}.subjectHashes must contain every provenance subject.`);
  } else {
    checkKeys(parsed.subjectHashes, contract.subjects, `${artifactPath}.subjectHashes`, errors);
    for (const subject of contract.subjects)
      sha256Value(
        parsed.subjectHashes[subject],
        `${artifactPath}.subjectHashes.${subject}`,
        errors,
      );
  }
  for (const field of PROVENANCE_REPORT_SHA_FIELDS)
    sha256Value(parsed[field], `${artifactPath}.${field}`, errors);
}

export function parseEvidenceReport(
  contents: Buffer,
  candidateSha: string,
  artifactPath: string,
  reportType: ReleaseReportType,
): IParsedEvidenceReport {
  const parsed = parseEvidenceJson(contents, artifactPath);
  const errors: string[] = [];
  const subjects = validateEvidenceIdentity(parsed, candidateSha, artifactPath, reportType, errors);
  if (reportType === "parity") validateParityEvidenceReport(parsed, artifactPath, errors);
  else validateProvenanceEvidenceReport(parsed, artifactPath, errors);
  if (errors.length > 0) throw new ReleaseCandidateResolutionError("FAIL", errors);
  return { candidateSha, subjects };
}

function reportFromDownloadedArtifact(
  repo: string,
  repository: string,
  candidateSha: string,
  reference: IReleaseReportReference,
  reportType: ReleaseReportType,
): IReleaseReport {
  const sourceRun = resolveRunFromGithub(
    repo,
    repository,
    reference.runId,
    candidateSha,
    reference.workflowPath,
  );
  const directory = mkdtempSync(join(tmpdir(), "threenative-release-report-"));
  try {
    try {
      execFileSync(
        "gh",
        [
          "run",
          "download",
          String(reference.runId),
          "--repo",
          repository,
          "--name",
          reference.artifactName,
          "--dir",
          directory,
        ],
        { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      resolutionBlocked(
        `GitHub artifact '${reference.artifactName}' from run ${reference.runId} could not be downloaded.`,
      );
    }
    const file = artifactFilePath(directory, reference.artifactPath);
    const contents = readFileSync(file);
    const report = parseEvidenceReport(contents, candidateSha, reference.artifactPath, reportType);
    return {
      reportSchemaVersion: 1,
      reportType,
      candidateSha: report.candidateSha,
      verdict: "PASS",
      reportSha256: createHash("sha256").update(contents).digest("hex"),
      sourceRunId: sourceRun.databaseId,
      sourceWorkflowPath: sourceRun.workflowPath,
      artifactName: reference.artifactName,
      artifactPath: reference.artifactPath,
      subjects: report.subjects,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertResolvedRun(
  value: unknown,
  where: string,
  runId: number,
  candidateSha: string,
  workflowPath: string,
): IReleaseRun {
  const errors: string[] = [];
  validateRun(value, where, candidateSha, workflowPath, errors);
  if (isRecord(value) && value.databaseId !== runId)
    errors.push(`${where}.databaseId must equal request run ${runId}.`);
  if (errors.length > 0) throw new ReleaseCandidateResolutionError("FAIL", errors);
  return value as IReleaseRun;
}

function assertResolvedReport(
  value: unknown,
  where: string,
  candidateSha: string,
  reference: IReleaseReportReference,
  reportType: ReleaseReportType,
): IReleaseReport {
  const errors: string[] = [];
  validateReport(value, where, candidateSha, reportType, errors);
  if (isRecord(value) && value.sourceRunId !== reference.runId)
    errors.push(`${where}.sourceRunId must equal report artifact run ${reference.runId}.`);
  if (isRecord(value) && value.sourceWorkflowPath !== reference.workflowPath)
    errors.push(`${where}.sourceWorkflowPath must equal the report artifact workflow.`);
  if (isRecord(value) && value.artifactName !== reference.artifactName)
    errors.push(`${where}.artifactName must equal the requested artifact.`);
  if (isRecord(value) && value.artifactPath !== reference.artifactPath)
    errors.push(`${where}.artifactPath must equal the requested report path.`);
  if (errors.length > 0) throw new ReleaseCandidateResolutionError("FAIL", errors);
  return value as IReleaseReport;
}

async function fetchRegistryResource(
  url: string | URL,
  description: string,
  missingIsAbsent: boolean,
): Promise<Response | undefined> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new ReleaseCandidateResolutionError("BLOCKED", [`${description} could not be reached.`]);
  }
  if (missingIsAbsent && response.status === 404) return undefined;
  if (!response.ok)
    throw new ReleaseCandidateResolutionError("BLOCKED", [
      `${description} returned HTTP ${response.status}.`,
    ]);
  return response;
}

async function registryJson(response: Response, description: string): Promise<RecordValue> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    resolutionFailure(`${description} is not valid JSON.`);
  }
  if (!isRecord(value)) resolutionFailure(`${description} must be an object.`);
  return value;
}

const TAR_BLOCK_SIZE = 512;

function tarField(header: Buffer, offset: number, length: number): string {
  return header
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/u, "");
}

function tarSize(header: Buffer, packageName: string, version: string): number {
  const encoded = tarField(header, 124, 12).trim();
  if (!/^\d+$/u.test(encoded))
    resolutionFailure(
      `npm registry tarball for ${packageName}@${version} has an invalid file size.`,
    );
  const size = Number.parseInt(encoded, 8);
  if (!Number.isSafeInteger(size) || size < 0)
    resolutionFailure(
      `npm registry tarball for ${packageName}@${version} has an unsafe file size.`,
    );
  return size;
}

interface ITarOverrides {
  readonly path?: string;
  readonly size?: number;
}

function tarPaxFailure(packageName: string, version: string): never {
  return resolutionFailure(
    `npm registry tarball for ${packageName}@${version} has malformed PAX data.`,
  );
}

function tarPaxRecord(
  contents: Buffer,
  offset: number,
  packageName: string,
  version: string,
): { readonly key: string; readonly value: string; readonly nextOffset: number } {
  const lineEnd = contents.indexOf(0x0a, offset);
  const separator = contents.indexOf(0x20, offset);
  if (lineEnd < 0 || separator < 0 || separator >= lineEnd) tarPaxFailure(packageName, version);
  const length = Number.parseInt(contents.subarray(offset, separator).toString("ascii"), 10);
  if (!Number.isSafeInteger(length) || length <= 0 || offset + length > contents.length)
    tarPaxFailure(packageName, version);
  const record = contents.subarray(offset, offset + length);
  if (record[record.length - 1] !== 0x0a) tarPaxFailure(packageName, version);
  const equals = record.indexOf(0x3d, separator - offset);
  if (equals < 0) tarPaxFailure(packageName, version);
  return {
    key: record.subarray(separator - offset + 1, equals).toString("utf8"),
    value: record.subarray(equals + 1, record.length - 1).toString("utf8"),
    nextOffset: offset + length,
  };
}

function tarOverrides(contents: Buffer, packageName: string, version: string): ITarOverrides {
  const result: { path?: string; size?: number } = {};
  for (let offset = 0; offset < contents.length; ) {
    const record = tarPaxRecord(contents, offset, packageName, version);
    if (record.key === "path") result.path = record.value;
    if (record.key === "size") {
      if (!/^\d+$/u.test(record.value))
        resolutionFailure(
          `npm registry tarball for ${packageName}@${version} has an invalid PAX size.`,
        );
      result.size = Number.parseInt(record.value, 10);
      if (!Number.isSafeInteger(result.size) || result.size < 0)
        resolutionFailure(
          `npm registry tarball for ${packageName}@${version} has an unsafe PAX size.`,
        );
    }
    offset = record.nextOffset;
  }
  return result;
}

function normalizedArchivePath(
  value: string,
  packageName: string,
  version: string,
): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (normalized === "package" || normalized === "package/") return undefined;
  if (!normalized.startsWith("package/"))
    resolutionFailure(
      `npm registry tarball for ${packageName}@${version} contains '${value}' outside package/.`,
    );
  const path = normalized.slice("package/".length);
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  )
    resolutionFailure(
      `npm registry tarball for ${packageName}@${version} contains an unsafe package path '${value}'.`,
    );
  return path;
}

interface ITarEntry {
  readonly data: Buffer;
  readonly nextOffset: number;
  readonly path: string;
  readonly type: string;
}

function tarEntry(
  archive: Buffer,
  offset: number,
  pending: ITarOverrides,
  packageName: string,
  version: string,
): ITarEntry {
  const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
  const name = tarField(header, 0, 100);
  const prefix = tarField(header, 345, 155);
  const headerPath = prefix.length === 0 ? name : `${prefix}/${name}`;
  const headerSize = tarSize(header, packageName, version);
  const type = header[156] === 0 ? "0" : String.fromCharCode(header[156] as number);
  const dataStart = offset + TAR_BLOCK_SIZE;
  const dataEnd = dataStart + (pending.size ?? headerSize);
  if (dataEnd > archive.length)
    resolutionFailure(`npm registry tarball for ${packageName}@${version} is truncated.`);
  return {
    data: archive.subarray(dataStart, dataEnd),
    nextOffset: dataStart + Math.ceil((dataEnd - dataStart) / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE,
    path:
      type === "L"
        ? archive.subarray(dataStart, dataEnd).toString("utf8").replace(/\0.*$/u, "")
        : (pending.path ?? headerPath),
    type,
  };
}

function consumeTarEntry(
  files: Map<string, Buffer>,
  entry: ITarEntry,
  pending: ITarOverrides,
  packageName: string,
  version: string,
): ITarOverrides {
  if (entry.type === "x") return tarOverrides(entry.data, packageName, version);
  if (entry.type === "g") return {};
  if (entry.type === "L") return { ...pending, path: entry.path };
  const path = normalizedArchivePath(entry.path, packageName, version);
  if (path === undefined || entry.type === "5") return {};
  if (entry.type !== "0")
    resolutionFailure(
      `npm registry tarball for ${packageName}@${version} contains unsupported entry '${entry.path}'.`,
    );
  if (files.has(path))
    resolutionFailure(`npm registry tarball for ${packageName}@${version} repeats '${path}'.`);
  files.set(path, Buffer.from(entry.data));
  return {};
}

function packageTreeArchive(
  archive: Buffer,
  packageName: string,
  version: string,
): ReadonlyMap<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let sawEnd = false;
  let pending: ITarOverrides = {};
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    if (archive.subarray(offset, offset + TAR_BLOCK_SIZE).every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    const entry = tarEntry(archive, offset, pending, packageName, version);
    offset = entry.nextOffset;
    pending = consumeTarEntry(files, entry, pending, packageName, version);
  }
  if (!sawEnd || offset > archive.length)
    resolutionFailure(
      `npm registry tarball for ${packageName}@${version} has no valid end marker.`,
    );
  return files;
}

function validatePackageTreeMetadata(
  files: ReadonlyMap<string, Buffer>,
  packageName: string,
  version: string,
): void {
  const packageJson = files.get("package.json");
  if (packageJson === undefined)
    resolutionFailure(`npm registry tarball for ${packageName}@${version} has no package.json.`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson.toString("utf8"));
  } catch {
    resolutionFailure(
      `npm registry tarball for ${packageName}@${version} has invalid package.json.`,
    );
  }
  if (!isRecord(manifest) || manifest.name !== packageName || manifest.version !== version)
    resolutionFailure(
      `npm registry tarball for ${packageName}@${version} has mismatched package metadata.`,
    );
}

function packageTreeFiles(
  contents: Buffer,
  packageName: string,
  version: string,
): ReadonlyMap<string, Buffer> {
  let archive: Buffer;
  try {
    archive = gunzipSync(contents);
  } catch {
    resolutionFailure(`npm registry tarball for ${packageName}@${version} is not valid gzip data.`);
  }
  const files = packageTreeArchive(archive, packageName, version);
  validatePackageTreeMetadata(files, packageName, version);
  return files;
}

/** Hashes the sorted package file tree, excluding tar headers and gzip metadata. */
export function normalizedPackageTreeHash(
  contents: Buffer,
  packageName: string,
  version: string,
): string {
  const files = packageTreeFiles(contents, packageName, version);
  const hash = createHash("sha256");
  for (const [path, file] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const pathBytes = Buffer.from(path, "utf8");
    hash.update(`${pathBytes.length}:`);
    hash.update(pathBytes);
    hash.update("\0");
    hash.update(`${file.length}:`);
    hash.update(file);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function registryDistribution(
  metadata: RecordValue,
  packageName: string,
  version: string,
): { readonly integrity: string; readonly tarball: URL } | undefined {
  const versions = metadata.versions;
  if (!isRecord(versions))
    resolutionFailure(`npm registry metadata for ${packageName}@${version} has no versions map.`);
  if (!Object.hasOwn(versions, version)) return undefined;
  const published = versions[version];
  if (!isRecord(published) || !isRecord(published.dist))
    resolutionFailure(`npm registry metadata for ${packageName}@${version} has no dist record.`);
  if (published.name !== packageName || published.version !== version)
    resolutionFailure(`npm registry metadata identity mismatches ${packageName}@${version}.`);
  const integrity = published.dist.integrity;
  const tarball = published.dist.tarball;
  if (typeof integrity !== "string" || !NPM_INTEGRITY_PATTERN.test(integrity))
    resolutionFailure(
      `npm registry metadata for ${packageName}@${version} has no valid integrity.`,
    );
  if (typeof tarball !== "string")
    resolutionFailure(`npm registry metadata for ${packageName}@${version} has no tarball URL.`);
  let tarballUrl: URL;
  try {
    tarballUrl = new URL(tarball);
  } catch {
    resolutionFailure(
      `npm registry metadata for ${packageName}@${version} has an invalid tarball URL.`,
    );
  }
  if (tarballUrl.protocol !== "https:" || tarballUrl.hostname !== "registry.npmjs.org")
    resolutionFailure(
      `npm registry tarball for ${packageName}@${version} is not an official HTTPS registry URL.`,
    );
  return { integrity, tarball: tarballUrl };
}

function verifiedRegistryBytes(
  contents: Buffer,
  integrity: string,
  packageName: string,
  version: string,
): IRegistryObservation {
  const integrityMatch = integrity.match(NPM_INTEGRITY_PATTERN);
  if (integrityMatch === null)
    resolutionFailure(`npm integrity for ${packageName}@${version} is invalid.`);
  const algorithm = integrityMatch[1] as "sha512" | "sha256";
  const actualIntegrity = `${algorithm}-${createHash(algorithm).update(contents).digest("base64")}`;
  if (actualIntegrity !== integrity)
    resolutionFailure(
      `npm registry tarball integrity mismatches metadata for ${packageName}@${version}.`,
    );
  return {
    state: "matching",
    integrity,
    packedSha256: createHash("sha256").update(contents).digest("hex"),
    normalizedSha256: normalizedPackageTreeHash(contents, packageName, version),
  };
}

export async function registryPackageObservation(
  packageName: string,
  version: string,
): Promise<IRegistryObservation> {
  const description = `npm registry metadata for ${packageName}@${version}`;
  const metadataResponse = await fetchRegistryResource(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
    description,
    true,
  );
  if (metadataResponse === undefined) return { state: "absent" };
  const distribution = registryDistribution(
    await registryJson(metadataResponse, description),
    packageName,
    version,
  );
  if (distribution === undefined) return { state: "absent" };
  const tarballDescription = `npm registry tarball for ${packageName}@${version}`;
  const tarballResponse = await fetchRegistryResource(
    distribution.tarball,
    tarballDescription,
    false,
  );
  if (tarballResponse === undefined) resolutionFailure(`${tarballDescription} was not returned.`);
  return verifiedRegistryBytes(
    Buffer.from(await tarballResponse.arrayBuffer()),
    distribution.integrity,
    packageName,
    version,
  );
}

function workspacePackageTreeHash(repo: string, packageName: string, version: string): string {
  const packageDirectory = publicWorkspacePackages(repo).find(
    (item) => item.name === packageName,
  )?.directory;
  if (packageDirectory === undefined)
    resolutionFailure(`workspace package ${packageName}@${version} is not present.`);
  const destination = mkdtempSync(join(tmpdir(), "threenative-workspace-package-"));
  try {
    try {
      execFileSync("pnpm", ["--filter", packageName, "pack", "--pack-destination", destination], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolutionBlocked(`workspace package ${packageName}@${version} could not be packed.`);
    }
    const archives = readdirSync(destination).filter((entry) => entry.endsWith(".tgz"));
    if (archives.length !== 1)
      resolutionFailure(
        `workspace package ${packageName}@${version} produced ${archives.length} package archives.`,
      );
    const archive = archives[0];
    if (archive === undefined)
      resolutionFailure(`workspace package ${packageName}@${version} was not packed.`);
    return normalizedPackageTreeHash(
      readFileSync(join(destination, archive)),
      packageName,
      version,
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

function packageFromMatchingObservation(
  packageName: string,
  version: string,
  observation: RecordValue,
  errors: string[],
): IReleasePackage {
  const integrity = observation.integrity;
  const packedSha256 = observation.packedSha256;
  const normalizedSha256 = observation.normalizedSha256;
  if (typeof integrity !== "string" || !NPM_INTEGRITY_PATTERN.test(integrity))
    errors.push(`registry observation for ${packageName}@${version} has invalid integrity.`);
  if (typeof packedSha256 !== "string" || !SHA256_PATTERN.test(packedSha256))
    errors.push(`registry observation for ${packageName}@${version} has invalid tarball SHA-256.`);
  if (typeof normalizedSha256 !== "string" || !SHA256_PATTERN.test(normalizedSha256))
    errors.push(
      `registry observation for ${packageName}@${version} has invalid normalized package SHA-256.`,
    );
  if (errors.length === 0)
    return {
      name: packageName,
      version,
      registryState: "matching",
      integrity: integrity as string,
      packedSha256: packedSha256 as string,
      normalizedSha256: normalizedSha256 as string,
    };
  if (errors.length > 0) throw new ReleaseCandidateResolutionError("FAIL", errors);
  resolutionFailure(`registry observation for ${packageName}@${version} has no usable state.`);
}

function packageFromRegistryObservation(
  packageName: string,
  version: string,
  observation: unknown,
): IReleasePackage {
  if (!isRecord(observation))
    throw new ReleaseCandidateResolutionError("FAIL", [
      `registry observation for ${packageName}@${version} must be an object.`,
    ]);
  const errors: string[] = [];
  const state = registryStateValue(observation.state, `registry.${packageName}.state`, errors);
  if (state === "absent") {
    if (observation.integrity !== undefined)
      errors.push(
        `registry observation for ${packageName}@${version} has unexpected integrity bytes.`,
      );
    if (observation.packedSha256 !== undefined)
      errors.push(
        `registry observation for ${packageName}@${version} has unexpected tarball bytes.`,
      );
    if (observation.normalizedSha256 !== undefined)
      errors.push(
        `registry observation for ${packageName}@${version} has unexpected normalized package bytes.`,
      );
    if (errors.length === 0) return { name: packageName, version, registryState: "absent" };
  }
  if (state === "matching")
    return packageFromMatchingObservation(packageName, version, observation, errors);
  if (errors.length > 0) throw new ReleaseCandidateResolutionError("FAIL", errors);
  resolutionFailure(`registry observation for ${packageName}@${version} has no usable state.`);
}

function compareRegistryObservation(
  item: IReleasePackage,
  observation: IRegistryObservation,
): readonly string[] {
  const observed = packageFromRegistryObservation(item.name, item.version, observation);
  if (observed.registryState !== item.registryState)
    return [
      `registry state for ${item.name}@${item.version} changed from ${item.registryState} to ${observed.registryState}.`,
    ];
  if (observed.registryState === "matching" && observed.integrity !== item.integrity)
    return [`registry integrity for ${item.name}@${item.version} does not match the candidate.`];
  if (
    observed.registryState === "matching" &&
    observed.packedSha256?.toLowerCase() !== item.packedSha256?.toLowerCase()
  )
    return [
      `registry tarball SHA-256 for ${item.name}@${item.version} does not match the candidate.`,
    ];
  if (
    observed.registryState === "matching" &&
    observed.normalizedSha256?.toLowerCase() !== item.normalizedSha256?.toLowerCase()
  )
    return [
      `normalized package SHA-256 for ${item.name}@${item.version} does not match the candidate workspace tree.`,
    ];
  return [];
}

async function verifyRegistryPackage(
  item: IReleasePackage,
  lookup: (
    packageName: string,
    version: string,
  ) => IRegistryObservation | Promise<IRegistryObservation>,
): Promise<Pick<IReleaseCandidateValidation, "errors" | "blockers">> {
  let observation: IRegistryObservation;
  try {
    observation = await lookup(item.name, item.version);
  } catch (error: unknown) {
    if (error instanceof ReleaseCandidateResolutionError && error.status === "BLOCKED")
      return { errors: [], blockers: [...error.details] };
    if (error instanceof ReleaseCandidateResolutionError)
      return { errors: [...error.details], blockers: [] };
    return {
      errors: [],
      blockers: [`npm registry observation for ${item.name}@${item.version} failed.`],
    };
  }
  try {
    return { errors: [...compareRegistryObservation(item, observation)], blockers: [] };
  } catch (error: unknown) {
    return {
      errors:
        error instanceof ReleaseCandidateResolutionError
          ? [...error.details]
          : [`registry observation for ${item.name}@${item.version} is invalid.`],
      blockers: [],
    };
  }
}

export async function verifyRegistryCohort(
  candidate: Pick<IReleaseCandidate, "packageCohort">,
  lookup: (
    packageName: string,
    version: string,
  ) => IRegistryObservation | Promise<IRegistryObservation> = registryPackageObservation,
): Promise<Pick<IReleaseCandidateValidation, "errors" | "blockers">> {
  const errors: string[] = [];
  const blockers: string[] = [];
  for (const item of candidate.packageCohort) {
    const result = await verifyRegistryPackage(item, lookup);
    errors.push(...result.errors);
    blockers.push(...result.blockers);
  }
  return { errors, blockers };
}

async function observeReleasePackage(
  expectedPackage: IReleasePackage,
  registryLookup: (
    packageName: string,
    version: string,
  ) => IRegistryObservation | Promise<IRegistryObservation>,
  localPackageHash: (packageName: string, version: string) => string | Promise<string>,
): Promise<IReleasePackage> {
  let observation: IRegistryObservation;
  try {
    observation = await registryLookup(expectedPackage.name, expectedPackage.version);
  } catch (error: unknown) {
    if (error instanceof ReleaseCandidateResolutionError) throw error;
    resolutionBlocked(
      `registry observation for ${expectedPackage.name}@${expectedPackage.version} failed.`,
    );
  }
  const packageEntry = packageFromRegistryObservation(
    expectedPackage.name,
    expectedPackage.version,
    observation,
  );
  if (packageEntry.registryState !== "matching") return packageEntry;
  let workspaceHash: string;
  try {
    workspaceHash = await localPackageHash(expectedPackage.name, expectedPackage.version);
  } catch (error: unknown) {
    if (error instanceof ReleaseCandidateResolutionError) throw error;
    resolutionBlocked(
      `workspace package ${expectedPackage.name}@${expectedPackage.version} could not be hashed.`,
    );
  }
  if (!SHA256_PATTERN.test(workspaceHash))
    resolutionFailure(
      `workspace package ${expectedPackage.name}@${expectedPackage.version} returned an invalid normalized package SHA-256.`,
    );
  if (workspaceHash.toLowerCase() !== packageEntry.normalizedSha256?.toLowerCase())
    resolutionFailure(
      `normalized package SHA-256 for ${expectedPackage.name}@${expectedPackage.version} does not match the workspace tree.`,
    );
  return packageEntry;
}

async function resolvePackageCohort(
  repo: string,
  options: IReleaseCandidateResolutionOptions,
): Promise<readonly IReleasePackage[]> {
  const registryLookup = options.registryLookup ?? registryPackageObservation;
  const localPackageHash =
    options.workspacePackageHash ??
    ((packageName: string, version: string) =>
      workspacePackageTreeHash(repo, packageName, version));
  const packages: IReleasePackage[] = [];
  for (const expectedPackage of expectedReleasePackages(repo))
    packages.push(await observeReleasePackage(expectedPackage, registryLookup, localPackageHash));
  return packages;
}

function resolveRunResolver(
  repo: string,
  options: IReleaseCandidateResolutionOptions,
): (
  repository: string,
  runId: number,
  candidateSha: string,
  workflowPath: string,
) => IReleaseRun | Promise<IReleaseRun> {
  return (
    options.resolveRun ??
    ((repository: string, runId: number, candidateSha: string, workflowPath: string) =>
      resolveRunFromGithub(repo, repository, runId, candidateSha, workflowPath))
  );
}

async function resolveRequiredRuns(
  request: IReleaseCandidateRequest,
  runResolver: ReturnType<typeof resolveRunResolver>,
): Promise<{ readonly ci: IReleaseRun; readonly native: IReleaseRun }> {
  const ci = assertResolvedRun(
    await runResolver(
      request.repository,
      request.requiredRunIds.ci,
      request.candidateSha,
      REQUIRED_RUN_WORKFLOWS.ci,
    ),
    "requiredRuns.ci",
    request.requiredRunIds.ci,
    request.candidateSha,
    REQUIRED_RUN_WORKFLOWS.ci,
  );
  const native = assertResolvedRun(
    await runResolver(
      request.repository,
      request.requiredRunIds.native,
      request.candidateSha,
      REQUIRED_RUN_WORKFLOWS.native,
    ),
    "requiredRuns.native",
    request.requiredRunIds.native,
    request.candidateSha,
    REQUIRED_RUN_WORKFLOWS.native,
  );
  return { ci, native };
}

function resolveReportResolver(
  repo: string,
  options: IReleaseCandidateResolutionOptions,
): (
  repository: string,
  candidateSha: string,
  reference: IReleaseReportReference,
  reportType: ReleaseReportType,
) => IReleaseReport | Promise<IReleaseReport> {
  return (
    options.resolveReport ??
    ((
      repository: string,
      candidateSha: string,
      reference: IReleaseReportReference,
      reportType: ReleaseReportType,
    ) => reportFromDownloadedArtifact(repo, repository, candidateSha, reference, reportType))
  );
}

async function resolveReports(
  request: IReleaseCandidateRequest,
  reportResolver: ReturnType<typeof resolveReportResolver>,
): Promise<{ readonly parity: IReleaseReport; readonly provenance: IReleaseReport }> {
  const parity = assertResolvedReport(
    await reportResolver(
      request.repository,
      request.candidateSha,
      request.reportArtifacts.parity,
      "parity",
    ),
    "parity",
    request.candidateSha,
    request.reportArtifacts.parity,
    "parity",
  );
  const provenance = assertResolvedReport(
    await reportResolver(
      request.repository,
      request.candidateSha,
      request.reportArtifacts.provenance,
      "provenance",
    ),
    "provenance",
    request.candidateSha,
    request.reportArtifacts.provenance,
    "provenance",
  );
  return { parity, provenance };
}

export async function resolveReleaseCandidate(
  options: IReleaseCandidateResolutionOptions,
): Promise<IReleaseCandidate> {
  const repo = resolve(options.repo ?? REPO);
  const expectedRepository = options.expectedRepository;
  const request = parseReleaseCandidateRequest(options.request, expectedRepository, repo);
  const availability = parseReleaseAvailability(options.availability);
  const identityErrors: string[] = [];
  const invokingSha = shaValue(options.invokingSha, "invoking commit SHA", identityErrors);
  const producerRunId = positiveId(options.producerRunId, "producer run ID", identityErrors);
  if (invokingSha !== undefined && invokingSha.toLowerCase() !== request.candidateSha.toLowerCase())
    identityErrors.push("request.candidateSha must equal the invoking workflow commit SHA.");
  if (identityErrors.length > 0) throw new ReleaseCandidateResolutionError("FAIL", identityErrors);

  const packageCohort = await resolvePackageCohort(repo, options);
  const requiredRuns = await resolveRequiredRuns(request, resolveRunResolver(repo, options));
  const reports = await resolveReports(request, resolveReportResolver(repo, options));
  const candidate: IReleaseCandidate = {
    schemaVersion: 1,
    repository: request.repository,
    tag: request.tag,
    candidateSha: request.candidateSha,
    runtimeVersion: request.runtimeVersion,
    packageCohort,
    requiredRuns,
    parity: reports.parity,
    provenance: reports.provenance,
    subjects: {
      github: expectedGithubSubjects(),
      npm: packageCohort.map((item) => `${item.name}@${item.version}`).sort(),
    },
    credentials: availability.credentials,
    hostedCapabilities: availability.hostedCapabilities,
    releaseScope: request.releaseScope,
    resolution: {
      producerRunId: producerRunId as number,
      source: "release-candidate-workflow",
      packageSource: "workspace-manifests",
      githubSubjectSource: "runtime-native-prebuilt-keys",
      evidenceSource: "github-api-and-artifacts",
      registrySource: "npm-version-metadata-and-tarballs",
      availabilitySource: "workflow-inputs",
      registryVerified: true,
      evidenceVerified: true,
    },
  };
  const validation = validateReleaseCandidate(
    candidate,
    request.repository,
    invokingSha as string,
    producerRunId,
    repo,
  );
  if (validation.status === "FAIL")
    throw new ReleaseCandidateResolutionError("FAIL", validation.errors);
  return candidate;
}

export function formatReleaseCandidateValidation(result: IReleaseCandidateValidation): string {
  const lines = [`${result.status}: releaseCandidateV1`];
  for (const error of result.errors) lines.push(`FAIL ${error}`);
  for (const blocker of result.blockers) lines.push(`BLOCKED ${blocker} is unavailable.`);
  if (result.status === "PASS")
    lines.push("Exact candidate, dependency evidence, subject set, and release inputs are ready.");
  return `${lines.join("\n")}\n`;
}

function cliError(message: string, exitCode: 1 | 2): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
  throw new Error(message);
}

interface ICliOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function cliFlagSets(command: "validate" | "resolve"): {
  readonly booleanFlags: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
} {
  return {
    valueFlags:
      command === "validate"
        ? new Set(["--candidate", "--repository", "--producer-run-id"])
        : new Set(["--request", "--availability", "--output", "--repository"]),
    booleanFlags: command === "validate" ? new Set(["--verify-registry"]) : new Set<string>(),
  };
}

function consumeCliArgument(
  argv: readonly string[],
  index: number,
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
  values: Map<string, string>,
  flags: Set<string>,
): number {
  const argument = argv[index];
  if (argument === undefined) return index + 1;
  if (booleanFlags.has(argument)) {
    if (flags.has(argument)) cliError(`TN_RELEASE_CANDIDATE_USAGE: duplicate '${argument}'.`, 1);
    flags.add(argument);
    return index + 1;
  }
  if (!valueFlags.has(argument))
    cliError(`TN_RELEASE_CANDIDATE_USAGE: unknown argument '${argument}'.`, 1);
  if (values.has(argument)) cliError(`TN_RELEASE_CANDIDATE_USAGE: duplicate '${argument}'.`, 1);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    cliError(`TN_RELEASE_CANDIDATE_USAGE: ${argument} requires a value.`, 1);
  values.set(argument, value);
  return index + 2;
}

function parseCliOptions(argv: readonly string[], command: "validate" | "resolve"): ICliOptions {
  const { valueFlags, booleanFlags } = cliFlagSets(command);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let index = 1;
  while (index < argv.length)
    index = consumeCliArgument(argv, index, valueFlags, booleanFlags, values, flags);
  return { values, flags };
}

function optionValue(options: ICliOptions, name: string, required: boolean): string | undefined {
  const value = options.values.get(name);
  if (required && value === undefined)
    cliError(`TN_RELEASE_CANDIDATE_USAGE: ${name} requires a value.`, 1);
  return value;
}

function positiveCliId(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value))
    cliError(`TN_RELEASE_CANDIDATE_USAGE: ${name} must be a positive integer.`, 1);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    cliError(`TN_RELEASE_CANDIDATE_USAGE: ${name} must be a positive safe integer.`, 1);
  return parsed;
}

function readJsonInput(file: string, label: string): unknown {
  const path = resolve(file);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    const missing =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    cliError(
      missing
        ? `TN_RELEASE_CANDIDATE_BLOCKED: ${label} '${path}' is missing.`
        : `TN_RELEASE_CANDIDATE_FAIL: ${label} '${path}' is not valid JSON.`,
      missing ? 2 : 1,
    );
  }
}

function validationWithRegistry(
  result: IReleaseCandidateValidation,
  registry: Pick<IReleaseCandidateValidation, "errors" | "blockers">,
): IReleaseCandidateValidation {
  if (registry.errors.length > 0)
    return { status: "FAIL", exitCode: 1, errors: registry.errors, blockers: [] };
  if (registry.blockers.length > 0)
    return {
      status: "BLOCKED",
      exitCode: 2,
      errors: [],
      blockers: [...result.blockers, ...registry.blockers],
    };
  return result;
}

async function validateCommand(options: ICliOptions): Promise<void> {
  const candidatePath = optionValue(options, "--candidate", true) as string;
  const parsed = readJsonInput(candidatePath, "candidate file");
  const expectedRepository =
    optionValue(options, "--repository", false) ?? process.env.GITHUB_REPOSITORY;
  const producerRunId = positiveCliId(
    optionValue(options, "--producer-run-id", false),
    "--producer-run-id",
  );
  let result = validateReleaseCandidate(
    parsed,
    expectedRepository,
    process.env.GITHUB_SHA,
    producerRunId,
  );
  if (options.flags.has("--verify-registry") && result.status !== "FAIL" && isRecord(parsed)) {
    const registry = await verifyRegistryCohort(parsed as Pick<IReleaseCandidate, "packageCohort">);
    result = validationWithRegistry(result, registry);
  }
  process.stdout.write(formatReleaseCandidateValidation(result));
  process.exitCode = result.exitCode;
}

function resolutionCliError(error: unknown): never {
  if (error instanceof ReleaseCandidateResolutionError)
    cliError(
      `TN_RELEASE_CANDIDATE_${error.status}: ${error.details.join(" ")}`,
      error.status === "BLOCKED" ? 2 : 1,
    );
  cliError(
    `TN_RELEASE_CANDIDATE_FAIL: ${error instanceof Error ? error.message : String(error)}`,
    1,
  );
}

async function resolveCommand(options: ICliOptions): Promise<void> {
  const requestPath = optionValue(options, "--request", true) as string;
  const availabilityPath = optionValue(options, "--availability", true) as string;
  const outputPath = optionValue(options, "--output", true) as string;
  const invokingSha = process.env.GITHUB_SHA;
  const producerRunId = positiveCliId(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  if (invokingSha === undefined || invokingSha.length === 0)
    cliError("TN_RELEASE_CANDIDATE_BLOCKED: GITHUB_SHA is required to resolve a candidate.", 2);
  if (producerRunId === undefined)
    cliError("TN_RELEASE_CANDIDATE_BLOCKED: GITHUB_RUN_ID is required to resolve a candidate.", 2);
  const request = readJsonInput(requestPath, "request file");
  const availability = readJsonInput(availabilityPath, "availability file");
  const expectedRepository =
    optionValue(options, "--repository", false) ?? process.env.GITHUB_REPOSITORY;
  try {
    const candidate = await resolveReleaseCandidate({
      request,
      availability,
      repo: REPO,
      expectedRepository,
      invokingSha,
      producerRunId,
    });
    writeFileSync(resolve(outputPath), `${JSON.stringify(candidate, null, 2)}\n`);
    const validation = validateReleaseCandidate(
      candidate,
      candidate.repository,
      invokingSha,
      producerRunId,
    );
    process.stdout.write(formatReleaseCandidateValidation(validation));
    process.exitCode = validation.exitCode;
  } catch (error: unknown) {
    resolutionCliError(error);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command !== "validate" && command !== "resolve")
    cliError("TN_RELEASE_CANDIDATE_USAGE: expected 'validate' or 'resolve'.", 1);
  const options = parseCliOptions(argv, command);
  if (command === "validate") await validateCommand(options);
  else await resolveCommand(options);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch((error: unknown) => {
    if (process.exitCode === undefined)
      process.stderr.write(
        `TN_RELEASE_CANDIDATE_FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    if (process.exitCode === undefined) process.exitCode = 1;
  });
}
