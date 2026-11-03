/**
 * The Android V8 payload crosses refs through two stores, and only one of them is trusted.
 *
 * The `ci-v8-android` release asset is written by `publish-android-v8` on main and develop alone. A
 * workflow artifact is the only store with no ref scope — the one a pull request can read a payload
 * from — and any run can write one, a fork's pull request run included. So the reader filters what
 * it trusts, the publisher refuses anything it did not build, and neither path may fail the lane
 * into a mystery: a payload that cannot be read, downloaded or verified is a cold build.
 *
 * These tests read the workflow and the action as data (steps in file order, keys parsed at their
 * own indentation) and run the two scripts the review called out for real, with a stubbed `gh` and
 * a runtime root whose payload check passes or fails on purpose.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { declaredNeeds, jobSections } from "../ci-workflow.js";
// The scheduler module ships no declarations; the spec reads one export from it (see ci-native-chain).
const { validateNativeWorkflow } = await import(
  new URL("../ci-native-qualification.mjs", import.meta.url).href
);

const repo = join(import.meta.dirname, "..", "..");
const actionSource = readFileSync(
  join(repo, ".github/actions/android-v8-source/action.yml"),
  "utf8",
);
const nativeSource = readFileSync(join(repo, ".github/workflows/native-platforms.yml"), "utf8");
const pickerScript = join(repo, "packages/runtime-native/scripts/v8-artifact-pick.mjs");

interface IStep {
  readonly name: string;
  readonly id: string;
  readonly if: string;
  readonly uses: string;
  readonly run: string;
  readonly env: Readonly<Record<string, string>>;
}

/** One YAML block's keys, each with its own line and the lines underneath it. */
function keysOf(block: readonly string[], indent: number): Map<string, readonly string[]> {
  const keys = new Map<string, readonly string[]>();
  const key = new RegExp(`^ {${indent}}([A-Za-z_-]+): ?(.*)$`, "u");
  let current: string[] | undefined;
  for (const line of block) {
    const match = key.exec(line);
    if (match === null) {
      current?.push(line);
      continue;
    }
    current = [match[2] ?? ""];
    keys.set(match[1] ?? "", current);
  }
  return keys;
}

/** A key's value: a scalar, or the `|`/`>` block underneath it, dedented by its own body indent. */
function textOf(entry: readonly string[] | undefined, bodyIndent: number): string {
  if (entry === undefined) return "";
  const [header = "", ...rest] = entry;
  const kind = /^([|>])[+-]?$/u.exec(header.trim())?.[1];
  if (kind === undefined) return header.trim();
  // A block scalar ends at the first non-blank line shallower than its body: the next key, or the
  // comment that introduces the next step.
  const end = rest.findIndex(
    (line) => line.trim() !== "" && !line.startsWith(" ".repeat(bodyIndent)),
  );
  const body = (end < 0 ? rest : rest.slice(0, end)).map((line) =>
    line.replace(new RegExp(`^ {0,${bodyIndent}}`, "u"), ""),
  );
  return kind === "|" ? body.join("\n").trim() : body.join(" ").replace(/\s+/gu, " ").trim();
}

function stepsOf(source: string): readonly IStep[] {
  const at = /^ {2}steps:$/mu.exec(source)?.index;
  if (at === undefined) throw new Error("the action declares no `steps:` mapping");
  const lines = source.slice(at).split("\n");
  const indent = lines.find((line) => /^ *- /u.test(line))?.match(/^( *)- /u)?.[1]?.length;
  if (indent === undefined) throw new Error("the action declares no steps");
  const starts = lines.flatMap((line, index) =>
    /^ *- /u.test(line) && line.match(/^( *)- /u)?.[1]?.length === indent ? [index] : [],
  );
  return starts.map((start, position) => {
    const [first = "", ...rest] = lines.slice(start, starts[position + 1] ?? lines.length);
    // The `- ` marker sits where the step's own keys sit, so its first line reads as a key too.
    const keys = keysOf(
      [`${" ".repeat(indent + 2)}${first.slice(indent + 2)}`, ...rest],
      indent + 2,
    );
    const env = keysOf(keys.get("env")?.slice(1) ?? [], indent + 4);
    return {
      name: textOf(keys.get("name"), indent + 4),
      id: textOf(keys.get("id"), indent + 4),
      if: textOf(keys.get("if"), indent + 4),
      uses: textOf(keys.get("uses"), indent + 4),
      run: textOf(keys.get("run"), indent + 4),
      env: Object.fromEntries([...env].map(([name, entry]) => [name, textOf(entry, indent + 6)])),
    };
  });
}

