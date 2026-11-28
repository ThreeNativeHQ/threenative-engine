import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const script = path.resolve(import.meta.dirname, "../ci-runners.sh");

function plan(
  rows: readonly string[],
  slots = "3",
  available = rows.length,
): ReturnType<typeof spawnSync> {
  const fixture = makeTempDirSync("runner-cpu-plan-");
  const bin = path.join(fixture, "bin");
  mkdirSync(bin);
  for (const [name, output] of [
    ["lscpu", rows.join("\n")],
    ["nproc", String(available)],
  ]) {
    const command = path.join(bin, name ?? "");
    writeFileSync(command, `#!/bin/sh\ncat <<'DATA'\n${output}\nDATA\n`);
    chmodSync(command, 0o755);
  }
  // Planning must not use Docker, credentials, GitHub, or the service's mutable state.
  return spawnSync("bash", [script, "plan", slots], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TN_RUNNERS_ENV: "/missing-env" },
  });
}

const topology = Array.from({ length: 24 }, (_, cpu) => `${cpu},${cpu % 12},0,Y`);

describe.skipIf(process.platform !== "linux")("local runner physical core allocation", () => {
  it("keeps whole SMT cores separate between heavy slots, light pool and host", () => {
    const result = plan(topology);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "heavy:1:0,12,1,13,2,14\nheavy:2:3,15,4,16,5,17\nheavy:3:6,18,7,19,8,20\nlight:9,21\nhost:10,22,11,23\n",
    );
  });

  it("groups actual socket/core identities instead of assuming CPU plus half is its sibling", () => {
    const rows = Array.from({ length: 12 }, (_, core) => [
      `${core * 2},${core % 6},${Math.floor(core / 6)},Y`,
      `${core * 2 + 1},${core % 6},${Math.floor(core / 6)},Y`,
    ]).flat();
    const result = plan(rows);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("heavy:1:0,1,2,3,4,5\n");
    expect(result.stdout).toContain("light:18,19\nhost:20,21,22,23\n");
  });

  it("passes only whole-core shapes to new slots without changing devices or memory limits", async () => {
    const fixture = makeTempDirSync("runner-shape-");
    const bin = path.join(fixture, "bin");
    mkdirSync(bin);
    const shapes = path.join(fixture, "shapes");
    const environment = path.join(fixture, "env");
    writeFileSync(environment, "RUNNER_ADMIN_TOKEN=test-only-placeholder\n");
    const commands = {
      lscpu: `cat <<'DATA'\n${topology.join("\n")}\nDATA`,
      nproc: "echo 24",
      docker: "exit 0",
      gh: 'case "$*" in *"repos/{owner}/{repo}"*) echo test/repo;; *offline*) ;; *runners*) echo 3;; esac',
      setsid: `printf '%s\n' "\${9:-balancer}" >> '${shapes}'`,
    };
    for (const [name, body] of Object.entries(commands)) {
      const command = path.join(bin, name);
      writeFileSync(command, `#!/bin/sh\n${body}\n`);
      chmodSync(command, 0o755);
    }
    const result = spawnSync("bash", [script, "up", "3"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TN_RUNNERS_ENV: environment,
        XDG_STATE_HOME: fixture,
      },
    });
    expect(result.status).toBe(0);
    await vi.waitFor(() => {
      expect(readFileSync(shapes, "utf8").trim().split("\n")).toHaveLength(7);
    });
    const launched = readFileSync(shapes, "utf8").trim().split("\n");
    const heavy = launched.filter((shape) => shape.includes("--memory 9g"));
    const light = launched.filter((shape) => shape.includes("--memory 2g"));
    expect(heavy).toHaveLength(3);
    for (const cpus of ["0,12,1,13,2,14", "3,15,4,16,5,17", "6,18,7,19,8,20"]) {
      expect(
        heavy.some((shape) =>
          shape.includes(`--cpuset-cpus ${cpus} --memory 9g --memory-swap 9g --oom-score-adj 800`),
        ),
      ).toBe(true);
    }
    expect(light).toEqual(
      Array(3).fill("--cpuset-cpus 9,21 --cpus 1 --memory 2g --memory-swap 2g --oom-score-adj 900"),
    );
    expect(launched.join("\n")).not.toMatch(/--privileged|--gpus|--mount|--volume/u);
  });

  it.each([
    Array.from({ length: 24 }, (_, index) => `0,${index % 12},0,Y`),
    [...topology.slice(0, 23), "23,unknown,0,Y"],
  ])("rejects invalid or duplicated topology before producing an allocation", (...rows) => {
    const result = plan(rows);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid or duplicate CPU topology");
    expect(result.stdout).toBe("");
  });

  it("rejects six slots before any runner mutation because complete cores cannot fit", () => {
    const result = plan(topology, "6");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("whole physical cores");
    expect(result.stdout).toBe("");
  });

  it("cannot advertise unavailable CPUs through an inherited OpenMP override", () => {
    const fixture = makeTempDirSync("runner-affinity-");
    const bin = path.join(fixture, "bin");
    mkdirSync(bin);
    const lscpu = path.join(bin, "lscpu");
    writeFileSync(lscpu, `#!/bin/sh\ncat <<'DATA'\n${topology.join("\n")}\nDATA\n`);
    chmodSync(lscpu, 0o755);
    const allowed = readFileSync("/proc/self/status", "utf8").match(
      /^Cpus_allowed_list:\s*(\d+)/mu,
    )?.[1];
    expect(allowed).toBeDefined();
    const result = spawnSync("taskset", ["-c", allowed ?? "", "bash", script, "plan", "3"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OMP_NUM_THREADS: "24" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("affinity");
    expect(result.stdout).toBe("");
  });

  it("fails closed when inherited affinity cannot cover the discovered online CPUs", () => {
    const result = plan(topology, "3", 23);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("affinity");
  });
});

