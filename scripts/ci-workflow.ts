import { parse as parseYaml } from "yaml";

/**
 * The `needs:` graph of a GitHub Actions workflow, and the rule PRD-296 exists to keep.
 *
 * PRD-296: three gates were behind a permanently red one, so they were skipped on every run this
 * repository had ever produced and nobody had seen any of them fail. The board looked like nine
 * jobs of coverage and was six. The rule it settled on is that **no job may declare `needs:` on a
 * job whose purpose is coverage rather than artifact production** — `needs: build` is legitimate
 * because the downstream lane consumes what `build` packs; `needs: test` as a cost saving is what
 * created the hole, and the saving was illusory because the job never ran.
 *
 * The classification below is derived from the workflow text rather than kept in a list beside it.
 * A hand-maintained allowlist of legal edges is one more thing to forget to update, and forgetting
 * would restore exactly the invisible arrangement this guards.
 */

/** A job as the guard needs to see it. */
export interface ICiJob {
  readonly name: string;
  readonly needs: readonly string[];
  /** Runs `actions/upload-artifact`, so downstream jobs may legitimately be ordered behind it. */
  readonly producesArtifact: boolean;
  /** The exact `scope` job that decides whether the rest of the workflow is applicable. */
  readonly producesSchedulingDecision: boolean;
  /** Reads `needs.<job>.result` — an aggregator whose whole job is to report an upstream verdict. */
  readonly aggregates: readonly string[];
  /**
   * Reads `toJSON(needs)`, which is every upstream result at once.
   *
   * The run summary is the reason this exists: reporting each job's verdict *is* its work, and it
   * cannot name the jobs it reports on without depending on all of them.
   */
  readonly aggregatesAll: boolean;
}

/** One illegal `needs:` edge, phrased the way the failure should read. */
export interface ICiNeedsFinding {
  readonly job: string;
  readonly dependsOn: string;
  readonly problem: string;
}

function jobsBlock(source: string): string {
  const at = source.indexOf("\njobs:\n");
  if (at < 0) throw new Error("CI_WORKFLOW_NO_JOBS: the workflow declares no `jobs:` mapping");
  return source.slice(at);
}

/** Splits the `jobs:` mapping into `[name, section]` pairs, in file order. */
export function jobSections(source: string): readonly (readonly [string, string])[] {
  const jobs = jobsBlock(source);
  const headings = [...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):\n/gmu)];
  if (headings.length === 0) {
    throw new Error("CI_WORKFLOW_NO_JOBS: the `jobs:` mapping declares no jobs");
  }
  return headings.map((heading, index) => {
    const name = heading[1];
    if (name === undefined) throw new Error("CI_WORKFLOW_NO_JOBS: a job heading has no name");
    return [name, jobs.slice(heading.index, headings[index + 1]?.index ?? jobs.length)] as const;
  });
}

/**
 * The `needs:` a job declares, in either shape Actions accepts: `needs: build` and
 * `needs: [a, b]` inline, or a block sequence underneath.
 *
 * Anchored at exactly four spaces so a `needs:` quoted inside a comment — `ci.yml` has one,
 * explaining why an edge is ordering-only — is not read as an edge.
 */