const steps = stepsOf(actionSource);

function step(name: string): IStep {
  const found = steps.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the action declares no step named ${name}`);
  return found;
}

function jobSection(source: string, name: string): string {
  const section = jobSections(source).find(([job]) => job === name)?.[1];
  if (section === undefined) throw new Error(`the workflow declares no job named ${name}`);
  return section;
}

/** A job's `if:` — inline or folded — with its whitespace normalized. */
function jobCondition(source: string, name: string): string {
  const gate = /^ {4}if: ([^\n]+)((?:\n {6}[^\n]+)*)/mu.exec(jobSection(source, name));
  if (gate === null) throw new Error(`job ${name} declares no if:`);
  return (gate[1] === ">-" ? (gate[2] ?? "") : (gate[1] ?? "")).replace(/\s+/gu, " ").trim();
}

/** A job's `outputs:` mapping, key to value. */
function jobOutputs(source: string, name: string): Record<string, string> {
  const block = /^ {4}outputs:\n((?: {6}[^\n]+\n)+)/mu.exec(jobSection(source, name))?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/^ {6}([a-z-]+): (.+)$/gmu)].map((match) => [match[1], match[2]?.trim()]),
  );
}

/** The action's `outputs:` mapping, one value per output with its folded block joined. */
function actionOutput(name: string): string {
  const block = /^outputs:\n([\s\S]*?)^runs:/mu.exec(actionSource)?.[1];
  if (block === undefined) throw new Error("the action declares no outputs");
  const lines = block.split("\n");
  const at = lines.indexOf(`  ${name}:`);
  if (at < 0) throw new Error(`the action declares no ${name} output`);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    // The next output key at the mapping's own indentation ends this one.
    if (/^ {2}\S/u.test(line)) break;
    body.push(line);
  }
  const value = / {4}value: ([\s\S]*)$/u.exec(body.join("\n"))?.[1] ?? "";
  return value
    .replace(/^>-?\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The subset of the GitHub expression language these gates use: string comparisons over `==` and
 * `!=`, joined by `&&`, `||` and parentheses. It refuses anything else rather than guessing, so a
 * gate rewritten into a form this spec cannot read fails the spec instead of passing quietly.
 */
function evaluate(expression: string, operands: Readonly<Record<string, string>>): boolean {
  // `if:` accepts a bare expression; an output value wraps it in `${{ }}`.
  const trimmed = expression.trim();
  const body = /^\$\{\{([\s\S]*)\}\}$/u.exec(trimmed)?.[1] ?? trimmed;
  if (body === "") throw new Error("the spec evaluated an empty expression");
  const tokens = body.match(/[A-Za-z_][\w.-]*|'[^']*'|==|!=|&&|\|\||\(|\)/gu) ?? [];
  const unknown = body.replace(/[A-Za-z_][\w.-]*|'[^']*'|==|!=|&&|\|\||\(|\)|\s/gu, "");
  if (unknown !== "") throw new Error(`unsupported expression syntax: ${unknown}`);
  let at = 0;
  const atom = (): boolean => {
    if (tokens[at] === "(") {
      at += 1;
      const grouped = alts();
      if (tokens[at] !== ")") throw new Error(`unbalanced expression: ${expression}`);
      at += 1;
      return grouped;
    }
    const left = operand();
    const operator = tokens[at];
    if (operator !== "==" && operator !== "!=") throw new Error(`expected a comparison: ${body}`);
    at += 1;
    return operator === "==" ? left === operand() : left !== operand();
  };
  const operand = (): string => {
    const token = tokens[at] ?? "";
    if (token.startsWith("'")) {
      at += 1;
      return token.slice(1, -1);
    }
    const value = operands[token];
    if (value === undefined) throw new Error(`this spec has no value for ${token}`);
    at += 1;
    return value;
  };
  const conjunctions = (): boolean => {
    let result = atom();
    while (tokens[at] === "&&") {
      at += 1;
      const next = atom();
      result = result && next;
    }
    return result;
  };
  const alts = (): boolean => {
    let result = conjunctions();
    while (tokens[at] === "||") {
      at += 1;
      const next = conjunctions();
      result = result || next;
    }
    return result;
  };
  const answer = alts();
  if (at !== tokens.length) throw new Error(`trailing expression tokens: ${tokens.slice(at)}`);
  return answer;
}

/** Replaces the GitHub expressions a script carries, and refuses to run one it does not know. */
function resolve(script: string, values: Readonly<Record<string, string>>, where: string): string {
  const resolved = script.replace(
    /\$\{\{\s*([^}]+?)\s*\}\}/gu,
    (match, name: string) => values[name.trim()] ?? match,
  );
  const left = /\$\{\{\s*([^}]+?)\s*\}\}/u.exec(resolved)?.[1];
  if (left !== undefined)
    throw new Error(`${where} carries an expression this spec cannot resolve: ${left}`);
  return resolved;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function tempRoot(prefix = "tn-v8-bridge-"): string {
  const root = makeTempDirSync(prefix);
  roots.push(root);
  return root;
}

function stub(root: string, name: string, body: string, calls: string): void {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, name),
    `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${calls}"\n${body}\n`,
  );
  chmodSync(join(bin, name), 0o755);
}

