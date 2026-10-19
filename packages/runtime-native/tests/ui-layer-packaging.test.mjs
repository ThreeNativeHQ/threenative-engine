import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';

import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import {
  androidCssUiGradleArgs,
  mobileUiRenderer,
  renderAndroidManifest,
  stageAndroidUi,
} from '../scripts/package-android.mjs';
import { assertRuntimeHasCssUi, stageDesktopFiles, stageDesktopUi } from '../scripts/package-desktop.mjs';
import { stageIosUi } from '../scripts/package-ios.mjs';

const androidManifest = readFileSync(
  new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url),
  'utf8',
);
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temp(prefix) {
  const root = makeTempDirSync(prefix);
  roots.push(root);
  return root;
}

/** A game that never states a renderer must ship no overlay — acceptance criterion 5. */
test('an unstated ui.renderer packages as the native renderer', () => {
  const rendered = renderAndroidManifest(androidManifest, {});
  assert.match(rendered, /android:name="TN_UI_RENDERER" android:value="native"/u);
});

test('ui.renderer web is the only value that turns the overlay on', () => {
  const web = renderAndroidManifest(androidManifest, { ui: { renderer: 'web' } });
  assert.match(web, /android:name="TN_UI_RENDERER" android:value="web"/u);
  // Fail closed on a value nobody defined rather than guessing the expensive one.
  for (const renderer of ['native', 'webview', 'WEB', '']) {
    const rendered = renderAndroidManifest(androidManifest, { ui: { renderer } });
    assert.match(rendered, /android:name="TN_UI_RENDERER" android:value="native"/u);
  }
});

test('a native-renderer game stages no UI bundle at all', () => {
  const destination = join(temp('threenative-ui-none-'), 'ui');
  assert.deepEqual(stageAndroidUi(undefined, 'native', destination), []);
  assert.equal(existsSync(destination), false);
});

test('a UI bundle staged for a native-renderer game is a build failure', () => {
  const root = temp('threenative-ui-unexpected-');
  const ui = join(root, 'ui');
  mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html>');
  assert.throws(
    () => stageAndroidUi(ui, 'native', join(root, 'out')),
    /TN_UI_BUNDLE_UNEXPECTED/u,
  );
});

// The most expensive shape of wrong: an APK that installs, launches, and shows a blank overlay
// over a working game, with clean logs.
test('a web-renderer game with no built UI is a build failure, and so is one with no page', () => {
  const root = temp('threenative-ui-missing-');
  assert.throws(
    () => stageAndroidUi(undefined, 'web', join(root, 'out')),
    /TN_UI_BUNDLE_MISSING/u,
  );
  const ui = join(root, 'ui');
  mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, 'main.js'), 'export {};');
  assert.throws(() => stageAndroidUi(ui, 'web', join(root, 'out')), /TN_UI_BUNDLE_MISSING/u);
});

test('a web-renderer game stages its page and every asset beside it', () => {
  const root = temp('threenative-ui-staged-');
  const ui = join(root, 'ui');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><div id="tn-ui"></div>');
  writeFileSync(join(ui, 'assets', 'hud.css'), '.hud{color:#fff}');
  const destination = join(root, 'out');
  assert.deepEqual(stageAndroidUi(ui, 'web', destination), ['assets/hud.css', 'index.html']);
  assert.equal(existsSync(join(destination, 'index.html')), true);
  assert.equal(readFileSync(join(destination, 'assets', 'hud.css'), 'utf8'), '.hud{color:#fff}');
});

// The CSS renderer stages stylesheets the game's own JS realm paints, so the packaged `ui/` holds
// `ui/*.css` and none of the web page. It refuses a directory with no stylesheet rather than
// packaging a game that would launch with an unstyled HUD.
test('desktop stages a native-css UI as stylesheets and refuses a page-only one', () => {
  const root = temp('threenative-ui-desktop-css-');
  const ui = join(root, 'ui');
  mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, 'index-abc123.css'), '.hud{color:#fff}');

  const staged = join(root, 'out');
  assert.deepEqual(stageDesktopUi(ui, 'native-css', staged).sort(), ['index-abc123.css']);
  assert.equal(readFileSync(join(staged, 'index-abc123.css'), 'utf8'), '.hud{color:#fff}');

  assert.throws(() => stageDesktopUi(undefined, 'native-css', join(root, 'a')), /TN_UI_BUNDLE_MISSING/u);
  const page = join(root, 'page');
  mkdirSync(page, { recursive: true });
  writeFileSync(join(page, 'index.html'), '<div id="tn-ui"></div>');
  assert.throws(() => stageDesktopUi(page, 'native-css', join(root, 'b')), /TN_UI_BUNDLE_MISSING/u);
});

