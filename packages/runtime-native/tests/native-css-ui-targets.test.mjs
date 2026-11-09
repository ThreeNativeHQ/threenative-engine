import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

test('native CSS UI builder selects the PS4 musl artifact (PRD-784)', () => {
  const result = spawnSync(process.execPath, ['scripts/build-native-css-ui.mjs', '--ps4', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  // --check reports the artifact path whether or not it is built yet (stdout) or missing (stderr).
  assert.match(`${result.stdout}${result.stderr}`, /css-ui\/target\/x86_64-unknown-linux-musl\/release\/libthreenative_css_ui\.a/u);
});
