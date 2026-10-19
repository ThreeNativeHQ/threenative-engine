import { spawn } from "node:child_process";

import { expect, test } from "vitest";

import { waitForUrl } from "../src/runner/server.js";
import { ManagedServerError } from "../src/runner/shared.js";

test("a managed server that exits with code 9 fails the wait as a ManagedServerError that names the code", async () => {
  // Nothing listens on port 9 of loopback, so each probe is refused at once and the exit is what ends the wait.
  const server = spawn(process.execPath, ["-e", "process.exit(9)"], { stdio: "ignore" });
  const failure = await waitForUrl("http://127.0.0.1:9/", 5_000, server).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ManagedServerError);
  expect((failure as Error).message).toContain("exited with code 9");
});
