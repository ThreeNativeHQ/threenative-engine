// The wrapper's two rules are the ones four copies disagreed about: a failed call must not read as
// an empty answer, and a call that changes state must never be retried. The spec drives it against
// a fake `gh` on PATH, so the real binary is never needed.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { gh } from "../lib/gh.mjs";

interface IFakeGh {
  readonly calls: () => number;
  readonly restore: () => void;
}

/** Puts a `gh` on PATH that fails `failures` times, then answers `answer`. */
function fakeGh(failures: number, answer = "ok\n"): IFakeGh {
  const root = makeTempDirSync("tn-gh-");
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const counter = path.join(root, "count");
  writeFileSync(counter, "0");
  const script = path.join(bin, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `count=$(cat "${counter}")`,
      "count=$((count + 1))",
      `echo "$count" > "${counter}"`,
      `if [ "$count" -le ${String(failures)} ]; then`,
      "  echo 'gh: server error' >&2",
      "  exit 1",
      "fi",
      `printf '%b' '${answer.replace(/\n/gu, "\\n")}'`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  return {
    calls: () => Number(readFileSync(counter, "utf8")),
    restore: () => {
      process.env.PATH = previous;
    },
  };
}

const fakes: IFakeGh[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.restore();
});

function withFake(failures: number, answer?: string): IFakeGh {
  const fake = fakeGh(failures, answer);
  fakes.push(fake);
  return fake;
}

describe("the gh wrapper", () => {
  it("should answer on the first call and not retry a read that succeeded", () => {
    const fake = withFake(0, "body\n");
    expect(gh(["pr", "view", "1"])).toBe("body\n");
    expect(fake.calls()).toBe(1);
  });

  it("should retry a read once and then answer", () => {
    const fake = withFake(1, "body\n");
    expect(gh(["pr", "view", "1"])).toBe("body\n");
    expect(fake.calls()).toBe(2);
  });

  it("should throw with gh's own stderr when a read keeps failing", () => {
    const fake = withFake(9);
    expect(() => gh(["run", "view", "7"])).toThrow(
      /gh run view failed after 2 attempt\(s\): gh: server error/u,
    );
    expect(fake.calls()).toBe(2);
  });

  it("should never retry a call that changes state", () => {
    const fake = withFake(1);
    expect(() => gh(["run", "cancel", "42"])).toThrow(/after 1 attempt/u);
    expect(fake.calls()).toBe(1);
  });

  it("should not repeat a shape it does not recognise as a read", () => {
    for (const args of [
      ["api", "repos/a/b/actions/workflows/1/dispatches", "--method=POST"],
      ["api", "repos/a/b/actions/workflows/1/dispatches", "--method", "POST"],
      ["api", "repos/a/b/actions/workflows/1/dispatches", "-XPOST"],
      ["api", "repos/a/b/issues/1", "--raw-field", "body=hi"],
      ["workflow", "run", "ci.yml"],
      ["release", "upload", "v1", "file.tgz"],
      ["secret", "set", "TOKEN", "-b", "x"],
    ]) {
      const fake = withFake(1);
      expect(() => gh(args), args.join(" ")).toThrow(/after 1 attempt/u);
      expect(fake.calls(), args.join(" ")).toBe(1);
    }
  });

  it("should repeat a shape it knows is a read", () => {
    for (const args of [
      ["run", "view", "7"],
      ["api", "repos/a/b"],
    ]) {
      const fake = withFake(1, "body\n");
      expect(gh(args), args.join(" ")).toBe("body\n");
      expect(fake.calls(), args.join(" ")).toBe(2);
    }
  });

  it("should treat an api call that sends a body as a write", () => {
    const fake = withFake(1);
    expect(() => gh(["api", "repos/a/b/issues/1/comments", "-f", "body=hi"])).toThrow(
      /after 1 attempt/u,
    );
    expect(fake.calls()).toBe(1);
  });
});