export function declaredNeeds(section: string): readonly string[] {
  const inline = /^ {4}needs:[ \t]*(.*)$/mu.exec(section);
  if (inline === null) return [];
  const rest = (inline[1] ?? "").trim();
  if (rest.startsWith("[")) {
    return rest
      .slice(1, rest.indexOf("]") < 0 ? undefined : rest.indexOf("]"))
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (rest.length > 0) return [rest];
  // `$` stops before the newline, so the block sequence starts one character further on.
  const block = section.slice((inline.index ?? 0) + inline[0].length).replace(/^\n/u, "");
  const listed: string[] = [];
  for (const line of block.split("\n")) {
    const item = /^ {6}-[ \t]+([A-Za-z0-9_-]+)\s*$/u.exec(line);
    if (item === null) break;
    listed.push(item[1] ?? "");
  }
  return listed;
}

/** Reads the workflow into the shape the rule is stated over. */
export function ciJobGraph(source: string): readonly ICiJob[] {
  return jobSections(source).map(([name, section]) => {
    const outputsDecision =
      name === "scope" &&
      /^ {4}outputs:\n(?:(?: {6}[A-Za-z0-9_-]+:.*)\n?)+/mu.test(section) &&
      /steps\.[A-Za-z0-9_-]+\.outputs\.(?:selection|reason)/u.test(section) &&
      section.includes("scripts/ci-change-scope.mjs");
    return {
      aggregates: [...section.matchAll(/needs\.([A-Za-z0-9_-]+)\.result/gu)].map(
        (match) => match[1] ?? "",
      ),
      aggregatesAll: /toJSON\(\s*needs\s*\)/u.test(section),
      name,
      needs: declaredNeeds(section),
      producesArtifact: section.includes("actions/upload-artifact"),
      producesSchedulingDecision: outputsDecision,
    };
  });
}

function legalNeed(job: ICiJob, upstream: ICiJob): boolean {
  return (
    upstream.producesArtifact ||
    upstream.producesSchedulingDecision ||
    job.aggregatesAll ||
    job.aggregates.includes(upstream.name)
  );
}

/**
 * Every edge that would hide a gate behind another gate.
 *
 * An edge `job -> dependsOn` is legal when `dependsOn` produces an artifact, or when `job` reads
 * that verdict — `needs.<dependsOn>.result`, or `toJSON(needs)` for a job that reports all of
 * them. An aggregator exists precisely to publish an upstream result and cannot do its work
 * without the edge. Everything else is a coverage job ordered behind another coverage job, which
 * is the arrangement that concealed three broken gates for as long as they existed.
 *
 * Fail-closed: an edge naming a job the workflow does not declare is a finding, not a skip.
 */
export function ciNeedsFindings(jobs: readonly ICiJob[]): readonly ICiNeedsFinding[] {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const findings: ICiNeedsFinding[] = [];
  for (const job of jobs) {
    for (const dependsOn of job.needs) {
      const upstream = byName.get(dependsOn);
      if (upstream === undefined) {
        findings.push({
          dependsOn,
          job: job.name,
          problem: `${job.name} declares needs: ${dependsOn}, which this workflow does not declare`,
        });
        continue;
      }
      if (legalNeed(job, upstream)) continue;
      findings.push({
        dependsOn,
        job: job.name,
        problem: `${job.name} declares needs: ${dependsOn}, and ${dependsOn} produces no artifact and is not aggregated by ${job.name} — a gate behind a gate is skipped on every run the upstream is red, which is indistinguishable from passing`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// PRD-839. The workflow as a model: job -> `if`, `needs`, `runs-on`, `permissions`, steps, `with`
// and `env`, read from the parsed YAML instead of matched in its text. A field the workflow does
// not declare is `undefined` on the property and a throw on `require`, so a spec that asks for a
// field the job lost fails by name instead of passing on an empty string. Comments do not survive
// the parse, which is the point: a rule quoted in a comment is not a rule the workflow keeps.
// ---------------------------------------------------------------------------------------------

type Mapping = Readonly<Record<string, unknown>>;

/** One step of a job. `run` is the block scalar after YAML de-indents it: the script as the shell sees it. */
export interface ICiStep {
  readonly env: Readonly<Record<string, string>>;
  readonly id: string | undefined;
  readonly if: string | undefined;
  readonly index: number;
  readonly name: string | undefined;
  readonly run: string | undefined;
  readonly uses: string | undefined;
  readonly with: Mapping;
  readonly workingDirectory: string | undefined;
  /** The field or a throw naming the step. */
  require(key: string): unknown;
}

/** One job of a workflow, in the shape the structure specs state their rules over. */
export interface ICiWorkflowJob {
  readonly displayName: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly id: string;
  /** The `if:` expression with its `${{ }}` wrapper and line breaks removed, or `undefined`. */
  readonly if: string | undefined;
  readonly needs: readonly string[];
  readonly outputs: Readonly<Record<string, string>>;
  readonly permissions: Readonly<Record<string, string>> | undefined;
  /** `runs-on:` as one expression, or JSON for a mapping. */
  readonly runsOn: string | undefined;
  /** Every `run:` body in step order, joined by a blank line: the commands this job can execute. */
  readonly scripts: string;
  readonly steps: readonly ICiStep[];
  readonly strategy: Mapping | undefined;
  /** The job's own text, comments included, for the few rules whose subject is byte order. */
  readonly text: string;
  /** A number, or the expression when the bound is computed (a matrix leg). */
  readonly timeoutMinutes: number | string | undefined;
  /** A reusable-workflow call (`uses:` on the job itself). */
  readonly uses: string | undefined;
  readonly with: Mapping;
  /**
   * True when the string or pattern appears anywhere in the job's parsed values. Comments are not
   * values, so a rule quoted in a comment does not count. Prefer a field when one fits.
   */
  mentions(match: string | RegExp): boolean;
  /** The field or a throw naming the job. */
  require(key: string): unknown;
  /** True when some `run:` body contains the string or matches the pattern. */
  runs(match: string | RegExp): boolean;
  /** The one step named exactly `name`, or a match for a pattern. Zero or several throw. */
  step(match: string | RegExp): ICiStep;
  /** The step with this `id:`. Zero or several throw. */
  stepById(id: string): ICiStep;
  /** Steps whose `uses:` starts with `prefix`, in order. */
  stepsUsing(prefix: string): readonly ICiStep[];
}

export interface ICiWorkflow {
  readonly concurrency: Mapping | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly jobs: readonly ICiWorkflowJob[];
  readonly name: string | undefined;
  /** `on:` as declared: event name -> its configuration (`null` for a bare event). */
  readonly on: Mapping;
  readonly permissions: Readonly<Record<string, string>> | undefined;
  /** The job `id`, or a throw. */
  job(id: string): ICiWorkflowJob;
}

function mapping(value: unknown, where: string): Mapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`CI_WORKFLOW_SHAPE: ${where} is not a mapping`);
  }
  return value as Mapping;
}

function optionalMapping(value: unknown, where: string): Mapping | undefined {
  return value === undefined || value === null ? undefined : mapping(value, where);
}

function text(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") throw new Error(`CI_WORKFLOW_SHAPE: ${where} is not a scalar`);
  return String(value);
}

/** An expression as the runner reads it: the `${{ }}` wrapper and line breaks are layout. */
export function ciExpression(value: string): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  const wrapped = /^\$\{\{ (.*) \}\}$/u.exec(flat);
  return wrapped === null ? flat : (wrapped[1] ?? flat);
}

function balanced(source: string): boolean {
  let depth = 0;
  for (const char of source) {
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The terms of an expression: what is left of it once `&&` and `||` are removed and each
 * parenthesis that wraps a whole term is peeled. `a && (b || c)` reads `a`, `b`, `c`.
 */
export function ciTerms(expression: string): readonly string[] {
  const terms: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let at = 0; at <= expression.length; at += 1) {
    const char = expression[at] ?? "";
    if (quote !== "") {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    const pair = expression.slice(at, at + 2);
    if (at === expression.length || (depth <= 0 && (pair === "&&" || pair === "||"))) {
      const term = expression.slice(start, at).trim();
      if (term !== "") terms.push(term);
      start = at + 2;
      at += 1;
    }
  }
  return terms.flatMap((term) => {
    let peeled = term;
    while (peeled.startsWith("(") && peeled.endsWith(")") && balanced(peeled.slice(1, -1))) {
      peeled = peeled.slice(1, -1).trim();
    }
    return peeled === term ? [term] : ciTerms(peeled);
  });
}

function stringMap(value: unknown, where: string): Readonly<Record<string, string>> {
  const source = optionalMapping(value, where) ?? {};
  return Object.fromEntries(
    Object.entries(source).map(([key, entry]) => [key, text(entry, `${where}.${key}`) ?? ""]),
  );
}

function requireField(owner: Mapping, key: string, where: string): unknown {
  if (!(key in owner)) throw new Error(`CI_WORKFLOW_MISSING_FIELD: ${where} declares no '${key}'`);
  return owner[key];
}

function readStep(raw: unknown, index: number, jobId: string): ICiStep {
  const where = `job '${jobId}' step ${String(index)}`;
  const node = mapping(raw, where);
  const run = text(node.run, `${where}.run`);
  const uses = text(node.uses, `${where}.uses`);
  if (run === undefined && uses === undefined) {
    throw new Error(`CI_WORKFLOW_SHAPE: ${where} has neither 'run' nor 'uses'`);
  }
  const ifExpression = text(node.if, `${where}.if`);
  return {
    env: stringMap(node.env, `${where}.env`),
    id: text(node.id, `${where}.id`),
    if: ifExpression === undefined ? undefined : ciExpression(ifExpression),
    index,
    name: text(node.name, `${where}.name`),
    require: (key) => requireField(node, key, where),
    run,
    uses,
    with: optionalMapping(node.with, `${where}.with`) ?? {},
    workingDirectory: text(node["working-directory"], `${where}.working-directory`),
  };
}

function needsOf(raw: unknown, where: string): readonly string[] {
  if (raw === undefined) return [];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) return raw;
  throw new Error(`CI_WORKFLOW_SHAPE: ${where}.needs is neither a name nor a list of names`);
}

function permissionsOf(raw: unknown, where: string): Readonly<Record<string, string>> | undefined {
  if (typeof raw === "string") return { all: raw };
  return raw === undefined ? undefined : stringMap(raw, where);
}

function oneStep(found: readonly ICiStep[], where: string, what: string): ICiStep {
  if (found.length !== 1) {
    throw new Error(
      `CI_WORKFLOW_STEP: ${where} has ${String(found.length)} steps ${what}, expected one`,
    );
  }
  return found[0] as ICiStep;
}

function readJob(id: string, raw: unknown, sectionText: string): ICiWorkflowJob {
  const where = `job '${id}'`;
  const node = mapping(raw, where);
  const reusable = text(node.uses, `${where}.uses`);
  if (node.steps === undefined && reusable === undefined) {
    throw new Error(`CI_WORKFLOW_SHAPE: ${where} declares neither 'steps' nor a reusable 'uses'`);
  }
  if (node.steps !== undefined && !Array.isArray(node.steps)) {
    throw new Error(`CI_WORKFLOW_SHAPE: ${where}.steps is not a list`);
  }
  const steps = ((node.steps ?? []) as unknown[]).map((entry, index) => readStep(entry, index, id));
  const ifExpression = text(node.if, `${where}.if`);
  const runsOn = node["runs-on"];
  const timeout = node["timeout-minutes"];
  const holds = (match: string | RegExp, haystack: string) =>
    typeof match === "string" ? haystack.includes(match) : match.test(haystack);
  return {
    displayName: text(node.name, `${where}.name`),
    env: stringMap(node.env, `${where}.env`),
    id,
    if: ifExpression === undefined ? undefined : ciExpression(ifExpression),
    mentions: (match) => holds(match, JSON.stringify(node)),
    needs: needsOf(node.needs, where),
    outputs: stringMap(node.outputs, `${where}.outputs`),
    permissions: permissionsOf(node.permissions, `${where}.permissions`),
    require: (key) => requireField(node, key, where),
    runs: (match) => steps.some((step) => step.run !== undefined && holds(match, step.run)),
    runsOn:
      runsOn === undefined
        ? undefined
        : typeof runsOn === "string"
          ? ciExpression(runsOn)
          : JSON.stringify(runsOn),
    scripts: steps
      .map((step) => step.run)
      .filter((run): run is string => run !== undefined)
      .join("\n\n"),
    step: (match) =>
      oneStep(
        steps.filter((step) =>
          typeof match === "string"
            ? step.name === match
            : step.name !== undefined && match.test(step.name),
        ),
        where,
        `matching ${String(match)}`,
      ),
    stepById: (stepId) =>
      oneStep(
        steps.filter((step) => step.id === stepId),
        where,
        `with id '${stepId}'`,
      ),
    steps,
    stepsUsing: (prefix) => steps.filter((step) => step.uses?.startsWith(prefix) === true),
    strategy: optionalMapping(node.strategy, `${where}.strategy`),
    text: sectionText,
    timeoutMinutes:
      timeout === undefined
        ? undefined
        : typeof timeout === "number"
          ? timeout
          : ciExpression(String(timeout)),
    uses: reusable,
    with: optionalMapping(node.with, `${where}.with`) ?? {},
  };
}

/** Parses a workflow into the model. Anything the model cannot read throws; nothing is skipped. */
export function parseWorkflow(source: string): ICiWorkflow {
  const root = mapping(parseYaml(source), "the workflow");
  const jobsNode = mapping(requireField(root, "jobs", "the workflow"), "the workflow's jobs");
  const sections = new Map(jobSections(source));
  const jobs = Object.entries(jobsNode).map(([id, raw]) =>
    readJob(id, raw, sections.get(id) ?? ""),
  );
  if (jobs.length === 0)
    throw new Error("CI_WORKFLOW_NO_JOBS: the `jobs:` mapping declares no jobs");
  return {
    concurrency: optionalMapping(root.concurrency, "the workflow's concurrency"),
    env: stringMap(root.env, "the workflow's env"),
    job(id) {
      const found = jobs.find((job) => job.id === id);
      if (found === undefined) {
        throw new Error(`CI_WORKFLOW_NO_JOB: the workflow declares no job '${id}'`);
      }
      return found;
    },
    jobs,
    name: text(root.name, "the workflow's name"),
    on: optionalMapping(requireField(root, "on", "the workflow"), "the workflow's triggers") ?? {},
    permissions: permissionsOf(root.permissions, "the workflow's permissions"),
  };
}
