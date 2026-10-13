// Real keyboard and mouse on the packaged Midway engine player, proven from the game's own state.
//
//   node scripts/midway-bench/real-input.mjs <packaged-midway-dir> [--no-wm]
//
// Runs the product launcher (<dir>/play.sh, else <dir>/midway) on its own Xvfb with kwin_x11 as the window
// manager, so the focus rules are a desktop's. xdotool sends real X11 events (XTEST) to the player window:
// a click on the HUD's "Take the deck" button, W held, ArrowDown, C, Escape and a right-button drag. The
// playtest mailbox is used only to advance ticks and to READ state (`state` resource and the scene's
// camera), never to inject input, so a pass means the window's events reached the game.
// Exit 0 on pass; 1 with the failed expectation. Never touches the user's display.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const xvfb = resolve(here, "../../packages/runtime-native/scripts/xvfb.sh");
const args = process.argv.slice(2);
const packageDir = args.find((a) => !a.startsWith("--"));
if (!packageDir) {
  console.error("usage: real-input.mjs <packaged-midway-dir> [--no-wm]");
  process.exit(2);
}
// The player needs a display of its own: re-run this script under a virtual one.
if (!process.env.DISPLAY || process.env.TN_REAL_INPUT_INNER !== "1") {
  const env = Object.fromEntries([
    ...Object.entries(process.env).filter(([name]) => name !== "DISPLAY"),
    ["TN_REAL_INPUT_INNER", "1"],
    ["TN_XVFB_SCREEN", "1400x900x24"],
  ]);
  const run = spawnSync("sh", [xvfb, process.execPath, fileURLToPath(import.meta.url), ...args], {
    env,
    stdio: "inherit",
  });
  process.exit(run.status ?? 1);
}

if (process.env.DISPLAY === ":0") throw new Error("refusing to drive the user display :0");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const x = (...cmd) => spawnSync("xdotool", cmd.map(String), { encoding: "utf8" }).stdout.trim();
const work = mkdtempSync(join(tmpdir(), "midway-real-input-"));
const mailbox = join(work, "mailbox");
mkdirSync(mailbox);
const request = join(mailbox, "tn-playtest-request.json");
const response = join(mailbox, "tn-playtest-response.json");
const children = [];
const stop = () => {
  for (const child of children) child.kill();
  rmSync(work, { force: true, recursive: true });
};
process.once("exit", stop);