// Runs `balance` against a fake `gh` and `sleep`: the fake `sleep` advances a tick counter and
// applies the scheduled mutation, so the loop ends deterministically through the real stop file.
function runBalance(
  options: {
    readonly varsFail?: boolean;
    readonly deleteHeavyOnTick?: number;
    readonly stopOnTick?: number;
    readonly stopBefore?: boolean;
    readonly stopDuringVarReadAt?: number;
    readonly initialVars?: string;
    readonly idle?: string;
    readonly idleOnTick?: Readonly<Record<number, string>>;
    readonly downAfterStop?: boolean;
  } = {},
) {
  const fixture = makeTempDirSync("runner-balance-");
  const bin = path.join(fixture, "bin");
  mkdirSync(bin);
  const idleFile = path.join(fixture, "idle");
  const varsFile = path.join(fixture, "vars");
  const failFile = path.join(fixture, "vars-fail");
  const ticksFile = path.join(fixture, "ticks");
  const readsFile = path.join(fixture, "var-reads");
  const callsFile = path.join(fixture, "gh-calls");
  const stateDir = path.join(fixture, "threenative", "ci-runners");
  mkdirSync(stateDir, { recursive: true });
  const stopFile = path.join(stateDir, "stop");

  writeFileSync(idleFile, options.idle ?? "tn-local tn-local-light\n");
  writeFileSync(varsFile, options.initialVars ?? "");
  writeFileSync(callsFile, "");
  if (options.varsFail) writeFileSync(failFile, "");
  if (options.stopBefore) writeFileSync(stopFile, "");

  const dropVar = (name: string): string =>
    `grep -v "^${name}=" '${varsFile}' 2>/dev/null > '${varsFile}.tmp' || true\nmv '${varsFile}.tmp' '${varsFile}'`;

  const gh = `#!/bin/sh
printf '%s\\n' "$*" >> '${callsFile}'
case "$*" in
  *"repos/{owner}/{repo}"*) printf 'test/repo\\n'; exit 0 ;;
esac
if [ "$1" = "variable" ]; then
  shift
  case "$1" in
    set)
      name="$2"; shift 2; body=""
      while [ $# -gt 0 ]; do case "$1" in --body) body="$2"; shift 2 ;; *) shift ;; esac; done
      grep -v "^$name=" '${varsFile}' 2>/dev/null > '${varsFile}.tmp' || true
      printf '%s=%s\\n' "$name" "$body" >> '${varsFile}.tmp'
      mv '${varsFile}.tmp' '${varsFile}'
      exit 0 ;;
    delete)
      ${dropVar("$2")}
      exit 0 ;;
    get)
      value=$(grep "^$2=" '${varsFile}' 2>/dev/null | head -1 | cut -d= -f2-)
      [ -n "$value" ] && { printf '%s\\n' "$value"; exit 0; }
      exit 1 ;;
  esac
fi
if [ "$1" = "api" ]; then
  case "$*" in
    *"actions/variables"*)
      reads=$(cat '${readsFile}' 2>/dev/null || echo 0); reads=$((reads + 1))
      echo "$reads" > '${readsFile}'
      ${options.stopDuringVarReadAt === undefined ? ":" : `[ "$reads" -ge ${options.stopDuringVarReadAt} ] && : > '${stopFile}'`}
      [ -e '${failFile}' ] && exit 1
      # Same shape as the real --jq filter: the name, or NAME:invalid for a wrong label; never the value.
      awk -F= '$1 == "TN_RUNNER" { print ($2 == "tn-local") ? "TN_RUNNER" : "TN_RUNNER:invalid" }
               $1 == "TN_RUNNER_LIGHT" { print ($2 == "tn-local-light") ? "TN_RUNNER_LIGHT" : "TN_RUNNER_LIGHT:invalid" }
               $1 == "TN_RUNNER_SLOTS" { print "TN_RUNNER_SLOTS=" $2 }' '${varsFile}' 2>/dev/null
      exit 0 ;;
    *"actions/runners"*)
      # Installed gh rejects --slurp together with --jq, so the publisher must never combine them.
      case "$*" in
        *--slurp*--jq*|*--jq*--slurp*) printf '%s\\n' "--slurp option not supported with --jq or --template" >&2; exit 1 ;;
      esac
      # Production shape: one idle matching label per line, no count prefix.
      for label in $(cat '${idleFile}' 2>/dev/null); do
        case "$label" in tn-local|tn-local-light) printf '%s\\n' "$label" ;; esac
      done
      exit 0 ;;
  esac
fi
exit 0
`;

  const mutations: string[] = [];
  for (const [tick, content] of Object.entries(options.idleOnTick ?? {})) {
    mutations.push(`[ "$ticks" -eq ${tick} ] && printf '%s\\n' '${content}' > '${idleFile}'`);
  }
  if (options.deleteHeavyOnTick !== undefined) {
    mutations.push(
      `[ "$ticks" -eq ${options.deleteHeavyOnTick} ] && {\n  ${dropVar("TN_RUNNER")}\n}`,
    );
  }
  if (options.stopOnTick !== undefined) {
    mutations.push(`[ "$ticks" -eq ${options.stopOnTick} ] && : > '${stopFile}'`);
  }
  const sleep = `#!/bin/sh
ticks=$(cat '${ticksFile}' 2>/dev/null || echo 0); ticks=$((ticks + 1))
echo "$ticks" > '${ticksFile}'
${mutations.join("\n")}
exit 0
`;

  for (const [name, body] of [
    ["gh", gh],
    ["sleep", sleep],
    ["docker", "#!/bin/sh\nexit 0\n"],
    // The balancer pauses its slots under a free-space floor, so the host's disk is an input to
    // every case here and must not be this machine's. A host with room: the pause has its own
    // spec in `ci-runners-disk.spec.ts`.
    [
      "df",
      `printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 1000 0 ${350 * 1024 * 1024} 1%% /fake\\n'`,
    ],
  ] as const) {
    const command = path.join(bin, name);
    writeFileSync(command, body);
    chmodSync(command, 0o755);
  }

  const result = spawnSync("bash", [script, "balance"], {
    encoding: "utf8",
    cwd: fixture,
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: fixture,
      XDG_STATE_HOME: fixture,
      TN_RUNNERS_ENV: path.join(fixture, "missing-env"),
    },
  });
  let status = result.status;
  if (options.downAfterStop) {
    status = spawnSync("bash", [script, "down"], {
      encoding: "utf8",
      cwd: fixture,
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        XDG_STATE_HOME: fixture,
        TN_RUNNERS_ENV: path.join(fixture, "missing-env"),
      },
    }).status;
  }
  return {
    status,
    calls: readFileSync(callsFile, "utf8"),
    vars: readFileSync(varsFile, "utf8"),
  };
}

