import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
const url = new URL("../ci-integration-scope.mjs", import.meta.url).href;
const {
  integrationSelection,
  integrationGitSelection,
  INDEPENDENT_CORE_MODULES,
  INDEPENDENT_PACKAGES,
  INDEPENDENT_PROOFS,
  integrationCandidatePreflight,
} = await import(url);
const { classify, selectionPlan } = await import(
  new URL("../ci-change-scope.mjs", import.meta.url).href
);
const workflow = readFileSync(
  new URL("../../.github/workflows/integration.yml", import.meta.url),
  "utf8",
)
  .replace(/\n {2}completion:\n[\s\S]*$/u, "\n")
  .replace(/ {4}outputs:\n {6}coverage_receipt:\n {8}value:.*\n/u, "");
function select(after: string, files = [".github/workflows/integration.yml"]) {
  return integrationSelection({ before: workflow, after, files }).lanes;
}
const none = Object.fromEntries(
  [
    ...workflow.matchAll(
      /^ {6}([a-z][a-z-]*): \$\{\{ steps\.filter\.outputs\.[a-z][a-z-]* \}\}$/gmu,
    ),
  ].map((match) => [match[1], false]),
);
const all = Object.fromEntries(Object.keys(none).map((key) => [key, true]));
describe("integration work applies to the changed source", () => {
  it("retains animation routing for weighted playback and authored locomotion", () => {
    for (const file of [
      "packages/core/src/animation.ts",
      "packages/core/__tests__/animation-weighted.spec.ts",
      "packages/core/__tests__/vq-locomotion-blend-spaces.spec.ts",
      "examples/abyss-framework/src/render/locomotion-weights.ts",
      "examples/abyss-framework/src/render/animation-reversal-game.ts",
    ]) {
      expect(select(workflow, [file]).animation, file).toBe(true);
    }
  });
  it("selects the animation lane alone for the two-rig locomotion capture", () => {
    for (const file of [
      "scripts/verify-vq-locomotion.ts",
      "examples/abyss-framework/src/render/vq-locomotion-game.ts",
      "examples/abyss-framework/src/render/vq-locomotion-trace.ts",
      "examples/abyss-framework/src/render/locomotion-driver.ts",
      "examples/abyss-framework/src/vq-locomotion-main.ts",
      "examples/abyss-framework/playtests/vq-locomotion-blend-spaces.playtest.json",
      "examples/abyss-framework/assets/mannequin.glb",
    ]) {
      expect(select(workflow, [file]), file).toEqual({ ...none, animation: true });
    }
  });
  it("keeps animation workflow edits local while preserving other lanes", () => {
    expect(
      select(
        workflow.replace(
          "Capture real mannequin gait reversals",
          "Capture mannequin gait reversals",
        ),
      ),
    ).toEqual({ ...none, animation: true });
  });
  // The hosted native proof is a dependent of `animation`, not a lane of its own: a blend-space
  // source edit has to reach the fresh host build, and the host build has nothing to say when the
  // browser capture did not move.
  it("runs the native locomotion job with its animation lane", () => {
    expect(
      select(
        workflow.replace("Linux native locomotion correctness", "Linux native locomotion verified"),
      ),
    ).toEqual({ ...none, animation: true });
  });
  it("joins the native locomotion job in the real workflow's completion gate", () => {
    const real = readFileSync(
      new URL("../../.github/workflows/integration.yml", import.meta.url),
      "utf8",
    );
    expect(real).toContain("\n  animation-native:\n");
    const reason = (after: string) =>
      integrationSelection({
        files: [".github/workflows/integration.yml"],
        before: real,
        after,
      }).reason;
    // A job the completion gate does not name is a required proof nothing waits for, and the
    // selector has to say so rather than report a board that looks complete.
    expect(reason(real.replace(", animation-native", ""))).toContain("unknown completion join");
    expect(reason(real)).toBe("source filters and bounded job/dependency comparison");
  });

  it("runs exposure alone for an exposure workflow step edit", () => {
    expect(select(workflow.replace("pnpm test:tone", "pnpm test:tone --example"))).toEqual({
      ...none,
      tone: true,
    });
  });
  it("selects the owning fluid root when only its native dependent changes", () => {
    expect(
      select(workflow.replace("Linux native fluid correctness", "Linux native fluid verification")),
    ).toEqual({ ...none, "fluid-native": true });
  });
  it("selects decals and its native dependent for a decal job edit", () => {
    expect(
      select(workflow.replace("Linux native decal correctness", "Linux native decal verification")),
    ).toEqual({ ...none, decals: true });
  });
  it("selects just the lane whose source filter changes", () => {
    expect(
      select(
        workflow.replace("csg ^examples/integrations/csg/", "csg ^examples/integrations/csg-new/"),
      ),
    ).toEqual({ ...none, csg: true });
  });
  it("unions source impact with workflow impact", () => {
    expect(
      select(workflow.replace("pnpm test:tone", "pnpm test:tone --example"), [
        ".github/workflows/integration.yml",
        "packages/core/src/fluid-particles.ts",
      ]),
    ).toEqual({
      ...none,
      tone: true,
      "fluid-particles": true,
      "fluid-native": true,
      exposure: true,
      "cold-boot": true,
    });
  });
  it("retains both native integration consumers for native host changes", () => {
    expect(select(workflow, ["packages/runtime-native/src/main.cpp"])).toEqual({
      ...none,
      decals: true,
      "fluid-native": true,
      exposure: true,
      "cold-boot": true,
    });
  });
  it("retains shared playtest and workspace action consumers", () => {
    expect(select(workflow, ["packages/playtest/src/capture.ts"])).toEqual({
      ...none,
      velocity: true,
      "world-capture": true,
      decals: true,
      tone: true,
      "fluid-particles": true,
      "fluid-native": true,
      exposure: true,
      "cold-boot": true,
    });
    expect(select(workflow, [".github/actions/workspace-dist/action.yml"])).toEqual({
      ...none,
      decals: true,
      "fluid-native": true,
      exposure: true,
      "cold-boot": true,
    });
    expect(select(workflow, [".github/actions/playwright-chromium/action.yml"])).toEqual({
      ...none,
      "world-capture": true,
      decals: true,
      tone: true,
      "fluid-particles": true,
      exposure: true,
      "cold-boot": true,
    });
  });
  it("retains every rendering consumer of the shared display harness", () => {
    expect(select(workflow, ["scripts/xvfb.sh"])).toEqual({
      ...none,
      decals: true,
      tone: true,
      "fluid-particles": true,
      exposure: true,
      "cold-boot": true,
    });
  });
  it("retains exposure coverage for each canonical or generated exposure module", () => {
    for (const name of [
      "autoExposure",
      "exposureGraph",
      "exposureReadback",
      "exposureSettings",
      "worldEnvironment",
    ]) {
      expect(
        select(workflow, [`packages/create-threenative/templates/shooter/src/render/${name}.ts`])
          .tone,
      ).toBe(true);
      expect(
        select(workflow, [`packages/create-threenative/template-assets/${name}.ts`]).tone,
      ).toBe(true);
    }
  });
  it.each(["temporal", "velocity"])("selects %s alone for its workflow job edit", (lane) => {
    expect(select(workflow.replace(`    name: ${lane}\n`, `    name: ${lane} proof\n`))).toEqual({
      ...none,
      [lane]: true,
    });
  });
  it.each([
    ["packages/create-threenative/templates/starter/src/render/temporalAA.ts", "temporal"],
    ["examples/abyss-framework/src/render/velocityCost.ts", "velocity"],
  ])("routes the temporal consumer %s to %s", (file, lane) => {
    expect(select(workflow, [file])).toEqual({ ...none, [lane]: true });
  });
  it("does not run product integration for unrelated CI or inert docs", () => {
    expect(
      select(workflow, ["scripts/__tests__/ci-template-selection.spec.ts", "docs/README.md"]),
    ).toEqual(none);
  });
  it.each([
    ["trigger", "required: true", "required: false"],
    ["permissions", "contents: read", "contents: write"],
    [
      "concurrency",
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
      "cancel-in-progress: false",
    ],
    ["shared paths job", "timeout-minutes: 5", "timeout-minutes: 6"],
    ["entry cross-lane dependency", "needs: paths", "needs: [paths,csg]"],
    ["entry self-cycle", "needs: paths", "needs: [paths,tone]"],
    ["unknown dependency", "needs: [decals]", "needs: [missing-job]"],
    ["cycle", "needs: [decals]", "needs: [decals-native]"],
    ["ambiguous needs", "needs: [decals]", "needs: ${{ inputs.jobs }}"],
    ["unknown shape", "  tone:\n", "  tone: &alias\n"],
  ])("fails closed for %s edits", (_name, before, after) => {
    expect(select(workflow.replace(before, after))).toEqual(all);
  });
  it.each(["\n", "    # output comment\n"])(
    "inventories outputs beyond blank/comment lines: %s",
    (prefix) => {
      expect(
        select(
          workflow.replace(
            "      tone: ${{ steps.filter.outputs.tone }}",
            `${prefix}      tone: \${{ steps.filter.outputs.tone }}`,
          ),
        ),
      ).toEqual(all);
    },
  );
  it("fails visibly if a declared lane loses its output", () => {
    expect(() =>
      select(workflow.replace("      tone: ${{ steps.filter.outputs.tone }}\n", "")),
    ).toThrow("incomplete integration output inventory");
  });
  it.each([
    "tone: ${{ steps.filter.outputs.tone || 'false' }}",
    "tone: ${{ steps.filter.outputs.unknown }}",
    "tone: 'false'",
    "tone: ${{ steps.filter.outputs['tone'] }}",
  ])("fails visibly instead of skipping an unsupported output: %s", (expression) => {
    expect(() =>
      select(workflow.replace("tone: ${{ steps.filter.outputs.tone }}", expression)),
    ).toThrow("unsupported integration output expression");
  });
  it("fails closed when the shared selector changes", () => {
    expect(select(workflow, ["scripts/ci-integration-scope.mjs"])).toEqual(all);
  });
});