/** Runs a step's script the way Actions does: `bash -eo pipefail`, with `$GITHUB_OUTPUT` set. */
function runScript(
  script: string,
  options: {
    readonly root: string;
    readonly env: Readonly<Record<string, string>>;
    readonly output: string;
  },
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      ...options.env,
      GITHUB_OUTPUT: options.output,
      // Set by Actions for every step; the scripts read it rather than an input.
      GITHUB_REPOSITORY: "ThreeNativeHQ/threenative",
      PATH: `${join(options.root, "bin")}:${process.env.PATH ?? ""}`,
    },
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the V8 recipe hash step", () => {
  const recipeStep = () => step("Compute the pinned V8 recipe hash");

  it("fails when the hash script fails instead of writing an empty name", () => {
    const root = tempRoot();
    const calls = join(root, "calls.log");
    writeFileSync(calls, "");
    // The failure the old `echo "hash=$(node …)"` swallowed: a node that exits non-zero.
    stub(root, "node", "echo boom >&2\nexit 3", calls);
    const output = join(root, "output.txt");
    writeFileSync(output, "");
    const script = resolve(
      recipeStep().run,
      { "inputs.runtime-root": "packages/runtime-native" },
      "the recipe hash step",
    );

    const failed = runScript(script, { root, env: {}, output });
    expect(failed.status, failed.stderr).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe("");
  });

  it("writes the hash it read, and fails when the script printed nothing", () => {
    const root = tempRoot();
    const calls = join(root, "calls.log");
    writeFileSync(calls, "");
    stub(root, "node", '[ -z "${TN_TEST_EMPTY:-}" ] || exit 0\nprintf "abc123\\n"', calls);
    const script = resolve(
      recipeStep().run,
      { "inputs.runtime-root": "packages/runtime-native" },
      "the recipe hash step",
    );

    const output = join(root, "output.txt");
    writeFileSync(output, "");
    const ok = runScript(script, { root, env: {}, output });
    expect(ok.status, ok.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("hash=abc123\n");

    // A silent success is the same defect as a failure: the asset name would be empty.
    writeFileSync(output, "");
    const empty = runScript(script, { root, env: { TN_TEST_EMPTY: "1" }, output });
    expect(empty.status, empty.stderr).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe("");
  });
});

