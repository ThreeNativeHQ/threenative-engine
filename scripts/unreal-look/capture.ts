/**
 * `pnpm unreal-look:capture` — renders the PRD-631 reference cells.
 *
 *   --engine unreal        build the levels (template-actors.json), then render every cell
 *                          through Movie Render Queue: a PNG and a scene-linear EXR per cell.
 *                          Needs UE_ROOT (an installed Unreal 5.8.3).
 *     --check-cvars        only resolve every console variable in layers.json; exit 1 on a miss
 *     --dump-actors        only build the levels and write template-actors.json
 *   --engine threenative   scaffold the starter and capture the same cells headed on WebGPU
 *                          The browser opens on its own private Xvfb, whatever DISPLAY the shell exports
 *                          (browser.ts). TN_PLAYTEST_HOST_DISPLAY=1 opens it on the session display instead.
 *     --reuse              keep the scaffold and its install; re-copy the template source
 *     --baseline           skip scripts/unreal-look/scaffold/render/ (the template look as shipped)
 *     --measure <seconds>  hold each cell that long and write its TN_FRAME_BUDGET log (read it with
 *                          `playtest perf --file`); no screenshot
 *     --size 1920x1080     viewport override (the cells use poses.json's 1280x720); set TN_XVFB_SCREEN that large
 *     --off vsm,gpusky,...   L9 stage ablation: vsm gpusky clouds gi reflcap bloom localexposure autoexposure ssgi ssr gtao vignette motionblur stockbloom
 *   --layers L0,L1,ID      limit the layers (default: every layer plus the region-id frames)
 *   --cells sun60/exterior limit the (sun, pose) cells
 *   --scene gi[:<name>,...] a PRD-638 GI calibration scene instead (flags: scripts/unreal-look/gi.ts)
 *     --motion pan|switch  its motion run, frame by frame (both engines; scripts/unreal-look/motion-run.ts)
 *   --out <dir>            default tools/unreal-reference/captures/<engine>
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { captureGiThreeNative } from "./capture-gi-threenative.js";
import { captureThreeNative } from "./capture-threenative.js";
import { captureGi, familyOf, registry, sceneNames } from "./gi.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REFERENCE = path.join(REPO_ROOT, "tools/unreal-reference");

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function layerNames(): string[] {
  const layers = JSON.parse(readFileSync(path.join(REFERENCE, "layers.json"), "utf8")) as {
    layers: { name: string }[];
  };
  return [...layers.layers.map((layer) => layer.name), "ID"];
}

/** Runs the editor headless on build_level.py in one mode and returns the script's own exit code. */
export async function runUnreal(
  mode: string,
  out: string,
  env: Record<string, string> = {},
): Promise<number> {
  const ueRoot = process.env.UE_ROOT;
  if (ueRoot === undefined)
    throw new Error("TN_UNREAL_LOOK_NO_UE: set UE_ROOT to an installed Unreal 5.8.3");
  const editor = path.join(ueRoot, "Engine/Binaries/Linux/UnrealEditor");
  if (!existsSync(editor)) throw new Error(`TN_UNREAL_LOOK_NO_UE: ${editor} not found`);
  await mkdir(out, { recursive: true });
  const exitFile = path.join(out, `${mode}.exit`);
  await rm(exitFile, { force: true });
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      editor,
      [
        path.join(REFERENCE, "ThreeNativeReference.uproject"),
        "-RenderOffscreen",
        "-unattended",
        "-nosplash",
        "-nosound",
        "-stdout",
        "-FullStdOutLogOutput",
        // -ExecutePythonScript quits the editor when the script returns; a Movie Render Queue
        // run needs the editor to keep ticking, so the script runs as a console command.
        `-ExecCmds=py ${path.join(REFERENCE, "build_level.py")}`,
      ],
      {
        env: { ...process.env, ...env, TN_UE_MODE: mode, TN_UE_OUT: out },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("exit", resolve);
  });
  // The editor's own exit status says nothing about the script; the script writes its verdict.
  if (!existsSync(exitFile))
    throw new Error(`TN_UNREAL_LOOK_UE_CRASH: ${mode} wrote no verdict (editor exit ${code})`);
  return Number(readFileSync(exitFile, "utf8"));
}

