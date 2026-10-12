#!/usr/bin/env node
// A stand-in runner that attaches late. A host launched by a runner holds the game's boot until the
// runner's first request, so nothing may be presented before it: a loader frame there makes the
// first present carry the loader's settings (TN_PLAYER_TIMING, shadows off) and starts the render
// samples early. The host used to win that race whenever the runner was slower than its first step.
//
//   node verify-late-attach.mjs <delayMs> <host command...>     (under a display: sh scripts/xvfb.sh)
//
// Prints one JSON line and exits 1 when anything was presented before the attach. The host command
// must run with TN_PLAYER_METRICS=1 (the timing line is the evidence).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** GOOD when the first present came after the attach and its timing line shows the world. */
export function classifyAttach({ attachAtMs, firstPresentAtMs, shadowMapEnabled }) {
  if (firstPresentAtMs === undefined || attachAtMs === undefined) return "ERROR";
  return firstPresentAtMs >= attachAtMs && shadowMapEnabled === true ? "GOOD" : "BAD";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const [delayArg, ...command] = process.argv.slice(2);
  const delayMs = Number(delayArg);
  if (!Number.isFinite(delayMs) || command.length === 0)
    throw new Error("usage: verify-late-attach.mjs <delayMs> <host command...>");
  const root = mkdtempSync(join(tmpdir(), "late-attach-"));
  const request = join(root, "tn-playtest-request.json");
  const response = join(root, "tn-playtest-response.json");
  const child = spawn(command[0], command.slice(1), {
    detached: true,
    env: { ...process.env, TN_PLAYTEST_MAILBOX_ROOT: root, MYSTRAL_HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const launched = Date.now();
  const seen = { present: undefined, timing: undefined };
  const take = (chunk) => {
    out += chunk;
    if (seen.present === undefined && out.includes("TN_PLAYER_FIRST_PRESENT")) seen.present = Date.now() - launched;
    const timing = /TN_PLAYER_TIMING:(\{.*\})/.exec(out);
    if (timing && seen.timing === undefined) seen.timing = JSON.parse(timing[1]);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const waitResponse = async (id, limitMs) => {
    for (const end = Date.now() + limitMs; Date.now() < end; await sleep(5)) {
      if (!existsSync(response)) continue;
      let body;
      try {
        body = JSON.parse(readFileSync(response, "utf8"));
      } catch {
        continue;
      }
      rmSync(response, { force: true });
      if (body.id === id) return body;
    }
    return undefined;
  };
  const call = async (id, method) => {
    rmSync(response, { force: true });
    writeFileSync(`${request}.tmp`, JSON.stringify({ id, method }));
    renameSync(`${request}.tmp`, request);
    return waitResponse(id, 90_000);
  };
  const result = { delayMs };
  try {
    if (!(await waitResponse("ready", 60_000))) throw new Error("no ready handshake");
    await sleep(delayMs);
    result.attachAtMs = Date.now() - launched;
    await call("1", "describe");
    result.enteredMs = (await call("2", "ready"))?.result?.startup?.timeline?.enteredMs;
    for (let i = 0; i < 100 && seen.timing === undefined; i++) await sleep(50);
    result.firstPresentAtMs = seen.present;
    result.shadowMapEnabled = seen.timing?.shadowMapEnabled;
    result.firstFrameMs = seen.timing?.firstFrameMs;
    result.verdict = classifyAttach(result);
  } catch (error) {
    result.error = String(error);
    result.verdict = "ERROR";
  } finally {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try {
        process.kill(-child.pid, signal);
      } catch {}
      await sleep(500);
    }
    rmSync(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.verdict === "GOOD" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
