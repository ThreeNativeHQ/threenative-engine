// PRD-784: a PS4 run must not hang the runner. shadPS4 ran as its own session leader, so the runner's
// process-group kill missed it; it kept the runner's stdout pipe open and node waited for 2 h 20 min.
// This runs the real launch script with a fake emulator that leaves the group the same way.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeTempDirSync } from '../../../test-support/temp-dir.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = readFileSync(path.join(here, '..', 'scripts', 'ps4', 'run-experiment.mjs'), 'utf8');
// The template literal's only escape is \$, so this is the text sh receives.
const captureScript = /const CAPTURE_SCRIPT = `([\s\S]*?)`;/.exec(runner)[1].replaceAll('\\$', '$');

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (check()) return true;
  return check();
};

describe('PS4 E5 failure line', () => {
  it('keeps the guest error message, not only its token', () => {
    // The E5 entry's pattern, as the runner compiles it.
    const source = /failurePattern: (\/\(\?:TN_PLAYER_V8_GAME:[^\n]*\/),\n/.exec(runner)?.[1];
    expect(source).toBeDefined();
    const pattern = new Function(`return ${source}`)();
    const hit = pattern.exec('[stdout] x\nTN_PLAYER_V8_GAME: TypeError: mesh.skeleton is undefined\nnext');
    expect(hit?.[0]).toBe('TN_PLAYER_V8_GAME: TypeError: mesh.skeleton is undefined');
  });
});

describe('PS4 runner stop', () => {
  it('stops an emulator that left the process group', async () => {
    const dir = makeTempDirSync('tn-ps4-stop-');
    const pidFile = path.join(dir, 'emulator.pid');
    const fake = path.join(dir, 'fake-emulator.sh');
    writeFileSync(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec setsid sleep 300\n`);
    chmodSync(fake, 0o755);
    const child = spawn('sh', ['-c', captureScript, 'tn-ps4-launch', fake, '-g', 'eboot.bin', dir], {
      detached: true,
      env: { ...process.env, TN_PS4_HOST_WRAP: '' },
      stdio: 'ignore',
    });
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 5_000)).toBe(true);
    const emulator = Number(readFileSync(pidFile, 'utf8'));
    // The same signal the runner's stop() sends first: SIGTERM to the launch's process group.
    process.kill(-child.pid, 'SIGTERM');
    const stopped = await until(() => !alive(emulator), 5_000);
    if (!stopped) process.kill(emulator, 'SIGKILL');
    expect(stopped).toBe(true);
  }, 15_000);
});