function countFiles(root: string, extension: string): number {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true }))
    if (entry.isFile() && entry.name.endsWith(extension)) count += 1;
  return count;
}

export async function main(args: readonly string[]): Promise<number> {
  const engine = flag(args, "--engine");
  if (engine !== "unreal" && engine !== "threenative")
    throw new Error("TN_UNREAL_LOOK_BAD_INPUT: --engine unreal|threenative");
  const out = path.resolve(flag(args, "--out") ?? path.join(REFERENCE, "captures", engine));
  const known = layerNames();
  const layers = (flag(args, "--layers")?.split(",") ?? known).filter(Boolean);
  // A calibration scene names its own layers (`GI_LAYERS`, validated where it captures).
  for (const layer of flag(args, "--scene") === undefined ? layers : [])
    if (!known.includes(layer)) throw new Error(`TN_UNREAL_LOOK_BAD_INPUT: unknown layer ${layer}`);
  const cellsFlag = flag(args, "--cells");
  const cells = cellsFlag === undefined ? undefined : new Set(cellsFlag.split(","));

  if (engine === "unreal" && flag(args, "--scene") !== undefined) return captureGi(args, runUnreal);
  if (engine === "threenative" && flag(args, "--scene") !== undefined) {
    const value = flag(args, "--scene") ?? "gi";
    const known = registry(familyOf(value)).scenes.map((s) => s.name);
    const motion = flag(args, "--motion");
    const count = await captureGiThreeNative({
      scenes: sceneNames(value, known),
      // A motion run is drawn at L7 only: its ID frames are Unreal's, the same camera.
      layers:
        flag(args, "--layers")?.split(",") ??
        (motion !== undefined
          ? ["L7"]
          : familyOf(value) === "shadow"
            ? ["ID", "L5", "L9"]
            : ["ID", "L1", "L7"]),
      ...(motion === undefined ? {} : { motion }),
      out: path.resolve(flag(args, "--out") ?? path.join(REFERENCE, "captures", "threenative")),
      reuse: args.includes("--reuse"),
      ...(flag(args, "--measure") ? { measureSeconds: Number(flag(args, "--measure")) } : {}),
    });
    return count > 0 ? 0 : 1;
  }
  if (engine === "threenative") {
    const count = await captureThreeNative({
      out,
      layers,
      cells,
      reuse: args.includes("--reuse"),
      baseline: args.includes("--baseline"),
      ...(flag(args, "--measure") ? { measureSeconds: Number(flag(args, "--measure")) } : {}),
      ...(flag(args, "--size")
        ? { size: flag(args, "--size")?.split("x").map(Number) as [number, number] }
        : {}),
      ...(flag(args, "--off") ? { off: flag(args, "--off") } : {}),
    });
    console.info(`TN_UNREAL_LOOK threenative cells=${count} out=${out}`);
    return count > 0 ? 0 : 1;
  }

  if (args.includes("--check-cvars")) return runUnreal("check-cvars", out);
  if (args.includes("--dump-actors") || !existsSync(path.join(REFERENCE, "Content/Reference"))) {
    // The build creates every level and sequence from scratch; old assets would block it.
    await rm(path.join(REFERENCE, "Content/Reference"), { recursive: true, force: true });
    if ((await runUnreal("build", out)) !== 0) return 1;
  }
  if (args.includes("--dump-actors")) return 0;
  // One editor per layer: a single editor rendering every layer ran out of video memory on an
  // 8 GB card at the third job, because Lumen and the virtual shadow pages are not released
  // between Movie Render Queue jobs.
  let code = 0;
  for (const layer of layers) {
    const env = { TN_UE_LAYERS: layer, ...(cellsFlag ? { TN_UE_CELLS: cellsFlag } : {}) };
    code = Math.max(code, await runUnreal("capture", out, env));
  }
  console.info(
    `TN_UNREAL_LOOK unreal png=${countFiles(out, ".png")} exr=${countFiles(out, ".exr")} out=${out}`,
  );
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