// The packager flattens `ui.renderer` for the C++ host's scanner, which cannot read the nested
// shape. "native-css" must survive that flattening or the host would never learn which renderer
// the staged stylesheets belong to.
test('the desktop packager flattens the native-css renderer into the staged config', () => {
  const root = temp('threenative-ui-desktop-config-');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ui: { renderer: 'native-css' } }));
  const bundle = join(root, 'game.bundle');
  writeFileSync(bundle, 'bundle');

  const entry = stageDesktopFiles(bundle, undefined, join(root, 'staging'), JSON.parse(readFileSync(configPath, 'utf8')));
  assert.ok(entry);
  const staged = JSON.parse(
    readFileSync(join(root, 'staging', '.threenative', 'config.json'), 'utf8'),
  );
  assert.equal(staged.uiRenderer, 'native-css');
});

// The CSS backend is an opt-in CMake flag, so the published prebuilt has no `css-ui` staticlib: a
// `native-css` game packaged against it would stage stylesheets and then paint nothing, with clean
// logs. The host names the rasteriser it was linked with, and that literal is the whole check.
test('a native-css game refuses a runtime built without the CSS backend', () => {
  const root = temp('threenative-css-ui-host-');
  const withBackend = join(root, 'mystral');
  const without = join(root, 'mystral-prebuilt');
  writeFileSync(withBackend, Buffer.concat([Buffer.alloc(4096), Buffer.from('blitz-dom 0.3 (CPU rasteriser, no WebView, no Chromium)')]));
  writeFileSync(without, Buffer.alloc(4096));

  assertRuntimeHasCssUi(withBackend);
  assert.throws(() => assertRuntimeHasCssUi(without), /TN_CSS_UI_HOST_MISSING[\s\S]*TN_ENABLE_CSS_UI=1/u);
});

// Mobile flattens `ui.renderer` to a string the host reads. `native-css` survives the flattening on
// Android, where the activity extracts its stylesheets for the runtime's CSS UI; it is never
// silently turned into `native`, which would launch a game that asked for a CSS HUD with none.
test('android carries native-css to the host and only a source build may compile it in', () => {
  assert.equal(mobileUiRenderer('web'), 'web');
  assert.equal(mobileUiRenderer('native'), 'native');
  assert.equal(mobileUiRenderer('native-css'), 'native-css');
  const rendered = renderAndroidManifest(androidManifest, { ui: { renderer: 'native-css' } });
  assert.match(rendered, /android:name="TN_UI_RENDERER" android:value="native-css"/u);

  assert.deepEqual(androidCssUiGradleArgs('native-css', true), ['-PthreenativeCssUi=true']);
  assert.deepEqual(androidCssUiGradleArgs('web', false), []);
  assert.deepEqual(androidCssUiGradleArgs('native', true), []);
  // No published Android prebuilt links the CSS UI, so a consumer build is refused by name.
  assert.throws(
    () => androidCssUiGradleArgs('native-css', false),
    /TN_CSS_UI_HOST_MISSING: ui\.renderer is "native-css" but the prebuilt Android runtime/u,
  );
});

