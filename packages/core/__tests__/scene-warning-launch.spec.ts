import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SCENE_WARNING = "TN_SCENE_WARNING";

/**
 * A production launch cannot be reached from inside vitest, where `import.meta.env` is always the
 * bundler's dev value and a dynamic import of the build is transformed by the same pipeline. A
 * separate node process loading the built package is the honest stand-in, exactly as
 * `debug.spec.ts` does for `exposeDebug`: the same plain ESM file the native bundle is, with no
 * `import.meta.env` and only the `process.env` a host publishes.
 */
const dist = pathToFileURL(path.resolve("packages/core/dist/index.js")).href;

/**
 * The stub game, identical in both launches: 158 draws and 1,815 triangles per draw, with 1.9 ms of
 * GPU inside a render phase longer than the 60 Hz period the game declares. That is the shape the
 * verdict names, so a launch that prints nothing did so because it did not ask for one.
 */
const GAME = String.raw`
{
  class Empty extends core.Scene {
    static initialState = {};
  }
  const warned = [];
  const originals = new Map();
  for (const method of ["debug", "info", "log", "warn"]) {
    originals.set(method, console[method]);
    console[method] = (...args) => {
      if (method === "warn") warned.push(args.map((arg) => String(arg)).join(" "));
    };
  }
  const canvas = new EventTarget();
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 1080 },
    clientWidth: { configurable: true, value: 2400 },
    parentElement: { configurable: true, value: null },
  });
  const info = { frame: 0, render: { calls: 3, timestamp: 1.9, triangles: 30_000 } };
  const raw = {
    backend: { getTimestampFrames: (kind) => (kind === "render" ? [info.frame] : undefined) },
    domElement: canvas,
    info,
    render: () => {
      info.render.calls += 158;
      info.render.triangles += 287_000;
      const until = performance.now() + 20;
      while (performance.now() < until) {
        // A render phase longer than the display's own period: the shape the verdict names.
      }
    },
    setSize: () => undefined,
  };
  let frame;
  const requestFrame = globalThis.requestAnimationFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback) => {
      frame = callback;
      return 1;
    },
  });
  const game = core.defineGame({
    display: { maxFps: 60 },
    frameBudget: { reportEvery: 1 },
    renderer: { canvas, preferWebGPU: false, webgl2Factory: () => raw },
    scenes: { test: Empty },
    start: "test",
  });
  try {
    await game.start();
    if (frame === undefined) throw new Error("the stub game never asked for a frame");
    const started = performance.now();
    for (let index = 1; index <= 6; index += 1) frame(started + index * 16.7);
  } finally {
    game.stop();
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: requestFrame,
    });
    for (const [method, original] of originals) console[method] = original;
  }
  process.stdout.write("LAUNCH " + JSON.stringify({ warned }) + "\n");
}
`;

/**
 * One launch of the stub game, with the dev surfaces on when `DEV_MODE` asks for them.
 *
 * `DEV_MODE` is the one environment flag the native host publishes into a game, so this is the
 * same question a native playtest asks; leaving it out is a production build run from the shell.
 */
function launch(devMode: string | undefined): readonly string[] {
  // The shell's own value must not decide the arm under test, so it is rebuilt rather than patched.
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name !== "DEV_MODE") env[name] = value;
  }
  if (devMode !== undefined) env.DEV_MODE = devMode;
  const printed = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const core = await import(${JSON.stringify(dist)});\n${GAME}`],
    { encoding: "utf8", env },
  );
  const line = printed.split("\n").find((entry) => entry.startsWith("LAUNCH "));
  if (line === undefined) throw new Error(`the stub game printed no result:\n${printed}`);
  return (JSON.parse(line.slice("LAUNCH ".length)) as { warned: readonly string[] }).warned;
}

describe("scene warning launch", () => {
  it("prints the scene warning from a debug launch", () => {
    const warned = launch("1");

    expect(warned.some((entry) => entry.startsWith(`${SCENE_WARNING}:`))).toBe(true);
  });

  it("prints nothing from a production launch", () => {
    expect(launch(undefined)).toEqual([]);
  });
});
