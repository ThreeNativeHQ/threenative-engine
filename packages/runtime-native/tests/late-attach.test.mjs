import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { classifyAttach } from "../scripts/verify-late-attach.mjs";

const script = fileURLToPath(new URL("../scripts/verify-late-attach.mjs", import.meta.url));

// A stand-in host: announces ready, then presents either at once (the old race) or only after the
// runner's first request is consumed (a held boot). The real host binaries are proven by the lane.
const host = (holdsForRunner) => `
const fs = require("node:fs");
const root = process.env.TN_PLAYTEST_MAILBOX_ROOT;
const request = root + "/tn-playtest-request.json";
const response = root + "/tn-playtest-response.json";
const timing = '{"shadowMapEnabled":' + ${holdsForRunner} + ',"firstFrameMs":10}';
fs.writeFileSync(response, '{"id":"ready","result":null}');
const present = () => console.log("TN_PLAYER_FIRST_PRESENT: runtime stub\\nTN_PLAYER_TIMING:" + timing);
if (!${holdsForRunner}) present();
setInterval(() => {
  if (!fs.existsSync(request)) return;
  const { id } = JSON.parse(fs.readFileSync(request, "utf8"));
  fs.rmSync(request);
  if (${holdsForRunner} && id === "1") present();
  fs.writeFileSync(response, JSON.stringify({ id, result: { startup: { timeline: { enteredMs: 0 } } } }));
}, 5);
setTimeout(() => process.exit(0), 20000);
`;

const attach = (holdsForRunner) => {
  const run = spawnSync(process.execPath, [script, "300", process.execPath, "-e", host(holdsForRunner)], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: run.status, result: JSON.parse(run.stdout.trim().split("\n").at(-1)) };
};

test("classifies a present before the attach as BAD", () => {
  expect(classifyAttach({ attachAtMs: 500, firstPresentAtMs: 100, shadowMapEnabled: false })).toBe("BAD");
  expect(classifyAttach({ attachAtMs: 500, firstPresentAtMs: 600, shadowMapEnabled: true })).toBe("GOOD");
  expect(classifyAttach({ attachAtMs: 500 })).toBe("ERROR");
});

test("fails a host that presents before its runner attaches and passes one that holds", () => {
  const early = attach(false);
  assert.equal(early.result.verdict, "BAD");
  assert.equal(early.status, 1);
  const held = attach(true);
  assert.equal(held.result.verdict, "GOOD");
  assert.equal(held.status, 0);
});