// Android stages the same `ui-css` directory desktop does: stylesheets plus the fonts and images
// beside them, and no page. A directory with no stylesheet is refused.
test('android stages a native-css UI with its fonts and refuses a page-only one', () => {
  const root = temp('threenative-ui-android-css-');
  const ui = join(root, 'ui');
  mkdirSync(join(ui, 'fonts'), { recursive: true });
  writeFileSync(join(ui, 'index-abc123.css'), '.hud{color:#fff}');
  writeFileSync(join(ui, 'fonts', 'inter.woff2'), 'font');

  const staged = join(root, 'out');
  assert.deepEqual(stageAndroidUi(ui, 'native-css', staged).sort(), ['fonts/inter.woff2', 'index-abc123.css']);
  assert.equal(readFileSync(join(staged, 'fonts', 'inter.woff2'), 'utf8'), 'font');

  assert.throws(() => stageAndroidUi(undefined, 'native-css', join(root, 'a')), /TN_UI_BUNDLE_MISSING/u);
  const page = join(root, 'page');
  mkdirSync(page, { recursive: true });
  writeFileSync(join(page, 'index.html'), '<div id="tn-ui"></div>');
  assert.throws(() => stageAndroidUi(page, 'native-css', join(root, 'b')), /TN_UI_BUNDLE_MISSING[\s\S]*no \.css/u);
});

// Desktop stages the UI beside the executable rather than inside it: the overlay's web view reads
// its page from a real path, which is what gives it a real origin the way WebViewAssetLoader does
// on Android. Same two refusals as Android, because the same two mistakes are possible.
test('desktop stages a web-renderer UI and refuses both mismatches', () => {
  const root = temp('threenative-ui-desktop-');
  const ui = join(root, 'ui');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><div id="tn-ui"></div>');
  writeFileSync(join(ui, 'assets', 'hud.css'), '.hud{color:#fff}');

  const staged = join(root, 'out');
  assert.deepEqual(stageDesktopUi(ui, 'web', staged).sort(), ['assets', 'index.html']);
  assert.equal(existsSync(join(staged, 'assets', 'hud.css')), true);

  const none = join(root, 'none');
  assert.deepEqual(stageDesktopUi(undefined, 'native', none), []);
  assert.equal(existsSync(none), false);

  assert.throws(() => stageDesktopUi(undefined, 'web', join(root, 'a')), /TN_UI_BUNDLE_MISSING/u);
  assert.throws(() => stageDesktopUi(ui, 'native', join(root, 'b')), /TN_UI_BUNDLE_UNEXPECTED/u);
});

// iOS stages the bundle into the app, where WKURLSchemeHandler serves it. The host that reads it
// has never run — see ios/ui_overlay_ios.mm — so this covers the packaging half only, and says so.
test('iOS stages a web-renderer UI and refuses both mismatches', () => {
  const root = temp('threenative-ui-ios-');
  const ui = join(root, 'ui');
  mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><div id="tn-ui"></div>');

  assert.deepEqual(stageIosUi(ui, 'web', join(root, 'out')), ['index.html']);
  assert.deepEqual(stageIosUi(undefined, 'native', join(root, 'none')), []);
  assert.equal(existsSync(join(root, 'none')), false);
  assert.throws(() => stageIosUi(undefined, 'web', join(root, 'a')), /TN_UI_BUNDLE_MISSING/u);
  assert.throws(() => stageIosUi(ui, 'native', join(root, 'b')), /TN_UI_BUNDLE_UNEXPECTED/u);
});

// A web renderer is a game requirement: attach or ready timeout must fail closed. The explicit
// bypass exists for scene-only diagnostics on machines where the UI host is unavailable.
test('web UI startup fails closed unless --bypass-ui-loading is explicit', () => {
  const source = readFileSync(new URL('../src/cli/main.cpp', import.meta.url), 'utf8');
  const signature = /\bstatic bool attachUiOverlayIfConfigured\s*\([^;]*?\)\s*\{/su.exec(source);
  assert.ok(signature, 'attachUiOverlayIfConfigured must be defined');
  const end = source.indexOf('\n}\n', signature.index);
  assert.notEqual(end, -1, 'attachUiOverlayIfConfigured has no closing brace');
  const body = source.slice(signature.index, end + 2);

  assert.match(body, /TN_UI_LOAD_FAILED/u);
  assert.match(body, /attachDesktopUiOverlay\(uiRoot\.string\(\)\)/u);
  assert.match(source, /--bypass-ui-loading/u);
  assert.match(source, /uiReadyIntentReceived/u);
  assert.match(source, /TN_UI_LOAD_FAILED[\s\S]*?return 1;/u);
  assert.match(body, /TN_UI_BUNDLE_MISSING/u);
  assert.match(body, /TN_UI_BUNDLE_MISSING[\s\S]*?return false;/u);
});