let output = "";
const launcher = ["play.sh", "midway"].map((n) => join(resolve(packageDir), n)).find(existsSync);
if (!launcher) throw new Error(`no play.sh or midway launcher in ${packageDir}`);
if (!args.includes("--no-wm")) {
  const wm = spawn("kwin_x11", [], { stdio: "ignore" });
  children.push(wm);
  await sleep(3000);
}
const player = spawn(launcher, [], {
  env: Object.fromEntries([
    ...Object.entries(process.env),
    ["TN_PLAYTEST_MAILBOX_ROOT", mailbox],
    ["TN_PLAYER_WIDTH", "1280"],
    ["TN_PLAYER_HEIGHT", "720"],
  ]),
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(player);
player.stdout.on("data", (c) => {
  output += c;
});
player.stderr.on("data", (c) => {
  output += c;
});

let nextId = 0;
async function call(method, argument, timeoutMs = 120_000) {
  const id = String(++nextId);
  const tmp = `${request}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ id, method, ...(argument === undefined ? {} : { argument }) }),
  );
  renameSync(tmp, request);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(response)) {
      const text = readFileSync(response, "utf8");
      if (text.includes(`"id":"${id}"`)) {
        unlinkSync(response);
        const frame = JSON.parse(text);
        if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
        return frame.result;
      }
    }
    if (player.exitCode !== null || player.signalCode !== null)
      throw new Error(`player exited during ${method}:\n${output.slice(-1500)}`);
    await sleep(25);
  }
  throw new Error(`${method} timed out:\n${output.slice(-1500)}`);
}
const sample = async () => {
  const snapshot = await call("sample", {
    resources: ["state"],
    sceneNodes: [{ type: "PerspectiveCamera", limit: 4 }],
  });
  return snapshot;
};

const failures = [];
const expect = (ok, what, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` (${detail})`}`);
  if (!ok) failures.push(what);
};
const quaternionAngle = (a, b) =>
  2 * Math.acos(Math.min(1, Math.abs(a.reduce((sum, v, i) => sum + v * b[i], 0))));
const look = (snapshot) => snapshot.entities.find((e) => e.id === "camera.main").transform.rotation;
// Ticks, in 60-tick slices, until the state satisfies `done`, so a slow host only waits longer.
async function until(label, done, ticks = 60, limit = 40) {
  for (let i = 0; i < limit; i += 1) {
    await call("advance", ticks);
    const snapshot = await sample();
    if (done(snapshot.resources.state, snapshot)) return snapshot;
  }
  failures.push(`never reached: ${label}`);
  console.log(`FAIL never reached: ${label}`);
  return sample();
}
const windowId = () => {
  for (const id of x("search", "--onlyvisible", "--name", "MIDWAY").split("\n").filter(Boolean)) {
    const geometry = x("getwindowgeometry", "--shell", id);
    if (/WIDTH=1280/.test(geometry) && /HEIGHT=720/.test(geometry)) return id;
  }
  return undefined;
};

try {
  for (
    let i = 0;
    i < 600 && !(existsSync(response) && /"id":"ready"/.test(readFileSync(response, "utf8")));
    i += 1
  )
    await sleep(100);
  if (existsSync(response)) unlinkSync(response);
  await call("describe");
  const briefing = await until(
    "the briefing screen",
    (state) => state.ui.screens.briefing === true,
  );
  const win = windowId();
  expect(win !== undefined, "the player window is on the display", win);
  x("windowfocus", win);
  await sleep(500);

  // 1. A click on the HUD's button, by the real pointer: the page takes it and the game enters flight.
  x("mousemove", "--window", win, Math.round(1280 * 0.149), Math.round(720 * 0.831));
  await sleep(300);
  x("mousedown", 1);
  await sleep(250);
  x("mouseup", 1);
  await sleep(300);
  const flight = await until(
    "the flight screen after a real click on the HUD",
    (state) => state.ui.screens.flight === true,
  );
  expect(
    flight.resources.state.ui.screens.flight === true,
    "a real click on the HUD button starts the flight",
  );

  // 2. Keys after that click, with no refocus: W is held, the deck run starts.
  x("keydown", "w");
  await sleep(500);
  const rolling = await until("airspeed rising under a held W", (state) => state.ias >= 50);
  expect(
    rolling.resources.state.ias >= 50,
    "a held W raises airspeed",
    `ias ${rolling.resources.state.ias}, throttle ${rolling.resources.state.throttle}`,
  );
  expect(
    rolling.resources.state.throttle > 0.5,
    "a held W raises the throttle",
    String(rolling.resources.state.throttle),
  );

  // 3. ArrowDown lifts the nose at speed: the aircraft leaves the deck.
  x("keydown", "Down");
  await sleep(300);
  await call("advance", 45);
  x("keyup", "Down");
  x("keyup", "w");
  await sleep(300);
  const climbing = await until(
    "airborne after W and ArrowDown",
    (state) => state.airborne === true && state.altitude >= 40,
    120,
    20,
  );
  expect(
    climbing.resources.state.airborne === true && climbing.resources.state.altitude >= 40,
    "W then ArrowDown takes the aircraft off the deck",
    `altitude ${climbing.resources.state.altitude}`,
  );

  // 4. ArrowUp pushes the nose down: less altitude than the same time with the stick free.
  const before = (await sample()).resources.state.altitude;
  await call("advance", 90);
  const free = (await sample()).resources.state.altitude - before;
  const start = (await sample()).resources.state.altitude;
  x("keydown", "Up");
  await sleep(300);
  await call("advance", 90);
  x("keyup", "Up");
  await sleep(300);
  const pushed = (await sample()).resources.state.altitude - start;
  expect(
    pushed < free - 1,
    "a held ArrowUp changes the climb against a free stick",
    `free ${free} m, ArrowUp ${pushed} m`,
  );

  // 5. C changes the camera: the cockpit view.
  const chase = (await sample()).resources.state;
  x("key", "c");
  await sleep(300);
  const cockpit = await until(
    "the cockpit view after C",
    (state) => state.ui.cockpit === true,
    10,
    10,
  );
  expect(
    chase.ui.cockpit === false && cockpit.resources.state.ui.cockpit === true,
    "C switches to the cockpit view",
  );

  // 6. A right-button drag turns the pilot's head: the camera's rotation changes while the button is held.
  const rest = look(await sample());
  x("mousemove", "--window", win, 640, 360);
  await sleep(300);
  x("mousedown", 3);
  await sleep(300);
  await call("advance", 6);
  for (let step = 1; step <= 4; step += 1) {
    x("mousemove_relative", "--", 40, 0);
    await sleep(250);
    await call("advance", 6);
  }
  const turned = look(await sample());
  x("mouseup", 3);
  const angle = quaternionAngle(rest, turned);
  expect(angle > 0.15, "a right-button drag turns the cockpit camera", `${angle.toFixed(3)} rad`);

  // 7. Escape opens the pause overlay and a second Escape closes it.
  x("key", "Escape");
  await sleep(300);
  const paused = await until(
    "the pause overlay after Escape",
    (state) => state.ui.overlay !== null,
    10,
    10,
  );
  expect(
    paused.resources.state.ui.overlay !== null,
    "Escape opens the pause overlay",
    String(paused.resources.state.ui.overlay),
  );
  x("key", "Escape");
  await sleep(300);
  const resumed = await until(
    "the overlay closed by Escape",
    (state) => state.ui.overlay === null,
    10,
    10,
  );
  expect(resumed.resources.state.ui.overlay === null, "a second Escape closes it");
} catch (error) {
  failures.push(error instanceof Error ? error.message.split("\n")[0] : String(error));
  console.log(`FAIL ${failures[failures.length - 1]}`);
} finally {
  stop();
}
console.log(failures.length === 0 ? "REAL INPUT PASS" : `REAL INPUT FAIL: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
