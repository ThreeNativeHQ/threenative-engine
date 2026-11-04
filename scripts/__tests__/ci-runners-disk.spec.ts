/**
 * A self-hosted runner host that fills its disk fails jobs with ENOSPC, which reads as a mystery
 * compile error rather than a disk report: on 2026-10-18 the laptop runner sat at 98-100% and
 * `test-native` died with ENOSPC in runs 39168826685 and 39175816222. So the pool prunes its own
 * host and refuses — or withdraws — its slots under a stated free-space floor.
 *
 * The script is run for real, against stubbed `docker`, `gh`, `df`, `lscpu` and `nproc` on PATH.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const repo = join(import.meta.dirname, "..", "..");
const script = join(repo, "scripts/ci-runners.sh");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** A bin directory of fakes, and the log every fake appends its arguments to. */
function fakeHost({
  freeKb,
  dockerRoot = "/fake/docker",
  dockerInfoFails = false,
  dockerRootChanges = false,
  dfFails = false,
}: {
  freeKb: number;
  dockerRoot?: string;
  dockerInfoFails?: boolean;
  dockerRootChanges?: boolean;
  dfFails?: boolean;
}) {
  const root = makeTempDirSync("tn-ci-runners-");
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(root, "calls.log");
  writeFileSync(calls, "");

  const stub = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${calls}"\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub(
    "df",
    dfFails
      ? "echo 'df: cannot read /fake: Input/output error' >&2\nexit 1"
      : `printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 1000 0 ${freeKb} 1%% /fake\\n'`,
  );
  // A daemon whose root moves: the balancer must measure where the disk is now, not where it was.
  const dockerInfo = dockerInfoFails
    ? "exit 1"
    : dockerRootChanges
      ? `count=0
         [ -f "${root}/root-reads" ] && count=$(cat "${root}/root-reads")
         count=$((count + 1))
         printf '%s' "$count" > "${root}/root-reads"
         printf '/fake/docker-%s\\n' "$count"`
      : `printf '${dockerRoot}\\n'`;
  stub(
    "docker",
    `case "$1" in
       info) ${dockerInfo} ;;
       image|builder|container) exit 0 ;;
       ps) exit 0 ;;
     esac`,
  );
  stub(
    "gh",
    `# The balancer does not create its state directory before it routes, so the stub must.
     tn_stop() { mkdir -p "$(dirname "$TN_TEST_STOP_FILE")" && : > "$TN_TEST_STOP_FILE"; }
     case "$1 $2" in
       "variable get") printf 'tn-local\\n' ;;
       "variable delete")
         printf 'deleted\\n' >> "${root}/deleted"
         if [ -n "\${TN_TEST_STOP_FILE:-}" ]; then
           count=$(wc -l < "${root}/deleted")
           [ "\${TN_TEST_STOP_AFTER_DELETES:-1}" -gt "$count" ] || tn_stop
         fi ;;
       "variable set") printf 'set\\n' > "${root}/set" ;;
       "api "*)
         case "$*" in
           *actions/runners*)
             printf 'run\\n' >> "${root}/runner-reads"
             if [ -n "\${TN_TEST_STOP_AFTER_RUNNER_READS:-}" ]; then
               count=$(wc -l < "${root}/runner-reads")
               [ "$TN_TEST_STOP_AFTER_RUNNER_READS" -gt "$count" ] || tn_stop
             fi ;;
         esac ;;
     esac`,
  );
  // Eight whole cores on one socket, matching `nproc`, so `plan` accepts a one-slot pool.
  stub(
    "lscpu",
    `printf '# CPU,CORE,SOCKET,ONLINE\\n'
     i=0; while [ "$i" -lt 8 ]; do printf '%s,%s,0,Y\\n' "$i" "$i"; i=$((i + 1)); done`,
  );
  stub("nproc", "printf '8\\n'");
  return { root, bin, calls };
}

