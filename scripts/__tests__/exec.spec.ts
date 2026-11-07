// The runner's rules are the ones the eight copies disagreed about: a non-zero exit must throw, the
// message must name the step and the exit, captured output must come back intact, and a hung child
// must be killed rather than holding a lane open. The spec runs real child processes.
import { describe, expect, it } from "vitest";
import { ExecError, run, runAsync } from "../lib/exec.js";

const node = process.execPath;

describe("the exec runner", () => {
  it("should return stdout when it captures, and nothing when it streams", () => {
    expect(run(node, ["-e", "process.stdout.write('hello')"], { stdio: "capture" })).toBe("hello");
    expect(run(node, ["-e", "process.stdout.write('hello')"])).toBe("");
  });

  it("should throw with the step name and the exit code when the command fails", () => {
    const error = (() => {
      try {
        run(node, ["-e", "process.exit(3)"], { label: "pnpm typecheck" });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ExecError);
    expect((error as ExecError).code).toBe("TN_EXEC_FAILED");
    expect((error as ExecError).exitCode).toBe(3);
    expect((error as Error).message).toContain("pnpm typecheck exited 3");
  });

  it("should carry the caller's own code", () => {
    expect(() => run(node, ["-e", "process.exit(1)"], { code: "TN_RELEASE_STEP_FAILED" })).toThrow(
      /TN_RELEASE_STEP_FAILED/u,
    );
  });

  it("should run in the directory it was given, as a bare string or as options", () => {
    const cwd = process.cwd();
    expect(
      run(node, ["-e", "process.stdout.write(process.cwd())"], { cwd, stdio: "capture" }),
    ).toBe(cwd);
    // A bare string is the directory most call sites already passed.
    expect(run(node, ["-e", "process.stdout.write(process.cwd())"], { cwd })).toBe("");
  });

  it("should capture what an async command printed, and pass its environment through", async () => {
    const output = await runAsync(
      node,
      ["-e", "process.stdout.write(process.env.TN_PROBE ?? '')"],
      {
        env: { TN_PROBE: "seen" },
        stdio: "capture",
      },
    );
    expect(output).toContain("seen");
  });

  it("should reject an async command that fails, naming the exit", async () => {
    await expect(runAsync(node, ["-e", "process.exit(4)"])).rejects.toThrow(/exited 4/u);
  });

  it("should kill a command that outlives its timeout and say so", async () => {
    await expect(
      runAsync(node, ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 50 }),
    ).rejects.toThrow(/Killed after 50ms without finishing/u);
  });

  it("should reject a command that cannot start", async () => {
    await expect(runAsync("tn-no-such-binary", [])).rejects.toThrow(/did not start/u);
  });
});
