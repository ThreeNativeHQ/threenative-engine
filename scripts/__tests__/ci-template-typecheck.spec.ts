import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const { canDelegateTemplateTypechecks, validateTemplateTypechecks } = await import(
  new URL("../ci-template-typecheck.mjs", import.meta.url).href
);
const { selectionPlan, TEMPLATE_NAMES } = await import(
  new URL("../ci-change-scope.mjs", import.meta.url).href
);
const candidate = "a".repeat(40);
const source = "b".repeat(40);
const plan = selectionPlan("full", "test", [], candidate, true, 0, "develop", true);
const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const expected = {
  plan,
  candidateSha: candidate,
  workflowHeadSha: source,
  eventName: "merge_group",
  target: "develop",
  templates: TEMPLATE_NAMES,
  workflow,
  runId: "123",
  runAttempt: "2",
};
const jobs = TEMPLATE_NAMES.map((template: string, i: number) => ({
  id: 500 + i,
  name: `template-nonvisual (${template})`,
  head_sha: source,
  run_id: 123,
  run_attempt: 2,
  status: "completed",
  conclusion: "success",
  steps: [{ name: "Typecheck pristine template", status: "completed", conclusion: "success" }],
}));
const listing = { totalCount: jobs.length, jobs };
describe("pristine template compiler ownership", () => {
  it("delegates only exact complete required coverage and independently joins actual successful compiler steps", () => {
    expect(canDelegateTemplateTypechecks(expected)).toBe(true);
    expect(validateTemplateTypechecks(expected, listing)).toBeUndefined();
  });
  it.each([
    { candidateSha: source },
    ...[
      "continue-on-error: true",
      "if: false",
      "shell: echo {0}",
      "env: {}",
      "working-directory: /tmp",
    ].map((field) => ({
      workflow: workflow.replace(
        '          pnpm --dir "$target" run typecheck\n',
        `          pnpm --dir "$target" run typecheck\n        ${field}\n`,
      ),
    })),
    { templates: [...TEMPLATE_NAMES, "new-template"] },
    { eventName: "unknown" },
    { plan: null },
    { plan: { ...plan, qualification: false } },
    { plan: { ...plan, templateMatrix: { template: ["starter"] } } },
    {
      workflow: workflow.replace(
        "      - name: Typecheck pristine template\n",
        "      - name: Typecheck pristine template\n        if: false\n",
      ),
    },
    {
      workflow: workflow.replace(
        "  template-nonvisual:\n",
        "  template-nonvisual:\n    continue-on-error: true\n",
      ),
    },
    {
      workflow: workflow.replace(
        '          pnpm --dir "$target" run typecheck',
        "          echo skipped compiler",
      ),
    },
  ])("keeps the original unit proof for unsupported/incomplete ownership %j", (change) => {
    expect(canDelegateTemplateTypechecks({ ...expected, ...change })).toBe(false);
  });
  it.each(["failure", "cancelled", "skipped", null])(
    "rejects an actual matrix job concluding %s",
    (conclusion) => {
      expect(() =>
        validateTemplateTypechecks(expected, {
          totalCount: jobs.length,
          jobs: [{ ...jobs[0], conclusion }, ...jobs.slice(1)],
        }),
      ).toThrow("CI_TEMPLATE_TYPECHECK");
    },
  );
  it.each([
    { steps: [] },
    {
      steps: [{ name: "Typecheck pristine template", status: "completed", conclusion: "skipped" }],
    },
    {
      steps: [{ name: "Typecheck pristine template", status: "completed", conclusion: "failure" }],
    },
  ])("rejects absent or unsuccessful compiler steps %j", ({ steps }) => {
    expect(() =>
      validateTemplateTypechecks(expected, {
        totalCount: jobs.length,
        jobs: [{ ...jobs[0], steps }, ...jobs.slice(1)],
      }),
    ).toThrow("CI_TEMPLATE_TYPECHECK");
  });
  it("rejects missing/new-template inventory, wrong SHA, stale attempts and duplicate rows", () => {
    for (const row of [
      { ...jobs[0], head_sha: candidate },
      { ...jobs[0], run_attempt: 1 },
      { ...jobs[0], run_id: 124 },
    ])
      expect(() =>
        validateTemplateTypechecks(expected, {
          totalCount: jobs.length,
          jobs: [row, ...jobs.slice(1)],
        }),
      ).toThrow("CI_TEMPLATE_TYPECHECK");
    expect(() =>
      validateTemplateTypechecks(expected, { totalCount: jobs.length - 1, jobs: jobs.slice(1) }),
    ).toThrow("CI_TEMPLATE_TYPECHECK");
    expect(() =>
      validateTemplateTypechecks(expected, {
        totalCount: jobs.length + 1,
        jobs: [...jobs, jobs[0]],
      }),
    ).toThrow("CI_TEMPLATE_TYPECHECK");
  });
});
