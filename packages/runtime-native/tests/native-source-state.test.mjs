import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import { currentSourceState } from '../scripts/profile-production.mjs';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = makeTempDirSync('native-source-eol-'); roots.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
  git('init', '-q'); git('config', 'user.email', 'ci@example.invalid'); git('config', 'user.name', 'CPU fixture'); git('config', 'core.autocrlf', 'true');
  writeFileSync(join(root, '.gitattributes'), readFileSync(new URL('../../../.gitattributes', import.meta.url)));
  const name = 'packages/core/src/source with spaces.ts';
  const file = join(root, name);
  mkdirSync(join(root, 'packages/core/src'), { recursive: true }); writeFileSync(file, 'export const version = "0.1.0";\n');
  git('add', '.'); git('commit', '-qm', 'source fixture'); rmSync(file); git('checkout', '--', name);
  return { root, file, name, git, sha: git('rev-parse', 'HEAD') };
}
test('proves Git normalized candidate bytes for CRLF checkout rewritten as LF and retains both identities', async () => {
  const f = fixture(); assert.ok(readFileSync(f.file, 'utf8').includes('\r\n'));
  writeFileSync(f.file, 'export const version = "0.1.0";\n');
  assert.match(f.git('status', '--porcelain'), / M /); assert.equal(f.git('diff', 'HEAD'), '');
  const state = await currentSourceState(f.root);
  assert.equal(state.sha, f.sha); assert.equal(state.dirty, false); assert.match(state.rawStatus, / M /);
  assert.equal(state.normalizedTrackedFiles.length, 1);
  assert.equal(state.normalizedTrackedFiles[0].headBlob, state.normalizedTrackedFiles[0].worktreeBlob);
  assert.match(state.normalizedTrackedFiles[0].rawSha256, /^[a-f0-9]{64}$/);
});
test.each(['content', 'staged', 'deleted', 'renamed', 'untracked', 'mode', 'symlink'])('keeps real %s source changes dirty', async (kind) => {
  const f = fixture();
  if (kind === 'content' || kind === 'staged') writeFileSync(f.file, 'export const version = "changed";\n');
  if (kind === 'staged') f.git('add', f.name);
  if (kind === 'deleted') rmSync(f.file);
  if (kind === 'renamed') { renameSync(f.file, `${f.file}.renamed`); f.git('add', '-A'); }
  if (kind === 'untracked') writeFileSync(join(f.root, 'unexpected-source.ts'), 'unexpected source');
  if (kind === 'mode') chmodSync(f.file, 0o755);
  if (kind === 'symlink') { rmSync(f.file); symlinkSync('.gitattributes', f.file); }
  const state = await currentSourceState(f.root); assert.equal(state.dirty, true); assert.equal(state.sha, f.sha);
});

test.each(['next-file', 'final-status'])('rejects real content mutation at the %s snapshot boundary', async (boundary) => {
  const f = fixture(); const second = 'packages/core/src/zz-second.ts';
  writeFileSync(join(f.root, second), 'export const second = true;\n'); f.git('add', second); f.git('commit', '-qm', 'second source');
  rmSync(join(f.root, second)); f.git('checkout', '--', second);
  writeFileSync(f.file, 'export const version = "0.1.0";\n'); writeFileSync(join(f.root, second), 'export const second = true;\n');
  const execute = promisify(execFile); let statuses = 0;
  const state = await currentSourceState(f.root, async (command, args, options) => {
    if (args.includes('status')) statuses++;
    if ((boundary === 'next-file' && args.includes('ls-tree') && args.includes(second)) ||
        (boundary === 'final-status' && args.includes('status') && statuses === 2))
      writeFileSync(f.file, 'export const version = "changed during proof";\n');
    return execute(command, args, options);
  });
  assert.equal(state.dirty, true);
});
test('rejects meaningful raw changes concealed by a Git clean filter', async () => {
  const f = fixture();
  writeFileSync(join(f.root, '.gitattributes'), `${readFileSync(join(f.root, '.gitattributes'), 'utf8')}\n*.ts filter=drop-token\n`);
  f.git('config', 'filter.drop-token.clean', "sed 's/ATTACK//g'"); f.git('add', '.gitattributes'); f.git('commit', '-qm', 'filter fixture');
  writeFileSync(f.file, 'export const version = "0.1.0";ATTACK\n');
  assert.equal(f.git('diff', 'HEAD'), '');
  assert.equal((await currentSourceState(f.root)).dirty, true);
});

test.each(['untracked', 'head'])('rejects late %s changes during final diff verification', async (kind) => {
  const f = fixture(); writeFileSync(f.file, 'export const version = "0.1.0";\n');
  const execute = promisify(execFile); let diffs = 0;
  const state = await currentSourceState(f.root, async (command, args, options) => {
    if (args.includes('diff')) diffs++;
    if (args.includes('diff') && diffs === 2) {
      writeFileSync(join(f.root, 'late-source.ts'), 'late source');
      if (kind === 'head') { f.git('add', 'late-source.ts'); f.git('commit', '-qm', 'changed candidate'); }
    }
    return execute(command, args, options);
  });
  assert.equal(state.dirty, true); assert.equal(state.sha, f.sha);
});
