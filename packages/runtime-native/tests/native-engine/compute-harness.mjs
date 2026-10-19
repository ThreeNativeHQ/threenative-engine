// Shared by the PRD-620 player compute tests: bundles a JS game, runs it on the V8 player headless and returns
// the game's verdict line (COMPUTE_OK, COMPUTE_BAD ..., or COMPUTE_ERROR ...).
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function runComputeGame(executable, source, timeoutMs = 90_000) {
  const work = await mkdtemp(resolve(native, "build/player-compute-"));
  try {
    const entry = resolve(work, "game.ts");
    const outfile = resolve(work, "game.js");
    await writeFile(entry, source);
    await bundleNativeEngine({ entry, outfile, boot: false });
    const env = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIO_DRIVER: "dummy" };
    delete env.TN_PLAYTEST_MAILBOX_ROOT;
    const child = spawn(resolve(executable), [outfile], { env });
    let output = "";
    const pattern = /COMPUTE_(OK|BAD[^\n]*|ERROR[^\n]*)/u;
    const verdict = await new Promise((done) => {
      const timer = setTimeout(() => done("timeout"), timeoutMs);
      const read = (chunk) => {
        output += chunk;
        const match = output.match(pattern);
        if (match) {
          clearTimeout(timer);
          done(match[0]);
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("exit", () => {
        clearTimeout(timer);
        done(output.match(pattern)?.[0] ?? "exited");
      });
    });
    child.kill();
    return { verdict, output };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