function run(
  args: string[],
  host: ReturnType<typeof fakeHost>,
  extraEnv: Record<string, string> = {},
) {
  const state = join(host.root, "state");
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${host.bin}:${process.env.PATH ?? ""}`,
      XDG_STATE_HOME: state,
      HOME: host.root,
    },
  });
  assert.ifError(result.error);
  return { ...result, calls: readFileSync(host.calls, "utf8"), state };
}

/** The balancer, with a stop file a stub `gh` creates so the loop ends by itself. */
function balance(host: ReturnType<typeof fakeHost>, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("bash", [script, "balance"], {
    encoding: "utf8",
    timeout: 8_000,
    env: {
      ...process.env,
      PATH: `${host.bin}:${process.env.PATH ?? ""}`,
      XDG_STATE_HOME: join(host.root, "state"),
      HOME: host.root,
      TN_RUNNER_POLL_SECONDS: "0.05",
      TN_TEST_STOP_FILE: join(host.root, "state", "threenative/ci-runners/stop"),
      ...extraEnv,
    },
  });
  assert.ifError(result.error);
  return result;
}

describe("the tn-local runner host disk budget", () => {
  it("reports the free-space verdict and the last prune, which is what pauses the slots", () => {
    const host = fakeHost({ freeKb: 350 * 1024 * 1024 });
    const result = run(["status"], host);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("disk: 350 GB free on /fake/docker (floor 20 GB): ok");
    expect(result.stdout).toContain("prune: never");
  });

  it("refuses to bring the pool up under the floor, naming the numbers", () => {
    const host = fakeHost({ freeKb: 5 * 1024 * 1024 });
    const result = run(["up", "1"], host);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TN_CI_RUNNERS_DISK: 5 GB free on /fake/docker");
    expect(result.stderr).toContain("under the 20 GB floor");
    // The prune ran before the measurement: freeing the host is the first thing that is tried.
    expect(result.calls).toContain("docker builder prune --force --filter until=72h");
    // And no job can be routed to a host that cannot hold one.
    expect(result.calls).not.toContain("docker build -t");
    expect(result.calls).not.toContain("variable set");
  });

  it("prunes dangling images, stale build cache and stopped CI containers, and records it", () => {
    const host = fakeHost({ freeKb: 100 * 1024 * 1024 });
    const result = run(["prune"], host);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("docker image prune --force");
    // `until=72h`, not everything: this docker daemon is the owner's too.
    expect(result.calls).toContain("docker builder prune --force --filter until=72h");
    expect(result.calls).toContain("docker container prune --force --filter label=tn-ci-runner=1");
    expect(result.stdout).toContain("prune: 100 GB -> 100 GB free on /fake/docker (floor 20 GB)");
    // The operator's `status` has to be able to show that the prune happened.
    const after = run(["status"], host);
    expect(after.stdout).toMatch(/prune: \d\d:\d\d:\d\dZ \(\d+ min ago\)/u);
  });

  it("pauses the slots while the floor is breached, before a job can hit ENOSPC", () => {
    const host = fakeHost({ freeKb: 3 * 1024 * 1024 });
    // The balancer loops until its stop file appears; a stub `gh variable delete` is what the
    // pause does, so the first delete ends the loop after the second one is recorded.
    const result = balance(host);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("disk 3 GB free, under the 20 GB floor: slots paused");
    expect(readFileSync(join(host.root, "deleted"), "utf8")).toContain("deleted");
    // A `variable set` would re-advertise the label on the same poll.
    expect(existsSync(join(host.root, "set"))).toBe(false);
  });

  it("keeps balancing when the prune cannot run", () => {
    // A host whose docker daemon died still has to withdraw its slots: its disk is exactly the
    // thing nobody can measure any more. `prune` calls `fail`, which exits, so the balancer must
    // run it in a subshell — the old direct call ended the whole loop with status 2.
    const host = fakeHost({ freeKb: 3 * 1024 * 1024, dockerInfoFails: true });
    const result = balance(host);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("docker is not usable without sudo");
    expect(result.stderr).toContain("slots paused");
  });

  it("does not read an unreadable df as an empty disk", () => {
    // 0 GB free would pause every slot for a measurement error, so an unanswerable `df` keeps the
    // current routing and says so. The label is withdrawn only because no runner is idle.
    const host = fakeHost({ freeKb: 0, dfFails: true });
    const result = balance(host, { TN_TEST_STOP_AFTER_RUNNER_READS: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      "cannot read free space on /fake/docker; keeping the current routing",
    );
    expect(result.stderr).not.toContain("slots paused");
    expect(existsSync(join(host.root, "set"))).toBe(false);
  });

  it("measures the docker root where it is now on every poll, because the loop runs for hours", () => {
    // The path is not a constant of the process: a daemon whose root moves must be measured in its
    // new place, so it is read per poll and not once at the start. Two polls plus the three reads
    // `prune` makes for its own report are five; reading it once at start leaves four.
    const host = fakeHost({ freeKb: 3 * 1024 * 1024, dockerRootChanges: true });
    const result = balance(host, { TN_TEST_STOP_AFTER_DELETES: "4" });
    expect(result.status, result.stderr).toBe(0);
    const reads = readFileSync(host.calls, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("docker info --format"));
    expect(reads.length).toBeGreaterThanOrEqual(5);
  });
});