describe("integration exact Git source selection", () => {
  it("retains rename endpoints and rejects missing/mismatched candidate identities", () => {
    const root = makeTempDirSync("ci-integration-git-");
    const cwd = process.cwd();
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "test");
      mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
      writeFileSync(path.join(root, ".github/workflows/integration.yml"), workflow);
      mkdirSync(path.join(root, "examples/integrations/csg"), { recursive: true });
      writeFileSync(path.join(root, "examples/integrations/csg/removed.ts"), "source");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      git("mv", "examples/integrations/csg/removed.ts", "docs-renamed.md");
      git("commit", "-qm", "rename");
      const head = git("rev-parse", "HEAD");
      process.chdir(root);
      const plan = classify({
        root,
        base,
        head,
        candidateSha: head,
        target: "develop",
        eventName: "merge_group",
      });
      const preflight = integrationCandidatePreflight({
        plan,
        eventName: "merge_group",
        target: "develop",
        baseSha: base,
      });
      expect(preflight.candidateSha).toBe(head);
      // The queue is narrowed like a pull request into develop, so its inventory comes from the
      // queue's own diff rather than from the whole workflow.
      expect(preflight.qualification).toBe(false);
      expect(preflight.lanes).toEqual({ ...none, csg: true });
      // Deliberate gate retirement must be reflected in every exhaustive event inventory.
      for (const eventName of ["pull_request", "merge_group", "workflow_dispatch", "push"]) {
        const target = eventName === "push" ? "main" : "develop";
        const exhaustive = selectionPlan(
          "full",
          "retained exhaustive inventory",
          [],
          head,
          true,
          0,
          target,
          true,
        );
        const inventory = integrationCandidatePreflight({
          plan: exhaustive,
          eventName,
          target,
          baseSha: base,
        });
        expect(inventory.jobs).not.toContain("fluid-consumers");
        expect(inventory.jobs).toContain("fluid-collision");
        expect(inventory.jobs).toContain("fluid-collision-native");
      }
      expect(preflight.jobs).toEqual(["csg"]);
      const reviewPlan = selectionPlan(
        "ci",
        "review exemption",
        ["scripts/ci-required.mjs"],
        head,
        false,
        0,
        "develop",
      );
      // PRD-550: a narrowed plan is a develop review or queue entry. Everything else still owes the
      // exhaustive inventory.
      expect(
        integrationCandidatePreflight({
          plan: reviewPlan,
          eventName: "merge_group",
          target: "develop",
          baseSha: base,
        }).candidateSha,
      ).toBe(head);
      expect(() =>
        integrationCandidatePreflight({
          plan: reviewPlan,
          eventName: "workflow_dispatch",
          target: "develop",
          baseSha: base,
        }),
      ).toThrow("CI_REQUIRED_QUALIFICATION_MINIMUM");
      expect(() =>
        integrationCandidatePreflight({
          plan,
          eventName: "merge_group",
          target: "develop",
          baseSha: base,
          candidateSha: base,
        }),
      ).toThrow("CI_INTEGRATION_CANDIDATE_MISMATCH");
      for (const malformed of [
        workflow.replace("  decals-native:\n", "  decals-native:\n    if: ${{ false }}\n"),
        workflow.replace(
          "candidate_sha: ${{ steps.filter.outputs.candidate_sha }}",
          "candidate_sha: 'wrong'",
        ),
      ]) {
        writeFileSync(path.join(root, ".github/workflows/integration.yml"), malformed);
        git("add", ".");
        git("commit", "-qm", "malformed scheduling");
        const invalidSha = git("rev-parse", "HEAD");
        const invalid = selectionPlan("full", "test", [], invalidSha, true, 0, "develop", true);
        expect(() =>
          integrationCandidatePreflight({
            plan: invalid,
            eventName: "merge_group",
            target: "develop",
            baseSha: base,
          }),
        ).toThrow(/unknown dependent gate|unsupported integration metadata expression/u);
        git("checkout", "-q", head);
      }
      expect(integrationGitSelection(base, head).lanes).toEqual({ ...none, csg: true });
      mkdirSync(path.join(root, "packages/runtime-native/src"), { recursive: true });
      mkdirSync(path.join(root, "scripts"), { recursive: true });
      writeFileSync(path.join(root, "packages/runtime-native/src/bindings.cpp"), "native fixture");
      git("add", ".");
      git("commit", "-qm", "native source");
      const nativeBase = git("rev-parse", "HEAD");
      git("mv", "packages/runtime-native/src/bindings.cpp", "scripts/verify-fluid-collision.ts");
      git("commit", "-qm", "native to browser rename");
      const mixedHead = git("rev-parse", "HEAD");
      expect(integrationGitSelection(nativeBase, mixedHead).lanes).toEqual({
        ...none,
        decals: true,
        "fluid-native": true,
        "fluid-particles": true,
        exposure: true,
        "cold-boot": true,
      });
      git("rm", "scripts/verify-fluid-collision.ts");
      git("commit", "-qm", "delete browser verifier");
      expect(integrationGitSelection(mixedHead, git("rev-parse", "HEAD")).lanes).toEqual({
        ...none,
        "fluid-particles": true,
      });
      expect(integrationGitSelection(undefined, head).lanes).toEqual(all);
      git("checkout", "-q", base);
      expect(integrationGitSelection(base, head).lanes).toEqual(all);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("merged world capture lane relevance", () => {
  it("retains its exact runtime source filter", () => {
    expect(Object.keys(none)).toContain("world-capture");
    for (const file of [
      "packages/core/src/world-cells.ts",
      "packages/assets/src/index.ts",
      "scripts/verify-world-capture.ts",
    ]) {
      expect(select(workflow, [file])).toEqual({
        ...none,
        "world-capture": true,
        ...(file.startsWith("packages/core/src/") ? { exposure: true, "cold-boot": true } : {}),
      });
    }
  });
  it("selects world capture alone for its workflow job edit", () => {
    expect(
      select(
        workflow.replace(
          "pnpm exec tsx scripts/verify-world-capture.ts",
          "pnpm exec tsx scripts/verify-world-capture.ts --example",
        ),
      ),
    ).toEqual({ ...none, "world-capture": true });
  });
  it("selects world capture alone for its source-filter edit", () => {
    expect(
      select(
        workflow.replace(
          "world-capture ^packages/core/src/world",
          "world-capture ^packages/core/src/new-world",
        ),
      ),
    ).toEqual({ ...none, "world-capture": true });
  });
  it("selects its owning lane for a transitive dependent edit", () => {
    const before = `${workflow}\n  world-dependent:\n    needs: [capture]\n    name: old proof\n`;
    const after = before.replace("name: old proof", "name: updated proof");
    expect(
      integrationSelection({ files: [".github/workflows/integration.yml"], before, after }).lanes,
    ).toEqual({ ...none, "world-capture": true });
  });
  it("fails closed for an unknown world dependency shape", () => {
    const after = workflow.replace(
      /( {2}capture:\n[\s\S]*?) {4}needs: paths/u,
      "$1    needs: [missing-world-job]",
    );
    expect(select(after)).toEqual(all);
  });
});

describe("independent integration lane registration", () => {
  const added = `${workflow
    .replace(
      "    outputs:\n",
      "    outputs:\n      independent: ${{ steps.filter.outputs.independent }}\n",
    )
    .replace(
      "          TN_LANE_FILTERS: |\n",
      "          TN_LANE_FILTERS: |\n            independent ^examples/independent/.*$\n",
    )}\n  independent-proof:\n    needs: paths\n    if: \${{ needs.paths.outputs.independent == 'true' }}\n    steps:\n      - run: echo proof\n`;
  it("selects a newly registered independent lane without unrelated proofs", () => {
    expect(select(added)).toEqual({ ...none, independent: true });
    expect(
      select(added, [".github/workflows/integration.yml", "examples/integrations/ik/main.ts"]),
    ).toEqual({ ...none, ik: true, independent: true });
  });
  it("retains full fallback when an addition also changes shared scheduling", () => {
    expect(select(added.replace("contents: read", "contents: write"))).toEqual({
      ...all,
      independent: true,
    });
  });
  it("rejects additions depending across existing lanes", () => {
    expect(
      select(
        added.replace(
          "    needs: paths\n    if: ${{ needs.paths.outputs.independent",
          "    needs: [paths,csg]\n    if: ${{ needs.paths.outputs.independent",
        ),
      ),
    ).toEqual({ ...all, independent: true });
  });
});

describe("fluid runtime independence", () => {
  it("routes native bindings without Chromium proofs", () => {
    const lanes = select(workflow, ["packages/runtime-native/src/bindings_resources.cpp"]);
    expect(lanes["fluid-native"]).toBe(true);
    expect(lanes["fluid-particles"]).toBe(false);
  });
  it("routes native verifier without Chromium proofs", () => {
    const lanes = select(workflow, ["scripts/verify-fluid-collision-native.ts"]);
    expect(lanes["fluid-native"]).toBe(true);
    expect(lanes["fluid-particles"]).toBe(false);
  });
  it.each([
    "packages/core/src/fluid-particles.ts",
    "packages/core/src/gpu-readback.ts",
    "packages/physics/src/index.ts",
    "packages/playtest/src/runner/runner.ts",
    "pnpm-lock.yaml",
    "examples/prd476-fluid-particles/src/collision-proof.ts",
  ])("preserves shared fluid dependencies: %s", (file) => {
    const lanes = select(workflow, [file]);
    expect(lanes["fluid-native"]).toBe(true);
    expect(lanes["fluid-particles"]).toBe(true);
  });
  it.each(["packages/core/src/renderer.ts", "packages/core/src/render/chain.ts"])(
    "retains focused fluid coverage for shared renderer and observation source: %s",
    (file) => {
      const lanes = select(workflow, [file]);
      expect(lanes["fluid-native"]).toBe(true);
      expect(lanes["fluid-particles"]).toBe(true);
    },
  );
  it("fails closed for an unknown executable harness", () => {
    expect(select(workflow, ["scripts/new-unclassified-runtime.ts"])).toEqual(all);
  });
});

describe("additive registration safety boundaries", () => {
  it("rejects lane removal", () => {
    const after = workflow
      .replace(/^ {6}ik:.*\n/mu, "")
      .replace(/^ {12}ik .*\n/mu, "")
      .replace(/\n {2}ik:\n[\s\S]*?(?=\n {2}[a-z][a-z-]*:\n)/u, "\n");
    const result = select(after);
    expect(Object.values(result).every(Boolean)).toBe(true);
  });
  it("rejects an unparsed aliased job", () => {
    expect(select(`${workflow}\n  unknown: &alias\n    uses: unknown\n`)).toEqual(all);
  });
  it("routes mixed native and browser verifier changes to both", () => {
    const lanes = select(workflow, [
      "packages/runtime-native/src/bindings.cpp",
      "scripts/verify-fluid-consumers.ts",
    ]);
    expect(lanes["fluid-native"]).toBe(true);
    expect(lanes["fluid-particles"]).toBe(true);
  });
  it("keeps generated render helper edits outside browser fluid", () => {
    const lanes = select(workflow, [
      "packages/create-threenative/templates/rain/src/render/worldEnvironment.ts",
      "packages/create-threenative/src/index.ts",
    ]);
    expect(lanes.tone).toBe(true);
    expect(lanes["fluid-particles"]).toBe(false);
  });
});

describe("actual additive exposure registration regression", () => {
  // Exact added output/filter/job bytes from candidate 49f76db85cdc125b4bf1c2336fb37a7f78bb1153.
  // Graft onto the current workflow to retain this proof after the native/browser split.
  const outputs =
    "      exposure: ${{ steps.filter.outputs.exposure }}\n      cold-boot: ${{ steps.filter.outputs.cold-boot }}\n";
  const filters =
    "            cold-boot ^packages/create-threenative/(template-assets|templates/[^/]+/src/render)/(autoExposure|exposure|exposureGraph|exposureReadback|worldEnvironment)\\.ts$|^packages/create-threenative/__tests__/auto-exposure[^/]*\\.spec\\.ts$|^packages/create-threenative/__tests__/fixtures/auto-exposure/.*$|^packages/core/src/.*$|^packages/core/patches/.*$|^packages/playtest/.*$|^packages/runtime-native/.*$|^pnpm-lock\\.yaml$|^scripts/xvfb\\.sh$|^\\.github/actions/(workspace-dist|pnpm|playwright-chromium)/.*$\n            exposure ^packages/create-threenative/(template-assets|templates/[^/]+/src/render)/(autoExposure|exposure|exposureGraph|exposureReadback|worldEnvironment)\\.ts$|^packages/create-threenative/__tests__/auto-exposure[^/]*\\.spec\\.ts$|^packages/create-threenative/__tests__/fixtures/auto-exposure/.*$|^packages/core/src/.*$|^packages/core/patches/.*$|^packages/playtest/.*$|^packages/runtime-native/.*$|^pnpm-lock\\.yaml$|^scripts/xvfb\\.sh$|^\\.github/actions/(workspace-dist|pnpm|playwright-chromium)/.*$\n";
  const jobs =
    "\n  exposure:\n    name: auto-exposure\n    if: ${{ !github.event.pull_request.draft && needs.paths.outputs.exposure == 'true' }}\n    needs: paths\n    runs-on: ${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER) && 'ubuntu-24.04' || vars.TN_RUNNER }}\n    timeout-minutes: 30\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n        with:\n          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha || github.sha }}\n      - uses: ./.github/actions/pnpm\n      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\n        with:\n          node-version: '22'\n          cache: pnpm\n      - run: pnpm install --frozen-lockfile\n      - uses: ./.github/actions/workspace-dist\n        with:\n          pack-archives: 'false'\n          save-bundles: 'false'\n      - uses: ./.github/actions/playwright-chromium\n      - run: pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/auto-exposure.spec.ts packages/create-threenative/__tests__/auto-exposure-node.spec.ts packages/create-threenative/__tests__/auto-exposure-proof.spec.ts packages/create-threenative/__tests__/auto-exposure-mutations.spec.ts packages/create-threenative/__tests__/auto-exposure-clock.spec.ts packages/create-threenative/__tests__/auto-exposure-camera.spec.ts\n      - name: Capture the real exposure graph\n        run: node --import tsx packages/create-threenative/__tests__/fixtures/auto-exposure/verify.ts\n      - uses: actions/upload-artifact@v4\n        if: always()\n        with:\n          name: prd339-exposure-${{ github.sha }}\n          path: artifacts/prd339-exposure\n          if-no-files-found: error\n\n  cold-boot:\n    name: auto-exposure cold boot\n    if: ${{ !github.event.pull_request.draft && needs.paths.outputs.cold-boot == 'true' }}\n    needs: paths\n    runs-on: ${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER) && 'ubuntu-24.04' || vars.TN_RUNNER }}\n    timeout-minutes: 30\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n        with:\n          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha || github.sha }}\n      - uses: ./.github/actions/pnpm\n      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\n        with:\n          node-version: '22'\n          cache: pnpm\n      - run: pnpm install --frozen-lockfile\n      - uses: ./.github/actions/workspace-dist\n        with:\n          pack-archives: 'false'\n          save-bundles: 'false'\n      - uses: ./.github/actions/playwright-chromium\n      - run: pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/auto-exposure.spec.ts packages/create-threenative/__tests__/auto-exposure-node.spec.ts packages/create-threenative/__tests__/auto-exposure-proof.spec.ts packages/create-threenative/__tests__/auto-exposure-mutations.spec.ts packages/create-threenative/__tests__/auto-exposure-clock.spec.ts packages/create-threenative/__tests__/auto-exposure-cold-boot.spec.ts\n      - name: Capture twenty independent exposure cold boots\n        run: node --import tsx packages/create-threenative/__tests__/fixtures/auto-exposure/verifyColdBoot.ts\n      - name: Qualify first-update snap response and zero-gain expected failure\n        run: node --import tsx packages/create-threenative/__tests__/fixtures/auto-exposure/verifySnap.ts\n      - uses: actions/upload-artifact@v4\n        if: always()\n        with:\n          name: prd339-cold-boot-${{ github.sha }}\n          path: |\n            artifacts/prd339-cold-boot\n            artifacts/prd339-snap-response\n";
  const before = workflow
    .replace(/^ {6}(exposure|cold-boot):.*\n/gmu, "")
    .replace(/^ {12}(exposure|cold-boot) .*\n/gmu, "")
    .replace(/\n {2}exposure:\n[\s\S]*$/u, "");
  const selectAdded = (after: string, files = [".github/workflows/integration.yml"]) =>
    integrationSelection({ before, after, files }).lanes;
  const after =
    before
      .replace("    outputs:\n", `    outputs:\n${outputs}`)
      .replace("          TN_LANE_FILTERS: |\n", `          TN_LANE_FILTERS: |\n${filters}`) + jobs;
  it("selects the actual new roots without unrelated lanes", () => {
    expect(selectAdded(after)).toEqual({ ...none, exposure: true, "cold-boot": true });
  });
  it("retains exposure module routing with the registered roots", () => {
    for (const name of [
      "autoExposure",
      "exposureGraph",
      "exposureReadback",
      "exposureSettings",
      "worldEnvironment",
    ]) {
      expect(
        selectAdded(after, [`packages/create-threenative/template-assets/${name}.ts`]).tone,
      ).toBe(true);
    }
  });
});

describe("root gates bind the actual job condition", () => {
  it("rejects a gate mentioned only in a step comment", () => {
    const after = workflow.replace(
      "if: ${{ needs.paths.outputs.csg == 'true' && !github.event.pull_request.draft }}",
      "if: false # needs.paths.outputs.csg == 'true'",
    );
    expect(() => select(after)).toThrow("unknown root gate");
  });
  it("rejects an overriding false condition even with a canonical output reference", () => {
    const after = workflow.replace(
      "if: ${{ needs.paths.outputs.csg == 'true' && !github.event.pull_request.draft }}",
      "if: ${{ false && needs.paths.outputs.csg == 'true' }}",
    );
    expect(() => select(after)).toThrow("unknown root gate");
  });
});

describe("fluid CI observer ownership", () => {
  it.each(["scripts/observe-fluid-ci.mjs", "scripts/__tests__/observe-fluid-ci.spec.ts"])(
    "selects browser fluid for %s without native or unrelated lanes",
    (file) => {
      expect(select(workflow, [file])).toEqual({ ...none, "fluid-particles": true });
    },
  );
});

describe("reviewed producer and independent feature boundaries", () => {
  it.each(["Area", "Footprint", "FootprintMath", "Producer", "Replay", "Selection", "Visibility"])(
    "routes isolated temporalCurrent%s edits to temporal alone",
    (suffix) => {
      const file = `packages/create-threenative/templates/starter/src/render/temporalCurrent${suffix}.ts`;
      expect(select(workflow, [file])).toEqual({ ...none, temporal: true });
      expect(select(workflow, [file.replace(".ts", ".txt")])).toEqual(none);
    },
  );
  it("routes an isolated rejection-counter edit to its temporal evidence lane", () => {
    const file =
      "packages/create-threenative/templates/starter/src/render/temporalRejectionCounter.ts";
    expect(select(workflow, [file])).toEqual({ ...none, temporal: true });
  });
  it("registers temporal and velocity as workspace producer consumers", () => {
    for (const file of ["packages/core/tsup.config.ts", "packages/playtest/package.json"]) {
      const lanes = select(workflow, [file]);
      expect(lanes.temporal, file).toBe(true);
      expect(lanes.velocity, file).toBe(true);
      expect(lanes.csg, file).toBe(false);
      expect(lanes.ik, file).toBe(false);
      expect(lanes.vegetation, file).toBe(false);
    }
  });
  it("keeps independent terrain and animation modules outside temporal and velocity", () => {
    for (const file of [
      "packages/core/src/terrain-jobs-worker.ts",
      "packages/core/src/animation.ts",
    ]) {
      const lanes = select(workflow, [file]);
      expect(lanes.temporal, file).toBe(false);
      expect(lanes.velocity, file).toBe(false);
    }
  });
  it("registers animation as a workspace producer consumer", () => {
    for (const file of ["packages/core/tsup.config.ts", "packages/playtest/package.json"]) {
      const lanes = select(workflow, [file]);
      expect(lanes.animation, file).toBe(true);
      expect(lanes.csg, file).toBe(false);
      expect(lanes.ik, file).toBe(false);
      expect(lanes.vegetation, file).toBe(false);
    }
  });
  it("keeps independent terrain worker modules outside animation", () => {
    for (const file of [
      "packages/core/src/terrain-jobs-worker.ts",
      "packages/core/src/world-tiles.ts",
    ]) {
      expect(select(workflow, [file]).animation, file).toBe(false);
    }
  });
  it("keeps fluid for the shared game loop and core build config", () => {
    for (const file of [
      "packages/core/src/game.ts",
      "packages/core/src/clustered-mesh.ts",
      "packages/core/tsup.config.ts",
      "packages/core/patches/three.patch",
    ]) {
      const lanes = select(workflow, [file]);
      expect(lanes["fluid-particles"], file).toBe(true);
      expect(lanes["fluid-native"], file).toBe(true);
      expect(lanes.csg, file).toBe(false);
      expect(lanes.ik, file).toBe(false);
      expect(lanes.vegetation, file).toBe(false);
    }
  });
  it("does not select fluid for independent terrain or animation modules", () => {
    for (const file of [
      "packages/core/src/terrain-jobs-worker.ts",
      "packages/core/src/terrain-jobs.ts",
      "packages/core/src/world-tiles.ts",
      "packages/core/src/animation.ts",
      "scripts/verify-animation-reversal.ts",
      "scripts/verify-vq-locomotion.ts",
      "scripts/temporal-aa-quality.ts",
    ]) {
      const lanes = select(workflow, [file]);
      expect(lanes["fluid-particles"], file).toBe(false);
      expect(lanes["fluid-native"], file).toBe(false);
    }
  });
  it("still selects fluid when an independent change shares a producer configuration delta", () => {
    const lanes = select(workflow, [
      "packages/core/src/terrain-jobs-worker.ts",
      "packages/core/tsup.config.ts",
    ]);
    expect(lanes["fluid-particles"]).toBe(true);
    expect(lanes["fluid-native"]).toBe(true);
    expect(lanes.csg).toBe(false);
  });
  it("retains unknown executable and scheduling fallback", () => {
    expect(select(workflow, ["scripts/unclassified.ts"])).toEqual(all);
    expect(select(workflow, ["packages/unknown/src/runtime.ts"])).toEqual(all);
  });
});

const dependencyRoot = path.resolve(import.meta.dirname, "../..");
function runtimeSource(filename: string): string {
  const source = filename.replace("/dist/", "/src/");
  const candidates = [
    source.replace(/\.js$/u, ".ts"),
    `${source}.ts`,
    source,
    `${source}/index.ts`,
  ];
  const resolved = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (!resolved) throw new Error(`Unresolved fluid runtime source: ${filename}`);
  return resolved;
}
function moduleEdges(file: string): { module: string; names: string[] }[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const edges: { module: string; names: string[] }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const bindings = node.importClause?.namedBindings;
      const names =
        bindings && ts.isNamedImports(bindings)
          ? bindings.elements
              .filter((entry) => !entry.isTypeOnly)
              .map((entry) => (entry.propertyName ?? entry.name).text)
          : ["*"];
      if (names.length) edges.push({ module: node.moduleSpecifier.text, names });
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      edges.push({ module: node.moduleSpecifier.text, names: ["*"] });
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument))
        throw new Error(`Unresolved runtime import in ${file}`);
      edges.push({ module: argument.text, names: ["*"] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}
function workspaceTargets(module: string, names: string[]): string[] {
  const match = /^@threenative\/([^/]+)(?:\/(.*))?$/u.exec(module);
  if (!match?.[1]) return [];
  const entry = runtimeSource(
    path.join(dependencyRoot, "packages", match[1], "src", match[2] ?? "index.ts"),
  );
  if (names.includes("*")) return [entry];
  // Resolve the public named exports, instead of pretending an unused barrel export is exercised.
  const source = ts.createSourceFile(
    entry,
    readFileSync(entry, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const exports = source.statements
    .filter(ts.isExportDeclaration)
    .filter(
      (node) =>
        !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier),
    );
  const targets = new Set<string>();
  for (const name of names) {
    const exported = exports.find(
      (node) =>
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some(
          (element) => !element.isTypeOnly && element.name.text === name,
        ),
    );
    if (exported?.moduleSpecifier && ts.isStringLiteral(exported.moduleSpecifier))
      targets.add(runtimeSource(path.resolve(path.dirname(entry), exported.moduleSpecifier.text)));
    else targets.add(entry);
  }
  return [...targets];
}
function fluidRuntimeClosure(extra: { module: string; names: string[] }[] = []): Set<string> {
  const pending = [
    "examples/prd476-fluid-particles/src/main.ts",
    "examples/prd476-fluid-particles/src/collision-proof.ts",
    "scripts/verify-fluid-collision.ts",
    "scripts/verify-fluid-consumers.ts",
    "scripts/verify-fluid-collision-native.ts",
  ].map((file) => path.join(dependencyRoot, file));
  pending.push(...extra.flatMap(({ module, names }) => workspaceTargets(module, names)));
  const seen = new Set<string>();
  while (pending.length) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const edge of moduleEdges(file)) {
      if (edge.module.startsWith("."))
        pending.push(runtimeSource(path.resolve(path.dirname(file), edge.module)));
      else pending.push(...workspaceTargets(edge.module, edge.names));
    }
  }
  return seen;
}
it("guards independent modules against the actual fluid fixture/harness runtime graph", () => {
  const seen = fluidRuntimeClosure();
  expect(
    [...seen].filter((file) => INDEPENDENT_PROOFS.test(path.relative(dependencyRoot, file))),
  ).toEqual([]);
  for (const name of INDEPENDENT_PACKAGES)
    expect(
      [...seen].some((file) => file.includes(`/packages/${name}/src/`)),
      name,
    ).toBe(false);
  for (const name of INDEPENDENT_CORE_MODULES)
    expect(seen.has(path.join(dependencyRoot, `packages/core/src/${name}.ts`)), name).toBe(false);
  for (const name of ["clustered-mesh", "renderer", "render/chain", "gpu-readback"])
    expect(seen.has(path.join(dependencyRoot, `packages/core/src/${name}.ts`)), name).toBe(true);
});
it("detects a new fixture dependency through a named public export", () => {
  const seen = fluidRuntimeClosure([{ module: "@threenative/core", names: ["AnimationPlayer"] }]);
  expect(seen.has(path.join(dependencyRoot, "packages/core/src/animation.ts"))).toBe(true);
});
it("rejects an unresolved new workspace-package import instead of accepting an exclusion", () => {
  expect(() =>
    fluidRuntimeClosure([{ module: "@threenative/unclassified", names: ["newDependency"] }]),
  ).toThrow("Unresolved fluid runtime source");
});

it("fails closed when a shared producer reaches a newly added unclassified consumer", () => {
  const added = [
    workflow
      .replace(
        "    outputs:\n",
        "    outputs:\n      new-core: ${{ steps.filter.outputs.new-core }}\n",
      )
      .replace(
        "          TN_LANE_FILTERS: |\n",
        "          TN_LANE_FILTERS: |\n            new-core ^examples/new-core/.*$\n",
      ),
    "\n  new-core:\n    needs: paths\n    if: ${{ needs.paths.outputs.new-core == 'true' && !github.event.pull_request.draft }}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: pnpm build\n",
  ].join("");
  expect(select(added, [".github/workflows/integration.yml"])).toEqual({
    ...none,
    "new-core": true,
  });
  expect(select(added, ["packages/core/tsup.config.ts"])).toEqual({ ...all, "new-core": true });
});

it("keeps the capture verifier's candidate SHA distinct from attempt-qualified artifacts", () => {
  const capture =
    (workflow.split("\n  capture:\n")[1] ?? "").split("\n  fluid-collision:\n")[0] ?? "";
  const candidate = "b".repeat(40);
  const evaluate = (value: string) =>
    value
      .replaceAll("${{ inputs.candidate_sha }}", candidate)
      .replaceAll("${{ github.run_id }}", "123")
      .replaceAll("${{ github.run_attempt }}", "2");
  const expectedSource = capture.match(/EXPECTED_SOURCE_SHA: (.*)/u)?.[1];
  expect(expectedSource).toBeDefined();
  expect(evaluate(expectedSource as string)).toBe(candidate);
  const diagnostic = capture.match(/name: (world-capture-diagnostic-.*)/u)?.[1];
  expect(diagnostic).toBeDefined();
  expect(evaluate(diagnostic as string)).toBe(`world-capture-diagnostic-123-2-${candidate}`);
});

describe("deliberately retired flaky fluid browser gate", () => {
  it("removes the automatic job and join while retaining focused CPU/native coverage and diagnostics", () => {
    const actual = readFileSync(
      new URL("../../.github/workflows/integration.yml", import.meta.url),
      "utf8",
    );
    expect(actual).not.toMatch(/^ {2}fluid-consumers:/mu);
    expect(actual.match(/^ {4}needs: \[paths,.*$/mu)?.[0]).not.toContain("fluid-consumers");
    expect(actual).toContain("packages/core/__tests__/fluid-particles.spec.ts");
    expect(actual).toContain("scripts/verify-fluid-collision.ts");
    expect(actual).toContain("scripts/verify-fluid-collision-native.ts");
    for (const file of ["scripts/observe-fluid-ci.mjs", "scripts/verify-fluid-consumers.ts"]) {
      expect(existsSync(new URL(`../../${file}`, import.meta.url))).toBe(true);
    }
  });
});