describe.skipIf(process.platform !== "linux")("local runner balancer routing", () => {
  it("advertises idle capacity only after two consecutive idle polls", () => {
    const { status, vars } = runBalance({ stopOnTick: 2 });
    expect(status).toBe(0);
    expect(vars).toContain("TN_RUNNER=tn-local\n");
    expect(vars).toContain("TN_RUNNER_LIGHT=tn-local-light\n");
  });

  it("does not advertise before the second idle poll", () => {
    const { status, vars } = runBalance({ stopOnTick: 1 });
    expect(status).toBe(0);
    expect(vars).not.toContain("TN_RUNNER=");
  });

  it("wrong-label routing variable: clears a stale label while the pool is busy", () => {
    const { status, vars } = runBalance({
      initialVars: "TN_RUNNER=some-other-label\n",
      idle: "",
      stopOnTick: 2,
    });
    expect(status).toBe(0);
    expect(vars).not.toContain("TN_RUNNER=");
  });

  it("wrong-label routing variable: corrects it to the expected label once idle is confirmed", () => {
    const { status, vars } = runBalance({
      initialVars: "TN_RUNNER=some-other-label\n",
      stopOnTick: 2,
    });
    expect(status).toBe(0);
    expect(vars).toContain("TN_RUNNER=tn-local\n");
  });

  it("re-advertises a routing variable deleted externally while capacity stays idle", () => {
    const { status, calls, vars } = runBalance({ deleteHeavyOnTick: 2, stopOnTick: 4 });
    expect(status).toBe(0);
    expect(vars).toContain("TN_RUNNER=tn-local\n");
    expect(
      calls.split("\n").filter((line) => line.includes("variable set TN_RUNNER ")),
    ).toHaveLength(2);
  });

  it("does not advertise when the routing-variable list cannot be read", () => {
    const { status, vars } = runBalance({ varsFail: true, stopOnTick: 3 });
    expect(status).toBe(0);
    expect(vars).not.toContain("TN_RUNNER");
  });

  it("never advertises when the stop file already exists", () => {
    const { status, calls } = runBalance({ stopBefore: true });
    expect(status).toBe(0);
    expect(calls).not.toContain("variable set");
  });

  it("stops without re-advertising when a teardown begins mid-poll", () => {
    const { status, calls } = runBalance({ stopDuringVarReadAt: 2, stopOnTick: 5 });
    expect(status).toBe(0);
    expect(calls).not.toContain("variable set");
  });

  it("tracks the idle heavy TN_RUNNER_SLOTS count and clears it on busy and down", () => {
    // Two idle heavy and one light runner: the count must be the heavy total, and the label must
    // never appear before the count it promises.
    const tracked = runBalance({
      idle: "tn-local tn-local tn-local-light\n",
      initialVars: "TN_RUNNER_SLOTS=9\n",
      idleOnTick: { 3: "tn-local tn-local tn-local tn-local-light", 4: "tn-local-light" },
      stopOnTick: 5,
    });
    expect(tracked.status).toBe(0);
    const lines = tracked.calls.split("\n");
    expect(lines.findIndex((line) => line.includes("variable set TN_RUNNER_SLOTS"))).toBeLessThan(
      lines.findIndex((line) => line.includes("variable set TN_RUNNER ")),
    );
    expect(lines.some((line) => line.includes("variable set TN_RUNNER_SLOTS --body 2 "))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("variable set TN_RUNNER_SLOTS --body 3 "))).toBe(
      true,
    );
    // A busy pool withdraws the count with the label; the light lane never gets a count.
    expect(tracked.vars).not.toContain("TN_RUNNER=");
    expect(tracked.vars).not.toContain("TN_RUNNER_SLOTS=");
    expect(tracked.calls).not.toContain("TN_RUNNER_LIGHT_SLOTS");

    // down clears a count still advertised, not only the label.
    const torn = runBalance({
      idle: "tn-local tn-local-light\n",
      stopOnTick: 2,
      downAfterStop: true,
    });
    expect(torn.status).toBe(0);
    expect(torn.vars).not.toContain("TN_RUNNER=");
    expect(torn.vars).not.toContain("TN_RUNNER_SLOTS=");
  });
});

