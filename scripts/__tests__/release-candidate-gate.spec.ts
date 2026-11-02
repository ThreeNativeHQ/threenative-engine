import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FULL_RELEASE_SCOPE,
  type IRegistryObservation,
  type IReleaseCandidate,
  type IReleaseCandidateRequest,
  type IReleaseReport,
  type IReleaseReportReference,
  type IReleaseRun,
  REQUIRED_CREDENTIALS,
  REQUIRED_HOSTED_CAPABILITIES,
  expectedGithubSubjects,
  expectedReleasePackages,
  expectedReleaseReportReference,
  expectedReleaseReportSubjects,
  normalizedPackageTreeHash,
  parseEvidenceReport,
  parseGithubRun,
  platformsCoveringPublishedAssets,
  registryPackageObservation,
  requiredCredentials,
  requiredHostedCapabilities,
  resolveReleaseCandidate,
  validateReleaseCandidate,
  verifyRegistryCohort,
} from "../release-candidate-gate.js";

const CANDIDATE_SHA = "a".repeat(40);
const RUNTIME_VERSION =
  expectedReleasePackages().find((item) => item.name === "@threenative/runtime-native")?.version ??
  (() => {
    throw new Error("release candidate fixture is missing @threenative/runtime-native");
  })();

function packageTarball(): Buffer {
  const root = mkdtempSync(join(tmpdir(), "threenative-release-test-"));
  try {
    mkdirSync(join(root, "package"));
    writeFileSync(
      join(root, "package", "package.json"),
      JSON.stringify({ name: "@threenative/core", version: "0.3.0" }),
    );
    writeFileSync(join(root, "package", "README.md"), "release fixture\n");
    const archive = join(root, "package.tgz");
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    return readFileSync(archive);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function candidate(overrides: Partial<IReleaseCandidate> = {}): IReleaseCandidate {
  const packages = expectedReleasePackages().map((item) => ({
    ...item,
    registryState: "absent" as const,
  }));
  return {
    schemaVersion: 1,
    repository: "ThreeNativeHQ/threenative",
    tag: `runtime-native-v${RUNTIME_VERSION}`,
    candidateSha: CANDIDATE_SHA,
    runtimeVersion: RUNTIME_VERSION,
    packageCohort: packages,
    requiredRuns: {
      ci: {
        databaseId: 101,
        status: "completed",
        conclusion: "success",
        event: "push",
        headBranch: "main",
        headSha: CANDIDATE_SHA,
        workflowPath: ".github/workflows/ci.yml",
      },
    },
    parity: {
      reportSchemaVersion: 1,
      reportType: "parity",
      candidateSha: CANDIDATE_SHA,
      verdict: "PASS",
      reportSha256: "b".repeat(64),
      sourceRunId: 101,
      sourceWorkflowPath: ".github/workflows/ci.yml",
      artifactName: "native-release-parity",
      artifactPath: "reports/parity.json",
      subjects: expectedReleaseReportSubjects("parity"),
    },
    provenance: {
      reportSchemaVersion: 1,
      reportType: "provenance",
      candidateSha: CANDIDATE_SHA,
      verdict: "PASS",
      reportSha256: "c".repeat(64),
      sourceRunId: 101,
      sourceWorkflowPath: ".github/workflows/ci.yml",
      artifactName: "native-release-provenance",
      artifactPath: "reports/provenance.json",
      subjects: expectedReleaseReportSubjects("provenance"),
    },
    subjects: {
      github: expectedGithubSubjects(),
      npm: packages.map((item) => `${item.name}@${item.version}`).sort(),
    },
    credentials: Object.fromEntries(
      REQUIRED_CREDENTIALS.map((name) => [name, true]),
    ) as IReleaseCandidate["credentials"],
    hostedCapabilities: Object.fromEntries(
      REQUIRED_HOSTED_CAPABILITIES.map((name) => [name, true]),
    ) as IReleaseCandidate["hostedCapabilities"],
    releaseScope: FULL_RELEASE_SCOPE,
    resolution: {
      producerRunId: 103,
      source: "release-candidate-workflow",
      packageSource: "workspace-manifests",
      githubSubjectSource: "runtime-native-prebuilt-keys",
      evidenceSource: "github-api-and-artifacts",
      registrySource: "npm-version-metadata-and-tarballs",
      availabilitySource: "workflow-inputs",
      registryVerified: true,
      evidenceVerified: true,
    },
    ...overrides,
  };
}

describe("release candidate gate", () => {
  it("reads every report from the main push CI run, and refuses a second evidence run", () => {
    const base = candidate();
    expect(validateReleaseCandidate(base, "ThreeNativeHQ/threenative").errors).toEqual([]);
    expect(
      validateReleaseCandidate(
        { ...base, requiredRuns: { ...base.requiredRuns, native: base.requiredRuns.ci } },
        "ThreeNativeHQ/threenative",
      ).errors,
    ).toContain("requiredRuns has unknown key 'native'.");
    const ciDispatched = {
      ...base,
      requiredRuns: {
        ...base.requiredRuns,
        ci: { ...base.requiredRuns.ci, event: "workflow_dispatch" },
      },
    };
    expect(validateReleaseCandidate(ciDispatched, "ThreeNativeHQ/threenative").errors).toContain(
      "requiredRuns.ci.event must be 'push'.",
    );
  });

  it("should accept a complete exact-candidate release input", () => {
    expect(validateReleaseCandidate(candidate(), "ThreeNativeHQ/threenative")).toEqual({
      status: "PASS",
      exitCode: 0,
      errors: [],
      blockers: [],
    });
  });

  it("should reject a report wrapper with an arbitrary artifact contract or subject set", () => {
    const invalid = candidate({
      parity: {
        ...candidate().parity,
        artifactName: "arbitrary-report",
        artifactPath: "arbitrary.json",
        subjects: ["arbitrary.json"],
      },
    });

    const result = validateReleaseCandidate(invalid, "ThreeNativeHQ/threenative");

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toMatch(/parity|artifact|subject/i);
  });

  it("should reject a minimal PASS payload that omits the parity target evidence", () => {
    const payload = {
      candidateSha: CANDIDATE_SHA,
      verdict: "PASS",
      subjects: expectedReleaseReportSubjects("parity"),
    };

    expect(() =>
      parseEvidenceReport(
        Buffer.from(JSON.stringify(payload)),
        CANDIDATE_SHA,
        "reports/parity.json",
        "parity",
      ),
    ).toThrow(/schemaVersion|targetReports|registrySha256/i);
  });

  it("should reject provenance evidence with an incomplete subject hash set", () => {
    const subjects = expectedReleaseReportSubjects("provenance");
    const payload = {
      schemaVersion: 1,
      reportType: "provenance",
      candidateSha: CANDIDATE_SHA,
      verdict: "PASS",
      subjects,
      subjectHashes: Object.fromEntries(
        subjects.slice(1).map((subject) => [subject, "a".repeat(64)]),
      ),
      dependencyLockSha256: "a".repeat(64),
      sbomSha256: "a".repeat(64),
      licenseInventorySha256: "a".repeat(64),
      pnpmLockSha256: "a".repeat(64),
      cargoLockSha256: "a".repeat(64),
    };

    expect(() =>
      parseEvidenceReport(
        Buffer.from(JSON.stringify(payload)),
        CANDIDATE_SHA,
        "reports/provenance.json",
        "provenance",
      ),
    ).toThrow(/subjectHashes/i);
  });

  it("should reject unknown missing or secret-bearing release candidate fields", () => {
    const invalid = {
      ...candidate(),
      // Deliberately model the mistake as an unknown top-level key rather than accepting a secret.
      npmToken: "do-not-serialize",
      provenance: { ...candidate().provenance, subjects: [] },
    } as unknown as IReleaseCandidate;
    const result = validateReleaseCandidate(invalid, "ThreeNativeHQ/threenative");

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toMatch(/unknown key.*npmToken|provenance.*subject/i);
  });

  it("should require successful CI parity and provenance evidence from the tag commit", () => {
    const stale = candidate({
      requiredRuns: {
        ...candidate().requiredRuns,
        ci: { ...candidate().requiredRuns.ci, headSha: "d".repeat(40) },
      },
      parity: { ...candidate().parity, candidateSha: "d".repeat(40) },
    });
    const result = validateReleaseCandidate(stale, "ThreeNativeHQ/threenative");

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toMatch(/candidate.*SHA|headSha|parity/i);
  });

  it("should reject incomplete package and GitHub subject sets", () => {
    const complete = candidate();
    const firstPackage = complete.packageCohort[0];
    const firstGithubSubject = complete.subjects.github[0];
    if (firstPackage === undefined || firstGithubSubject === undefined)
      throw new Error("complete candidate fixture is unexpectedly empty");
    const invalid = candidate({
      packageCohort: [firstPackage],
      subjects: {
        github: [firstGithubSubject],
        npm: ["@threenative/core@0.2.3"],
      },
    });
    const result = validateReleaseCandidate(invalid, "ThreeNativeHQ/threenative");

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toMatch(/packageCohort|subjects\.github/i);
  });

  it("should require every public package to use its manifest version", () => {
    const complete = candidate();
    const firstPackage = complete.packageCohort[0];
    if (firstPackage === undefined)
      throw new Error("complete candidate fixture is unexpectedly empty");
    const invalid = candidate({
      packageCohort: complete.packageCohort.map((item) =>
        item.name === firstPackage.name ? { ...item, version: "9.9.9" } : item,
      ),
    });
    const result = validateReleaseCandidate(invalid, "ThreeNativeHQ/threenative");

    expect(result.status).toBe("FAIL");
    expect(result.errors.join("\n")).toContain(
      `packageCohort.${firstPackage.name} must use workspace version ${firstPackage.version}`,
    );
  });

  it("should bind the candidate file to the commit that invokes the gate", () => {
    const result = validateReleaseCandidate(
      candidate(),
      "ThreeNativeHQ/threenative",
      "d".repeat(40),
    );

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("candidateSha must equal invoking commit SHA");
  });

  it("should block before signing or publication when any required credential is absent", () => {
    const credentials = { ...candidate().credentials, iosSigning: false };
    const result = validateReleaseCandidate(
      candidate({ credentials }),
      "ThreeNativeHQ/threenative",
    );

    expect(result).toEqual({
      status: "BLOCKED",
      exitCode: 2,
      errors: [],
      blockers: ["credentials.iosSigning"],
    });
  });

  it("should block when a hosted platform capability is unavailable", () => {
    const hostedCapabilities = { ...candidate().hostedCapabilities, macosRunner: false };
    const result = validateReleaseCandidate(
      candidate({ hostedCapabilities }),
      "ThreeNativeHQ/threenative",
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.exitCode).toBe(2);
    expect(result.blockers).toEqual(["hostedCapabilities.macosRunner"]);
  });

  it("should publish an explicitly unsigned release without any signing credential", () => {
    // The repository holds one Actions secret, NPM_TOKEN. Before the release scope existed this
    // shape produced seven blockers and could never publish anything.
    const credentials = {
      ...candidate().credentials,
      linuxAttestation: false,
      windowsSigning: false,
      macosSigning: false,
      macosNotarization: false,
      androidSigning: false,
      iosSigning: false,
      iosExport: false,
    };
    const hostedCapabilities = { ...candidate().hostedCapabilities, timestampService: false };
    const result = validateReleaseCandidate(
      candidate({
        credentials,
        hostedCapabilities,
        releaseScope: { platforms: FULL_RELEASE_SCOPE.platforms, signed: false },
      }),
      "ThreeNativeHQ/threenative",
    );

    expect(result).toEqual({ status: "PASS", exitCode: 0, errors: [], blockers: [] });
  });

  it("should still block an unsigned release when npm publication is unavailable", () => {
    const credentials = { ...candidate().credentials, npmPublish: false };
    const result = validateReleaseCandidate(
      candidate({
        credentials,
        releaseScope: { platforms: FULL_RELEASE_SCOPE.platforms, signed: false },
      }),
      "ThreeNativeHQ/threenative",
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.blockers).toEqual(["credentials.npmPublish"]);
  });

  it("should still block an unsigned release when a declared platform has no runner", () => {
    const hostedCapabilities = { ...candidate().hostedCapabilities, windowsRunner: false };
    const result = validateReleaseCandidate(
      candidate({
        hostedCapabilities,
        releaseScope: { platforms: FULL_RELEASE_SCOPE.platforms, signed: false },
      }),
      "ThreeNativeHQ/threenative",
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.blockers).toEqual(["hostedCapabilities.windowsRunner"]);
  });

  it("should reject a scope that drops a platform whose binaries the release publishes", () => {
    const result = validateReleaseCandidate(
      candidate({ releaseScope: { platforms: ["linux", "android"], signed: false } }),
      "ThreeNativeHQ/threenative",
    );

    expect(result.status).toBe("FAIL");
    expect(result.errors.join("\n")).toContain("must cover every published asset platform");
  });

  it("should demand every signing credential again when the release declares itself signed", () => {
    expect(requiredCredentials({ platforms: FULL_RELEASE_SCOPE.platforms, signed: true })).toEqual(
      REQUIRED_CREDENTIALS,
    );
    expect(
      requiredHostedCapabilities({ platforms: FULL_RELEASE_SCOPE.platforms, signed: true }),
    ).toEqual(REQUIRED_HOSTED_CAPABILITIES);
    expect(requiredCredentials({ platforms: FULL_RELEASE_SCOPE.platforms, signed: false })).toEqual(
      ["npmPublish"],
    );
  });

  it("should accept a candidate with no releaseScope as the historical signed contract", () => {
    // The field is optional on the wire; omitting it must behave exactly as before it existed.
    const { releaseScope: _omitted, ...withoutScope } = candidate();
    const result = validateReleaseCandidate(
      withoutScope as unknown as IReleaseCandidate,
      "ThreeNativeHQ/threenative",
    );

    expect(result).toEqual({ status: "PASS", exitCode: 0, errors: [], blockers: [] });
  });

  it("should still demand every signing credential when releaseScope is omitted", () => {
    const { releaseScope: _omitted, ...withoutScope } = candidate({
      credentials: { ...candidate().credentials, iosSigning: false },
    });
    const result = validateReleaseCandidate(
      withoutScope as unknown as IReleaseCandidate,
      "ThreeNativeHQ/threenative",
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.blockers).toEqual(["credentials.iosSigning"]);
  });

  it("should refuse a scope that declares no platform at all", () => {
    expect(() => requiredCredentials({ platforms: [], signed: false })).toThrow(
      "TN_RELEASE_SCOPE_EMPTY",
    );
    expect(() => requiredHostedCapabilities({ platforms: [], signed: false })).toThrow(
      "TN_RELEASE_SCOPE_EMPTY",
    );
  });

  it("should cover every published non-iOS prebuilt asset key with a known release platform", () => {
    // Guards the scope check itself: an asset key matching no platform prefix would leave that
    // platform silently uncovered, so the derivation refuses it rather than ignoring it. iOS keeps
    // its own release gate and is not a supported target, so it is not a coverage requirement.
    expect(() => platformsCoveringPublishedAssets()).not.toThrow();
    expect(platformsCoveringPublishedAssets()).toEqual(["linux", "windows", "macos", "android"]);
  });

  it("should accept a scope that excludes iOS, the unsupported target", () => {
    // The supported cohort is web, Windows, macOS, Linux and Android. A scope naming those four
    // native platforms and no iOS is satisfiable without Xcode; before the coverage set dropped
    // iOS this returned FAIL demanding an ios platform whose capability the dispatch never sets.
    const result = validateReleaseCandidate(
      candidate({
        releaseScope: { platforms: ["linux", "windows", "macos", "android"], signed: false },
        credentials: { ...candidate().credentials, iosSigning: false, iosExport: false },
        hostedCapabilities: { ...candidate().hostedCapabilities, xcode: false },
      }),
      "ThreeNativeHQ/threenative",
    );

    expect(result).toEqual({ status: "PASS", exitCode: 0, errors: [], blockers: [] });
  });

  it("should reject a mismatched package subject set or a non-publishable registry state", () => {
    const invalid = candidate({
      packageCohort: [
        {
          name: "@threenative/core",
          version: "0.2.3",
          registryState: "matching",
        },
      ],
      subjects: { ...candidate().subjects, npm: ["@threenative/core@0.2.3"] },
    });
    const result = validateReleaseCandidate(invalid, "ThreeNativeHQ/threenative");

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toMatch(/packedSha256|cohort|subject/i);
  });

  it("should require a producer resolution record instead of trusting a handwritten candidate", () => {
    const invalid = { ...candidate(), resolution: undefined } as unknown as IReleaseCandidate;
    const result = validateReleaseCandidate(invalid, "ThreeNativeHQ/threenative");

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("resolution must be an object");
  });

  it("should map the GitHub REST run id into the candidate run identity", () => {
    expect(
      parseGithubRun(
        {
          id: 204,
          status: "completed",
          conclusion: "success",
          event: "push",
          head_branch: "main",
          head_sha: CANDIDATE_SHA,
          path: ".github/workflows/ci.yml",
        },
        204,
        CANDIDATE_SHA,
        ".github/workflows/ci.yml",
      ),
    ).toEqual({
      databaseId: 204,
      status: "completed",
      conclusion: "success",
      event: "push",
      headBranch: "main",
      headSha: CANDIDATE_SHA,
      workflowPath: ".github/workflows/ci.yml",
    });
  });

  it("should compare matching registry claims with downloaded tarball observations", async () => {
    const item = candidate().packageCohort[0];
    if (item === undefined) throw new Error("complete candidate fixture is unexpectedly empty");
    const matching: IRegistryObservation = {
      state: "matching",
      integrity: "sha512-actual",
      packedSha256: "d".repeat(64),
      normalizedSha256: "a".repeat(64),
    };
    const invalid = candidate({
      packageCohort: [
        {
          ...item,
          registryState: "matching",
          integrity: "sha512-claimed",
          packedSha256: "e".repeat(64),
          normalizedSha256: "f".repeat(64),
        },
        ...candidate().packageCohort.slice(1),
      ],
    });
    const result = await verifyRegistryCohort(invalid, async () => matching);

    expect(result.blockers).toEqual([]);
    expect(result.errors.join("\n")).toMatch(/integrity|tarball SHA-256/i);
  });

  it("should hash the registry tarball against npm integrity metadata", async () => {
    const contents = packageTarball();
    const integrity = `sha512-${createHash("sha512").update(contents).digest("base64")}`;
    const fetchMock = vi.fn(async (input: string | URL) => {
      if (String(input).startsWith("https://registry.npmjs.org/%40threenative%2Fcore"))
        return new Response(
          JSON.stringify({
            versions: {
              "0.3.0": {
                name: "@threenative/core",
                version: "0.3.0",
                dist: { integrity, tarball: "https://registry.npmjs.org/core-fixture.tgz" },
              },
            },
          }),
        );
      return new Response(new Uint8Array(contents));
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(registryPackageObservation("@threenative/core", "0.3.0")).resolves.toEqual({
        state: "matching",
        integrity,
        packedSha256: createHash("sha256").update(contents).digest("hex"),
        normalizedSha256: normalizedPackageTreeHash(contents, "@threenative/core", "0.3.0"),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should derive the package, run, report, subject, and availability fields", async () => {
    const request: IReleaseCandidateRequest = {
      schemaVersion: 1,
      repository: "ThreeNativeHQ/threenative",
      tag: `runtime-native-v${RUNTIME_VERSION}`,
      candidateSha: CANDIDATE_SHA,
      runtimeVersion: RUNTIME_VERSION,
      releaseScope: FULL_RELEASE_SCOPE,
      requiredRunIds: { ci: 201 },
      reportArtifacts: {
        parity: {
          ...expectedReleaseReportReference("parity", 201),
        },
        provenance: {
          ...expectedReleaseReportReference("provenance", 201),
        },
      },
    };
    const availability = {
      credentials: Object.fromEntries(REQUIRED_CREDENTIALS.map((name) => [name, true])),
      hostedCapabilities: Object.fromEntries(
        REQUIRED_HOSTED_CAPABILITIES.map((name) => [name, true]),
      ),
    };
    const run = (
      _repository: string,
      runId: number,
      _sha: string,
      workflowPath: string,
    ): IReleaseRun => ({
      databaseId: runId,
      status: "completed",
      conclusion: "success",
      event: "push",
      headBranch: "main",
      headSha: CANDIDATE_SHA,
      workflowPath,
    });
    const report = (
      _repository: string,
      sha: string,
      reference: IReleaseReportReference,
      reportType: "parity" | "provenance",
    ): IReleaseReport => ({
      reportSchemaVersion: 1,
      reportType,
      candidateSha: sha,
      verdict: "PASS",
      reportSha256: "f".repeat(64),
      sourceRunId: reference.runId,
      sourceWorkflowPath: reference.workflowPath,
      artifactName: reference.artifactName,
      artifactPath: reference.artifactPath,
      subjects: expectedReleaseReportSubjects(reportType),
    });
    const absent = async (): Promise<IRegistryObservation> => ({ state: "absent" });

    const resolved = await resolveReleaseCandidate({
      request,
      availability,
      invokingSha: CANDIDATE_SHA,
      producerRunId: 203,
      resolveRun: run,
      resolveReport: report,
      registryLookup: absent,
    });

    expect(resolved.packageCohort.map(({ name }) => name)).toEqual(
      expectedReleasePackages().map(({ name }) => name),
    );
    expect(resolved.subjects.github).toEqual(expectedGithubSubjects());
    expect(resolved.requiredRuns.ci.databaseId).toBe(201);
    expect(resolved.provenance.reportSha256).toBe("f".repeat(64));
    expect(validateReleaseCandidate(resolved, request.repository, CANDIDATE_SHA, 203).status).toBe(
      "PASS",
    );
  });

  it("should reject registry bytes whose normalized package tree differs from the workspace", async () => {
    const request: IReleaseCandidateRequest = {
      schemaVersion: 1,
      repository: "ThreeNativeHQ/threenative",
      tag: `runtime-native-v${RUNTIME_VERSION}`,
      candidateSha: CANDIDATE_SHA,
      runtimeVersion: RUNTIME_VERSION,
      releaseScope: FULL_RELEASE_SCOPE,
      requiredRunIds: { ci: 201 },
      reportArtifacts: {
        parity: {
          ...expectedReleaseReportReference("parity", 201),
        },
        provenance: {
          ...expectedReleaseReportReference("provenance", 201),
        },
      },
    };
    const availability = {
      credentials: Object.fromEntries(REQUIRED_CREDENTIALS.map((name) => [name, true])),
      hostedCapabilities: Object.fromEntries(
        REQUIRED_HOSTED_CAPABILITIES.map((name) => [name, true]),
      ),
    };
    const run = (
      _repository: string,
      runId: number,
      _sha: string,
      workflowPath: string,
    ): IReleaseRun => ({
      databaseId: runId,
      status: "completed",
      conclusion: "success",
      event: "push",
      headBranch: "main",
      headSha: CANDIDATE_SHA,
      workflowPath,
    });
    const report = (
      _repository: string,
      sha: string,
      reference: IReleaseReportReference,
      reportType: "parity" | "provenance",
    ): IReleaseReport => ({
      reportSchemaVersion: 1,
      reportType,
      candidateSha: sha,
      verdict: "PASS",
      reportSha256: "f".repeat(64),
      sourceRunId: reference.runId,
      sourceWorkflowPath: reference.workflowPath,
      artifactName: reference.artifactName,
      artifactPath: reference.artifactPath,
      subjects: expectedReleaseReportSubjects(reportType),
    });
    const matching = async (): Promise<IRegistryObservation> => ({
      state: "matching",
      integrity: "sha512-actual",
      packedSha256: "d".repeat(64),
      normalizedSha256: "e".repeat(64),
    });

    await expect(
      resolveReleaseCandidate({
        request,
        availability,
        invokingSha: CANDIDATE_SHA,
        producerRunId: 203,
        resolveRun: run,
        resolveReport: report,
        registryLookup: matching,
        workspacePackageHash: async () => "f".repeat(64),
      }),
    ).rejects.toThrow(/normalized|workspace|package/i);
  });
});

describe("PRD-373 promotion is not release provenance", () => {
  it.each([
    { event: "pull_request", headBranch: "promotion/frozen", headSha: CANDIDATE_SHA },
    { event: "schedule", headBranch: "develop", headSha: CANDIDATE_SHA },
    { event: "push", headBranch: "main", headSha: "d".repeat(40) },
  ])("rejects a successful but non-authorizing qualification run: %o", (run) => {
    const input = candidate();
    const promoted = {
      ...input,
      requiredRuns: { ...input.requiredRuns, ci: { ...input.requiredRuns.ci, ...run } },
    };
    const verdict = validateReleaseCandidate(promoted, "ThreeNativeHQ/threenative");
    expect(verdict.status).toBe("FAIL");
    expect(verdict.exitCode).toBe(1);
    expect(verdict.errors.join("\n")).toMatch(/push|main|headSha|candidate/u);
  });
});