describe("the Android V8 payload bridge", () => {
  it("runs the payload steps in the order the trust rules assume", () => {
    expect(steps.map((candidate) => candidate.name)).toEqual([
      "Compute the pinned V8 recipe hash",
      "Download the published Android V8 payload",
      "Download the payload a pull request run of this recipe published",
      "Restore the pinned Android V8 payload",
      "Restore the resumable V8 source state",
      "Build the pinned Android V8 payload",
      "Verify the complete Android V8 payload",
      "Save the prebuilt Android V8 payload",
      "Publish the payload to every ref that shares this recipe",
      "Save resumable V8 source state",
    ]);
  });

  it("publishes a release asset only from a payload this run built or restored from a trusted ref", () => {
    const outputs = /^outputs:\n([\s\S]*?)^runs:/mu.exec(actionSource)?.[1] ?? "";
    // The composite action exports `built`, wired to the step that compiles the payload.
    expect(
      /^ {2}built:\n {4}description: [\s\S]*?\n {4}value: (.+)$/mu.exec(outputs)?.[1]?.trim(),
    ).toBe("${{ steps.build.outputs.built }}");
    // Only the build step sets it, and only after the build command, so a payload restored from the
    // release asset, the artifact or the cache never claims to have been built here.
    const build = step("Build the pinned Android V8 payload");
    expect(build.run.split("\n").at(-1)).toBe('echo "built=true" >> "$GITHUB_OUTPUT"');
    expect(steps.filter((candidate) => candidate.run.includes("built=true"))).toEqual([build]);

    // `trusted` is what a release write may consume. The cases the review named, evaluated against
    // the shipped expression rather than a copy of it in prose.
    const rule = actionOutput("trusted");
    const cases = [
      {
        built: "true",
        artifact: "",
        cache: "",
        event: "push",
        ref: "refs/heads/develop",
        trust: true,
      },
      {
        built: "true",
        artifact: "",
        cache: "",
        event: "push",
        ref: "refs/heads/main",
        trust: true,
      },
      {
        built: "",
        artifact: "",
        cache: "true",
        event: "push",
        ref: "refs/heads/develop",
        trust: true,
      },
      {
        built: "",
        artifact: "",
        cache: "true",
        event: "pull_request",
        ref: "refs/pull/628/merge",
        trust: false,
      },
      {
        built: "",
        artifact: "true",
        cache: "",
        event: "push",
        ref: "refs/heads/develop",
        trust: false,
      },
    ] as const;
    for (const testCase of cases) {
      const operands = {
        "steps.build.outputs.built": testCase.built,
        "steps.artifact.outputs.hit": testCase.artifact,
        "steps.payload.outputs.cache-hit": testCase.cache,
        "github.event_name": testCase.event,
        "github.ref": testCase.ref,
      };
      const trusted = evaluate(rule, operands);
      const label = `${testCase.event} on ${testCase.ref}: built=${testCase.built} artifact=${testCase.artifact} cache=${testCase.cache}`;
      expect(trusted, label).toBe(testCase.trust);
      // The release write consumes the output, so the same case must reach the same answer there.
      expect(
        evaluate(jobCondition(nativeSource, "publish-android-v8"), {
          ...operands,
          "needs.android-v8-source.outputs.trusted": trusted ? "true" : "",
        }),
        label,
      ).toBe(testCase.trust);
    }

    // The job re-exports both facts, and the release write requires `trusted`.
    expect(jobOutputs(nativeSource, "android-v8-source").built).toBe(
      "${{ steps.v8.outputs.built }}",
    );
    expect(jobOutputs(nativeSource, "android-v8-source").trusted).toBe(
      "${{ steps.v8.outputs.trusted }}",
    );
    expect(declaredNeeds(jobSection(nativeSource, "publish-android-v8"))).toEqual([
      "scope",
      "android-v8-source",
    ]);
    expect(jobCondition(nativeSource, "publish-android-v8")).toBe(
      "needs.android-v8-source.outputs.trusted == 'true' && github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop')",
    );
  });

  it("leaves the release asset alone when one is already published", () => {
    // The published-asset skip: a run that downloaded the asset neither built nor restored the
    // payload, so it has nothing to trust and never re-publishes what already exists.
    const operands = {
      "steps.build.outputs.built": "",
      "steps.artifact.outputs.hit": "",
      "steps.payload.outputs.cache-hit": "",
      "steps.published.outputs.hit": "true",
      "github.event_name": "push",
      "github.ref": "refs/heads/develop",
    };
    expect(evaluate(actionOutput("trusted"), operands)).toBe(false);
    expect(
      evaluate(jobCondition(nativeSource, "publish-android-v8"), {
        ...operands,
        "needs.android-v8-source.outputs.trusted": "",
      }),
    ).toBe(false);
  });

  it("pins the same publish gate in the scheduler that validates the workflow", () => {
    // `ci-native-qualification.mjs` holds a copy of every job's `if:`; a gate that changed in one
    // place only is a scheduler that disagrees with the workflow it dispatches.
    expect(() => validateNativeWorkflow(nativeSource)).not.toThrow();
    // Negative control: the gate this change replaced let a develop cache hit publish nothing.
    expect(() =>
      validateNativeWorkflow(
        nativeSource.replace(
          "needs.android-v8-source.outputs.trusted == 'true'",
          "needs.android-v8-source.outputs.built == 'true'",
        ),
      ),
    ).toThrow("CI_NATIVE_WORKFLOW_POLICY");
  });

  it("reads another run's artifact only on a pull request, from this repository, on a trusted branch", () => {
    const artifact = step("Download the payload a pull request run of this recipe published");
    // A trusted ref keeps the release asset and never consumes an artifact: the artifact store is
    // the one any run can write.
    expect(artifact.if).toBe(
      "steps.published.outputs.hit != 'true' && github.event_name == 'pull_request'",
    );
    expect(artifact.env.BRANCHES).toBe("main develop ${{ github.head_ref }}");
    // The list is filtered by the picker, which is what refuses a fork's artifact and every branch
    // that is not main, develop or this pull request's own.
    expect(artifact.run).toMatch(
      /gh api "repos\/\$GITHUB_REPOSITORY\/actions\/artifacts\?name=\$NAME[^"]*" \\\n {2}\| node "\$ROOT\/scripts\/v8-artifact-pick\.mjs" --branches "\$BRANCHES"/u,
    );
    // An artifact that bridged the payload must skip the two-hour build, or the bridge saves nothing.
    expect(step("Build the pinned Android V8 payload").if).toBe(
      "steps.published.outputs.hit != 'true' && steps.artifact.outputs.hit != 'true' && steps.payload.outputs.cache-hit != 'true'",
    );
    expect(step("Verify the complete Android V8 payload").if).toBe(
      "steps.payload.outputs.cache-hit == 'true' || steps.artifact.outputs.hit == 'true' || steps.build.outcome == 'success'",
    );
  });
});

