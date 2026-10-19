import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateEventPlan } from "./ci-change-scope.mjs";

export const TEMPLATE_TYPECHECK_STEP = "Typecheck pristine template";
const failure = (reason) => {
  throw new Error(`CI_TEMPLATE_TYPECHECK_${reason}`);
};
export function discoverTypecheckTemplates(root = process.cwd()) {
  const directory = path.join(root, "packages/create-threenative/templates");
  const templates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const script = JSON.parse(readFileSync(path.join(directory, name, "package.json"), "utf8"))
        .scripts?.typecheck;
      return typeof script === "string" && script.trim().length > 0;
    })
    .sort();
  if (!templates.length) failure("EMPTY_INVENTORY");
  return templates;
}
function completeOwnership({ plan: value, candidateSha, eventName, target, templates, workflow }) {
  const plan = validateEventPlan(value, { eventName, baseRef: target });
  if (
    !plan.qualification ||
    plan.selection !== "full" ||
    plan.reusedRunId !== 0 ||
    candidateSha !== plan.candidateSha ||
    !plan.jobs["template-nonvisual"].required ||
    !Array.isArray(templates) ||
    !templates.length ||
    new Set(templates).size !== templates.length ||
    templates.some((name) => !plan.templateMatrix.template.includes(name))
  )
    failure("INCOMPLETE_OWNER");
  const matches = [
    ...workflow.matchAll(/\n {2}template-nonvisual:\n[\s\S]*?(?=\n {2}[a-z0-9-]+:|$)/gu),
  ];
  if (matches.length !== 1) failure("WORKFLOW_OWNER");
  const body = matches[0][0];
  const step = `      - name: ${TEMPLATE_TYPECHECK_STEP}\n        run: |\n          set -euo pipefail\n          target="$RUNNER_TEMP/threenative-\${{ matrix.template }}"\n          pnpm --dir "$target" install\n          pnpm --dir "$target" run typecheck\n`;
  if (
    /^ {4}continue-on-error:/mu.test(body) ||
    !body.includes("    needs: [scope, build-artifacts]\n") ||
    !body.includes(
      "    if: ${{ (needs.scope.outputs.selection == 'full' || needs.scope.outputs.selection == 'template') }}\n",
    ) ||
    !body.includes("      matrix: ${{ fromJSON(needs.scope.outputs.plan).templateMatrix }}\n") ||
    !body.includes("          ref: ${{ needs.scope.outputs.candidate_sha || github.sha }}\n") ||
    body.split(step).length !== 2 ||
    body.match(/ {6}- name: Typecheck pristine template\n[\s\S]*?(?= {6}- |$)/u)?.[0] !== step ||
    body.indexOf(step) > body.indexOf("      - name: Run the template's GPU-free scenarios")
  )
    failure("WORKFLOW_OWNER");
  return plan;
}
// Unknown/local/partial inputs retain the original unit compiler proof, never an exemption.
export function canDelegateTemplateTypechecks(expected) {
  if (
    !["pull_request", "merge_group", "push", "schedule", "workflow_dispatch"].includes(
      expected?.eventName,
    )
  )
    return false;
  try {
    completeOwnership(expected);
    return true;
  } catch {
    return false;
  }
}
export function validateTemplateTypechecks(expected, listing) {
  completeOwnership(expected);
  if (
    !/^[a-f0-9]{40}$/u.test(expected.workflowHeadSha ?? "") ||
    !/^[1-9]\d*$/u.test(expected.runId ?? "") ||
    !/^[1-9]\d*$/u.test(expected.runAttempt ?? "") ||
    !Array.isArray(listing?.jobs) ||
    listing.totalCount !== listing.jobs.length ||
    new Set(listing.jobs.map((job) => job.id)).size !== listing.jobs.length
  )
    failure("API_IDENTITY");
  for (const template of expected.templates) {
    const rows = listing.jobs.filter((job) => job.name === `template-nonvisual (${template})`);
    if (rows.length !== 1) failure(`MATRIX_INVENTORY:${template}`);
    const job = rows[0];
    if (
      job.head_sha !== expected.workflowHeadSha ||
      job.run_id !== Number(expected.runId) ||
      job.run_attempt !== Number(expected.runAttempt) ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    )
      failure(`JOB_NOT_SUCCESS:${template}`);
    const steps = Array.isArray(job.steps)
      ? job.steps.filter((step) => step.name === TEMPLATE_TYPECHECK_STEP)
      : [];
    if (steps.length !== 1 || steps[0].status !== "completed" || steps[0].conclusion !== "success")
      failure(`COMPILER_NOT_SUCCESS:${template}`);
  }
}
