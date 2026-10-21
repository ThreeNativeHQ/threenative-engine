import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/retry-download.sh");

/** A command that fails `failures` times, counting its attempts in a file, then succeeds. */
function flaky(failures: number): { attempts: () => number; command: string[] } {
  const directory = makeTempDirSync("threenative-retry-");
  const counter = join(directory, "count");
  writeFileSync(counter, "0");
  const body = `n=$(($(cat ${counter}) + 1)); echo $n > ${counter}; [ $n -gt ${failures} ]`;
  return { attempts: () => Number(readFileSync(counter, "utf8")), command: ["sh", "-c", body] };
}

const retry = (command: string[]) =>
  spawnSync("sh", [script, ...command], {
    encoding: "utf8",
    env: { ...process.env, TN_RETRY_DELAY: "0" },
  });

describe("scripts/retry-download.sh", () => {
  it("returns after the first success without a second attempt", () => {
    const probe = flaky(0);
    expect(retry(probe.command).status).toBe(0);
    expect(probe.attempts()).toBe(1);
  });

  it("retries a failing download and succeeds on the third attempt", () => {
    const probe = flaky(2);
    expect(retry(probe.command).status).toBe(0);
    expect(probe.attempts()).toBe(3);
  });

  it("stops after three attempts and keeps the command's own exit status", () => {
    const probe = flaky(99);
    const result = retry(["sh", "-c", `${probe.command[2]}; exit 7`]);
    expect(result.status).toBe(7);
    expect(probe.attempts()).toBe(3);
  });
});

/** The workflow steps a network blip used to cost a whole run: every one must retry. */
const DOWNLOAD = /\b(?:apt-get (?:update|install)|sdkmanager|emsdk" install)\b/u;
/** What must never be retried: a test, a budget or a threshold would hide a real failure. */
const VERIFY = /\b(?:vitest|playtest|pnpm test|pnpm budgets|verify-[\w-]+|conformance)\b/u;

describe("workflow download steps", () => {
  const files = [
    ".github/workflows/native-release.yml",
    ".github/workflows/native-platforms.yml",
    ".github/actions/native-engine-wasm/action.yml",
  ];

  it("wrap every apt, sdkmanager and emsdk download in the bounded retry", () => {
    for (const file of files) {
      for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
        if (!DOWNLOAD.test(line) || line.trimStart().startsWith("#")) continue;
        // `sudo apt-get update && sh retry ... apt-get install`: each command carries its own wrapper.
        const commands = line.split("&&");
        for (const command of commands.filter((part) => DOWNLOAD.test(part)))
          expect(command, `${file}: ${line.trim()}`).toMatch(/retry-download\.sh/u);
      }
    }
  });

  it("never wrap a test, a budget or a threshold", () => {
    const wrapped = files.flatMap((file) =>
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .filter((line) => /retry-download\.sh/u.test(line))
        .map((line) => ({ file, line })),
    );
    expect(wrapped.length).toBeGreaterThan(8);
    for (const { file, line } of wrapped) expect(line, file).not.toMatch(VERIFY);
  });

  it("the script ships next to the other CI shell helpers", () => {
    expect(readdirSync(join(root, "scripts"))).toContain("retry-download.sh");
  });
});
