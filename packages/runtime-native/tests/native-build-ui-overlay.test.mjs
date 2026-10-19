import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'vitest';

import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import { uiOverlayLibraryName } from '../scripts/build-native-ui-overlay.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

// The host toolchain names its static library; the C++ build must ask for the right one rather
// than guessing `.a` on MSVC. This is the one part of the mapping testable without the hosts.
test('the overlay library is named for the host toolchain', () => {
  assert.equal(uiOverlayLibraryName('linux'), 'libthreenative_ui_overlay.a');
  assert.equal(uiOverlayLibraryName('darwin'), 'libthreenative_ui_overlay.a');
  assert.equal(uiOverlayLibraryName('win32'), 'threenative_ui_overlay.lib');
});

// Runs on every desktop host that can execute the plan with shell stubs. The Windows host's
// library name is covered by the mapping test above and by the hosted `native:build` job; the
// shape asserted here (overlay built, `TN_ENABLE_UI_OVERLAY=ON`, host-named library) is the same
// on all three, which is what phase 3A requires the normal build to do per host.
test.runIf(process.platform === 'linux' || process.platform === 'darwin')(
  `the ${process.platform} native build links the desktop UI overlay into the runtime`,
  () => {
    const preset = process.platform === 'darwin' ? 'tn-macos' : 'tn-linux';
    const root = makeTempDirSync('threenative-native-build-plan-#% ');
    roots.push(root);
    const scripts = join(root, 'scripts');
    const bin = join(root, 'bin');
    const log = join(root, 'commands.log');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(bin, { recursive: true });
    // The real plan and the real overlay build, so the library path asserted below is the one the
    // script derives rather than one the test wrote. The CSS builder and desktop profile helpers
    // are copied too because the merged native build imports them before selecting the plan.
    for (const name of [
      'native-build.mjs',
      'build-native-ui-overlay.mjs',
      'build-native-css-ui.mjs',
      'native-test-lane.mjs',
      'desktop-build-profile.mjs',
    ]) {
      copyFileSync(
        new URL(`../scripts/${name}`, import.meta.url),
        join(scripts, name),
      );
    }
    writeFileSync(
      join(scripts, 'build-native-physics.mjs'),
      'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.TN_TEST_LOG, "build-native-physics.mjs\\n");\n',
    );
    executable(
      join(bin, 'cargo'),
      '#!/bin/sh\nprintf "cargo %s\\n" "$*" >> "$TN_TEST_LOG"\nexit 0\n',
    );
    executable(
      join(bin, 'cmake'),
      '#!/bin/sh\nprintf "cmake %s\\n" "$*" >> "$TN_TEST_LOG"\n',
    );
    executable(join(bin, 'ninja'), '#!/bin/sh\nexit 0\n');
    executable(
      join(bin, 'rustc'),
      '#!/bin/sh\nprintf "host: x86_64-unknown-linux-gnu\\n"\n',
    );

    const result = spawnSync(process.execPath, [join(scripts, 'native-build.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        TN_TEST_LOG: log,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = readFileSync(log, 'utf8');
    assert.match(commands, /cargo build --release --manifest-path .*native\/ui-overlay\/Cargo\.toml --lib/u);
    assert.match(commands, new RegExp(`cmake --preset ${preset} .*?-DTN_ENABLE_UI_OVERLAY=ON`, 'u'));
    assert.match(
      commands,
      /-DTHREENATIVE_UI_OVERLAY_LIBRARY=.*libthreenative_ui_overlay\.a/u,
    );
    assert.doesNotMatch(commands, /TN_ENABLE_CSS_UI/u);

    // The CSS UI backend is opt-in, and opting in has to build the crate before CMake asks for it —
    // otherwise the configure fails naming a static library nobody compiled.
    const opted = spawnSync(process.execPath, [join(scripts, 'native-build.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        TN_TEST_LOG: log,
        TN_ENABLE_CSS_UI: '1',
      },
    });
    assert.equal(opted.status, 0, opted.stderr);
    const optedCommands = readFileSync(log, 'utf8');
    assert.match(
      optedCommands,
      /cargo build --release --manifest-path .*native\/css-ui\/Cargo\.toml --lib/u,
    );
    assert.match(optedCommands, /-DTN_ENABLE_CSS_UI=ON/u);
    assert.match(
      optedCommands,
      /-DTHREENATIVE_CSS_UI_LIBRARY=.*libthreenative_css_ui\.a/u,
    );

    // `TN_ENABLE_UI_OVERLAY=0` is the opt-out that makes the CSS UI the only UI: a host with no
    // web view in it at all. It must not build the overlay crate on the way to saying so, because
    // on Linux that build is the step that needs webkit2gtk.
    const withoutOverlayLog = join(root, 'without-overlay.log');
    const withoutOverlay = spawnSync(process.execPath, [join(scripts, 'native-build.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        TN_TEST_LOG: withoutOverlayLog,
        TN_ENABLE_UI_OVERLAY: '0',
        TN_ENABLE_CSS_UI: '1',
      },
    });
    assert.equal(withoutOverlay.status, 0, withoutOverlay.stderr);
    const withoutOverlayCommands = readFileSync(withoutOverlayLog, 'utf8');
    assert.doesNotMatch(
      withoutOverlayCommands,
      /native\/ui-overlay\/Cargo\.toml/u,
      'the web overlay crate must not be built',
    );
    assert.doesNotMatch(withoutOverlayCommands, /THREENATIVE_UI_OVERLAY_LIBRARY/u);
    assert.match(withoutOverlayCommands, /-DTN_ENABLE_UI_OVERLAY=OFF/u);
    // The CSS UI is still there — that is the point of the opt-out.
    assert.match(
      withoutOverlayCommands,
      /cargo build --release --manifest-path .*native\/css-ui\/Cargo\.toml --lib/u,
    );
    assert.match(withoutOverlayCommands, /-DTN_ENABLE_CSS_UI=ON/u);
  },
);

for (const present of [false, true]) {
  test(`overlay --check ${present ? 'reports the library' : 'fails closed'} in a path with URL-reserved characters`, () => {
    const root = makeTempDirSync('threenative-overlay-check-#% ');
    roots.push(root);
    const scripts = join(root, 'scripts');
    mkdirSync(scripts, { recursive: true });
    const script = join(scripts, 'build-native-ui-overlay.mjs');
    copyFileSync(new URL('../scripts/build-native-ui-overlay.mjs', import.meta.url), script);
    const release = join(root, 'native', 'ui-overlay', 'target', 'release');
    if (present) {
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, uiOverlayLibraryName()), 'static library fixture');
    }
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, present ? 0 : 1, result.stderr);
    if (present) assert.match(result.stdout, /ThreeNative UI overlay:/u);
    else assert.match(result.stderr, /TN_UI_OVERLAY_MISSING:/u);
  });
}