describe("the artifact download step, run for real", () => {
  const stepName = "Download the payload a pull request run of this recipe published";

  function fixture(run: Readonly<Record<string, unknown>>): string {
    return JSON.stringify({
      total_count: 1,
      artifacts: [
        { expired: false, created_at: "2026-11-03T00:00:00Z", workflow_run: { id: 4242, ...run } },
      ],
    });
  }

  /** A runtime root whose payload check passes or fails on purpose, carrying the real picker. */
  function runtimeRoot(verify: "pass" | "fail"): string {
    const root = tempRoot();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/v8-artifact-pick.mjs"), readFileSync(pickerScript));
    writeFileSync(
      join(root, "scripts/build-android-v8.mjs"),
      `process.exit(${verify === "pass" ? 0 : 1});\n`,
    );
    return root;
  }

  function setup(options: {
    readonly artifacts: string;
    readonly download: "ok" | "vanished";
    readonly verify: "pass" | "fail";
  }) {
    const root = tempRoot();
    const api = join(root, "artifacts.json");
    writeFileSync(api, options.artifacts);
    const calls = join(root, "calls.log");
    writeFileSync(calls, "");
    const download =
      options.download === "ok"
        ? 'mkdir -p "$dir" && printf payload > "$dir/libv8android.so"'
        : "exit 1";
    // The stub reads the step's own `--dir`, so it writes where the step asked and nowhere else.
    stub(
      root,
      "gh",
      `case "$1 $2" in
  "api repos/"*) cat "${api}" ;;
  "run download")
    dir=""
    while [ $# -gt 0 ]; do [ "$1" = "--dir" ] && { dir="$2"; shift; }; shift; done
    ${download} ;;
  *) exit 7 ;;
esac`,
      calls,
    );
    const runtime = runtimeRoot(options.verify);
    const output = join(root, "output.txt");
    writeFileSync(output, "");
    const payload = join(runtime, "third_party/v8-android");
    const artifactStep = step(stepName);
    const expressions = {
      "inputs.runtime-root": runtime,
      "github.head_ref": "goal/628",
      // Not a credential: the stub `gh` never reaches the network.
      "github.token": "spec-token",
      "steps.recipe.outputs.hash": "abc123",
    };
    const script = resolve(artifactStep.run, expressions, stepName);
    const env = Object.fromEntries(
      Object.entries(artifactStep.env).map(([name, value]) => [
        name,
        resolve(value, expressions, `${stepName} env ${name}`),
      ]),
    );
    return {
      payload,
      calls: () => readFileSync(calls, "utf8"),
      output: () => readFileSync(output, "utf8"),
      run: () =>
        runScript(script, {
          root,
          env: { ...env, RUNNER_TEMP: join(root, "runner-temp") },
          output,
        }),
    };
  }

  it("restores a payload this repository published on this pull request's branch", () => {
    const test = setup({
      artifacts: fixture({
        repository_id: 903897353,
        head_repository_id: 903897353,
        head_branch: "goal/628",
      }),
      download: "ok",
      verify: "pass",
    });
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(test.output()).toBe("hit=true\n");
    expect(result.stdout).toContain("Restored the payload run 4242 published for v8-android-");
    expect(existsSync(test.payload)).toBe(true);
    expect(test.calls()).toContain("gh run download");
  });

  it("ignores an artifact a fork's run published", () => {
    const test = setup({
      artifacts: fixture({
        repository_id: 903897353,
        head_repository_id: 1234,
        head_branch: "goal/628",
      }),
      download: "ok",
      verify: "pass",
    });
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(test.output()).toBe("hit=false\n");
    // A fork's artifact is never even downloaded.
    expect(test.calls()).not.toContain("gh run download");
    expect(existsSync(test.payload)).toBe(false);
  });

  it("cold-builds when the artifact vanished between the list and the download", () => {
    const test = setup({
      artifacts: fixture({
        repository_id: 903897353,
        head_repository_id: 903897353,
        head_branch: "main",
      }),
      download: "vanished",
      verify: "pass",
    });
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(test.output()).toBe("hit=false\n");
    expect(existsSync(test.payload)).toBe(false);
  });

  it("throws away a payload that fails its own receipt check and cold-builds", () => {
    const test = setup({
      artifacts: fixture({
        repository_id: 903897353,
        head_repository_id: 903897353,
        head_branch: "develop",
      }),
      download: "ok",
      verify: "fail",
    });
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(test.output()).toBe("hit=false\n");
    expect(result.stdout).toContain("::warning::");
    // Nothing of the untrusted payload may survive into the build.
    expect(existsSync(test.payload)).toBe(false);
  });
});