// Two pools on one host is the 2026-11-27 incident: the systemd unit's pool and a hand-started one
// ran together, so every heavy cpuset held two containers, each job got half the cores its cpuset
// promised, and 60 s vitest tests timed out at 64 s on a 24-thread host. `up` must refuse — and the
// pool it does start must keep the host after `up` exits, or the guard protects nothing.
describe.skipIf(process.platform !== "linux")("one runner pool per host", () => {
  it("refuses a second pool, then holds the host while its own pool runs", async () => {
    const fixture = makeTempDirSync("runner-second-pool-");
    const bin = path.join(fixture, "bin");
    mkdirSync(bin);
    const shapes = path.join(fixture, "shapes");
    const calls = path.join(fixture, "calls");
    const slotPids = path.join(fixture, "slot.pids");
    const holderReady = path.join(fixture, "holder-ready");
    const environment = path.join(fixture, "env");
    writeFileSync(environment, "RUNNER_ADMIN_TOKEN=test-only-placeholder\n");
    writeFileSync(calls, "");
    // The host's own lock path: not derived from a checkout, so both pools resolve it.
    const stateDir = path.join(fixture, "threenative", "ci-runners");
    const lock = path.join(stateDir, "pool.lock");
    mkdirSync(stateDir, { recursive: true });
    const commands = {
      lscpu: `cat <<'DATA'\n${topology.join("\n")}\nDATA`,
      nproc: "echo 24",
      docker: `printf 'docker %s\\n' "$*" >> '${calls}'`,
      df: `printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 1000 0 ${350 * 1024 * 1024} 1%% /fake\\n'`,
      gh: `printf 'gh %s\\n' "$*" >> '${calls}'\ncase "$*" in *"repos/{owner}/{repo}"*) echo test/repo ;; *offline*) ;; *runners*) echo 3 ;; esac`,
      // A slot is a host-side loop for the pool's lifetime, and it is what inherits the lock: this
      // fake must inherit it too and stay up until the test stops it. The balancer exits at once.
      setsid: `printf 'setsid %s\\n' "$*" >> '${calls}'\nprintf '%s\\n' "\${9:-balancer}" >> '${shapes}'\n[ "$3" = "-c" ] || exit 0\necho $$ >> '${slotPids}'\nexec sleep 60`,
    };
    for (const [name, body] of Object.entries(commands)) {
      const command = path.join(bin, name);
      writeFileSync(command, `#!/bin/sh\n${body}\n`);
      chmodSync(command, 0o755);
    }
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TN_RUNNERS_ENV: environment,
      XDG_STATE_HOME: fixture,
    };
    const probe = () => spawnSync("flock", ["-n", lock, "true"]).status;
    const held = (expectation: string) =>
      vi.waitFor(() => expect(probe(), expectation).not.toBe(0), { timeout: 15_000 });

    // The other pool: it holds the lock for its lifetime, the way `up` and then its balancer do,
    // and records the checkout an operator must stop.
    const holder = spawn(
      "bash",
      [
        "-c",
        `exec {lock}>>'${lock}' && flock -n "$lock" || exit 3\nprintf 'started 2026-11-27T20:55:00Z from /elsewhere/threenative-engine\\n' > '${lock}'\n: > '${holderReady}'\nexec sleep 60`,
      ],
      { stdio: "ignore", detached: true },
    );
    try {
      // The holder announces itself after locking; probing for the lock instead would race its own
      // `flock` with a probe that holds the file for a microsecond.
      await vi.waitFor(() => expect(existsSync(holderReady)).toBe(true), { timeout: 15_000 });
      // Two checkouts: the primary one and a lane, both of which now refuse and start nothing.
      for (const cwd of [fixture, makeTempDirSync("runner-other-checkout-")]) {
        const result = spawnSync("bash", [script, "up", "3"], { encoding: "utf8", cwd, env });
        expect(result.status, result.stdout).toBe(1);
        expect(result.stderr).toContain("TN_CI_RUNNERS:");
        expect(result.stderr).toContain("pool is already running");
        // Names the pool that holds the host, and both ways to stop it.
        expect(result.stderr).toContain("/elsewhere/threenative-engine");
        expect(result.stderr).toContain("systemctl --user stop threenative-ci-runners.service");
        expect(result.stderr).toContain("ci-runners.sh down");
      }
      // Nothing was built, run or routed: the refusal is the first thing `up` does.
      expect(existsSync(shapes)).toBe(false);
      expect(readFileSync(calls, "utf8")).not.toMatch(/^docker (build|run) /mu);
    } finally {
      // One process group, so the waiter cannot outlive the test.
      try {
        process.kill(-(holder.pid ?? 0), "SIGTERM");
      } catch {
        // Already gone: the refusal above is what the case is for.
      }
    }
    await vi.waitFor(() => expect(probe()).toBe(0), { timeout: 15_000 });

    // With the host free, the same checkout brings its own pool up and keeps the claim after the
    // command returns: the balancer owns the routing, so it owns the lock.
    const started = spawnSync("bash", [script, "up", "3"], { encoding: "utf8", env });
    expect(started.status, started.stderr).toBe(0);
    // The slots are backgrounded, so their launches land after `up` returns.
    await vi.waitFor(
      () => expect(readFileSync(shapes, "utf8").trim().split("\n")).toHaveLength(7),
      { timeout: 15_000 },
    );
    await held("the pool keeps the host while its slots run");
    // And the claim ends with the pool, so the next `up` (systemd's ExecStop/ExecStart pair) can take it.
    for (const pid of readFileSync(slotPids, "utf8").trim().split("\n")) process.kill(Number(pid));
    await vi.waitFor(() => expect(probe()).toBe(0), { timeout: 15_000 });
  });
});
