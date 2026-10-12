import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import { test } from 'vitest';

/**
 * The three hosts implement one contract, and this is what keeps them doing so.
 *
 * The names below are declared once, in `UI_BRIDGE_GLOBALS` and the message constants in
 * `@threenative/core/ui-layer`. A host that spells one differently has no bridge at all — silently,
 * because nothing throws when a page posts to an object nobody injected. That failure is invisible
 * in every test that does not compare the hosts to each other, which is what this file does.
 *
 * iOS startup wiring is checked here, and its path resolver executes against Foundation on the
 * Apple host. Neither substitutes for the packaged simulator UI proof or physical-device checks.
 */
const core = readFileSync(new URL('../../core/src/ui-bridge.js', import.meta.url).pathname.replace(/\.js$/, '.ts'), 'utf8');
const android = readFileSync(
  new URL('../android/app/src/main/java/com/mystral/engine/TnUiOverlay.java', import.meta.url),
  'utf8',
);
const ios = readFileSync(new URL('../ios/ui_overlay_ios.mm', import.meta.url), 'utf8');
// The desktop host's source, wherever it lives in the crate. `abi.rs` is the C ABI and
// `offscreen.rs` is the web view it drives; both are the desktop host and a rule that pinned one
// filename would have to be rewritten every time code moved between them, which is a test that
// tests its own grep rather than the contract.
const desktop = [
  readFileSync(new URL('../native/ui-overlay/src/abi.rs', import.meta.url), 'utf8'),
  readFileSync(new URL('../native/ui-overlay/src/offscreen.rs', import.meta.url), 'utf8'),
].join('\n');

/** Read a name out of `UI_BRIDGE_GLOBALS` rather than restating it here. */
function globalName(key) {
  const found = new RegExp(`${key}:\\s*"([^"]+)"`, 'u').exec(core)?.[1];
  assert.ok(found, `UI_BRIDGE_GLOBALS.${key} is missing from core; the contract has moved`);
  return found;
}

test('every host injects the page-facing object under the one declared name', () => {
  const host = globalName('uiHost');
  assert.equal(host, 'tnHost');
  assert.match(android, new RegExp(`HOST_OBJECT = "${host}"`, 'u'));
  assert.match(ios, new RegExp(`kHostObject = @"${host}"`, 'u'));
  // Desktop registers a WebKit script-message handler under the declared name, which is what puts
  // `window.webkit.messageHandlers.<name>` in the page — one of the transports core discovers, and
  // the reason the desktop host no longer depends on `wry`'s own `window.ipc`.
  assert.match(desktop, new RegExp(`register_script_message_handler\\("${host}"\\)`, 'u'));
  assert.match(desktop, new RegExp(`connect_script_message_received\\(Some\\("${host}"\\)`, 'u'));
});

test('every host calls the one inbound global to reach the page', () => {
  const receive = globalName('uiReceive');
  assert.equal(receive, '__tnUiReceive');
  // Android replies through the injected object's own channel, which surfaces as `onmessage`;
  // the other two evaluate the global directly.
  // Android replies down the channel the page opened, which surfaces there as `tnHost.onmessage`
  // and reaches the same global through core's one inbound path.
  assert.match(android, /proxy\.postMessage\(frame\)/u);
  assert.match(ios, new RegExp(`window\\.${receive}`, 'u'));
  assert.match(desktop, new RegExp(`window\\.${receive}`, 'u'));
});

test('every host keeps hit regions to itself instead of forwarding them to the game', () => {
  const message = /HIT_REGIONS_MESSAGE = "([^"]+)"/u.exec(
    readFileSync(new URL('../../core/src/ui-bridge.ts', import.meta.url), 'utf8'),
  )?.[1];
  assert.equal(message, 'tn:hit-regions');
  assert.match(android, new RegExp(`HIT_REGIONS_MESSAGE = "${message}"`, 'u'));
  assert.match(ios, new RegExp(`kHitRegions = @"${message}"`, 'u'));
  // Desktop's runtime hands the frame to the shared overlay seam, which recognises it before it
  // reaches the game's bridge (the parser moved out of runtime.cpp so the player shares it).
  const runtime = readFileSync(new URL('../src/runtime.cpp', import.meta.url), 'utf8');
  assert.match(runtime, /platform::applyUiHitRegionsFrame\(frame\)/u);
  const overlay = readFileSync(new URL('../src/platform/ui_overlay.cpp', import.meta.url), 'utf8');
  assert.match(overlay, new RegExp(`"\\\\"${message}\\\\""`, 'u'));
});

test('no host serves the UI from file://', () => {
  // A real origin is what makes fetch, module imports and same-origin rules behave as they do on
  // the web build, which is the equivalence this whole layer exists to keep.
  // Comments stripped first: all three files say "never file://" in prose, and a check that a
  // comment can satisfy is a check that proves nothing.
  const code = (source) =>
    source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '');
  for (const [name, source] of [['android', android], ['ios', ios], ['desktop', desktop]]) {
    assert.doesNotMatch(code(source), /file:\/\//u, `${name} serves the UI from file://`);
  }
  assert.match(android, /appassets\.androidplatform\.net/u);
  assert.match(ios, /threenative:\/\/localhost/u);
  assert.match(desktop, /threenative:\/\/localhost/u);
});

test('the iOS host states that it is unproven', () => {
  // Acceptance criterion 6: iOS is either proven or stated unproven, and no result claims a
  // platform it did not execute. If someone runs it, this assertion is what they update.
  assert.match(ios, /UNPROVEN/u);
});

test('iOS connects selected WebUI before game evaluation and detaches before exit', () => {
  const main = readFileSync(new URL('../ios/main.mm', import.meta.url), 'utf8');
  assert.match(main, /info\[@"TNUIRenderer"\]/u);
  const created = main.indexOf('mystral::Runtime::create(config)');
  const attached = main.indexOf('attachIosUiOverlay(');
  const evaluated = main.indexOf('runtime->evalScript(script,');
  assert.ok(attached > created && attached < evaluated, 'Attach the UI after window creation and before the game starts');
  assert.match(main.slice(created, evaluated), /TN_UI_BUNDLE_MISSING/u);
  assert.match(main.slice(evaluated), /detachIosUiOverlay\(\)[\s\S]*return 2/u);
  assert.match(main.slice(main.indexOf('runtime->run()')), /detachIosUiOverlay\(\)[\s\S]*return runtime->getExitCode/u);
  assert.match(ios, /SDL_PROP_WINDOW_UIKIT_WINDOW_POINTER/u);
});

test.skipIf(process.platform !== 'darwin')('iOS scheme paths remain inside the UI directory after URL decoding and symlink resolution', () => {
  const resolver = /static NSString\* resolveUiFile\([\s\S]*?\n\}/u.exec(ios)?.[0];
  assert.ok(resolver);
  const root = makeTempDirSync('tn-ios-ui-paths-');
  mkdirSync(join(root, 'ui/assets'), { recursive: true });
  mkdirSync(join(root, 'ui-other'));
  writeFileSync(join(root, 'ui/index.html'), 'INDEX');
  writeFileSync(join(root, 'ui/assets/main.js'), 'SCRIPT');
  writeFileSync(join(root, 'ui-other/secret.txt'), 'PRIVATE');
  symlinkSync(join(root, 'ui-other'), join(root, 'ui/escape'), 'dir');
  const source = join(root, 'paths.mm');
  const executable = join(root, 'paths');
  writeFileSync(source, `#import <Foundation/Foundation.h>
${resolver}
int main(int argc, char** argv) {
  @autoreleasepool {
    NSString* root = [NSString stringWithUTF8String:argv[1]];
    NSArray* valid = @[@"threenative://localhost/", @"threenative://localhost/assets/main.js?v=1"];
    NSArray* expected = @[@"INDEX", @"SCRIPT"];
    for (NSUInteger i = 0; i < valid.count; ++i) {
      NSString* file = resolveUiFile(root, [NSURL URLWithString:valid[i]]);
      if (file == nil || ![[NSString stringWithContentsOfFile:file encoding:NSUTF8StringEncoding
          error:nullptr] isEqualToString:expected[i]]) return 1;
    }
    for (NSString* url in @[@"threenative://localhost/../ui-other/secret.txt",
      @"threenative://localhost/%2e%2e/ui-other/secret.txt",
      @"threenative://localhost/escape/secret.txt", @"https://localhost/index.html",
      @"threenative://other/index.html", @"threenative://localhost:8080/index.html"]) {
      if (resolveUiFile(root, [NSURL URLWithString:url]) != nil) return 2;
    }
  }
  return 0;
}
`);
  const compiled = spawnSync('xcrun', ['clang++', '-std=c++17', '-framework', 'Foundation',
    source, '-o', executable], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  const result = spawnSync(executable, [join(root, 'ui')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('the iOS bridge is registered before the web view copies its configuration', () => {
  // The web view copies its configuration at init, so a handler added to the original object
  // afterwards never reaches the page: `webkit.messageHandlers.tnHost` stays undefined, core
  // falls back to the in-process broker, `__tnUiReceive` is never installed, and the page is a
  // transparent view over a working game with no error anywhere. That order shipped and failed
  // the packaged iOS pixel proof with only the game visible.
  const attach = ios.slice(ios.indexOf('bool attachIosUiOverlay('));
  const registered = attach.indexOf('addScriptMessageHandler:bridge');
  const created = attach.indexOf('initWithFrame:');
  assert.ok(registered >= 0 && created >= 0 && registered < created,
    'addScriptMessageHandler must come before initWithFrame:configuration:');
});

test('the iOS host reports page load finish/failure with the webview frame', () => {
  // iOS captures no WebView JS console into console.json, so a page that never loads is
  // otherwise invisible. One CI run now discriminates via `loaded:true` (+ frame) or
  // `loaded:false` (+ reason).
  assert.match(ios, /WKNavigationDelegate/u);
  assert.match(ios, /navigationDelegate = bridge/u);
  assert.match(ios, /TN_UI_OVERLAY:\{\\"loaded\\":true/u);
  assert.match(ios, /didFailProvisionalNavigation/u);
  assert.match(ios, /TN_UI_OVERLAY:\{\\"loaded\\":false/u);
});

test('the iOS scheme handler answers HTTP 200 with CORS and a JavaScript MIME', () => {
  // The packager emits Vite bundles whose `index.html` carries `crossorigin` module scripts.
  // Served from the custom scheme with a bare NSURLResponse, WebKit refuses the module, the
  // bundle never executes, yet `didFinishNavigation` still fires — a blank page with no error
  // anywhere iOS captures, exactly what the packaged pixel proof showed. Android never hits
  // this: `WebViewAssetLoader` answers real HTTP semantics already.
  assert.match(ios, /NSHTTPURLResponse alloc/u);
  assert.match(ios, /statusCode:200/u);
  assert.match(ios, /Access-Control-Allow-Origin/u);
  assert.match(ios, /Access-Control-Allow-Origin" : @"\*"/u);
  assert.match(ios, /text\/javascript/u);
  assert.match(ios, /text\/css/u);
  assert.doesNotMatch(ios, /\[\[NSURLResponse alloc/u);
  assert.doesNotMatch(ios, /autoresizingMask/u);
});

test('the iOS overlay is pinned to its parent with constraints', () => {
  // `parent.bounds` at attach time predates first layout — CI logged a landscape frame on a
  // portrait app — so the overlay follows the parent through every layout pass instead.
  assert.match(ios, /translatesAutoresizingMaskIntoConstraints = NO/u);
  for (const edge of ['topAnchor', 'leadingAnchor', 'trailingAnchor', 'bottomAnchor']) {
    assert.match(ios, new RegExp(`overlay\\.${edge} constraintEqualToAnchor:parent`, 'u'));
  }
});

test('the iOS host probes the page and logs its diagnostics', () => {
  // iOS captures no WebView JS console, so a bundle that never executes is otherwise invisible.
  // The document-start probe forwards page errors plus one-shot ready/first-state to the same
  // `tnHost` handler; the host logs them as `TN_UI_PAGE` and never forwards them to the game.
  // An error carries the `[error]` marker so the playtest console classification files it as an
  // error and the run fails with the page's own message.
  assert.match(ios, /WKUserScript/u);
  assert.match(ios, /WKUserScriptInjectionTimeAtDocumentStart/u);
  assert.match(ios, /addUserScript:probe/u);
  assert.match(ios, /__tnUiReceive/u);
  assert.match(ios, /first-state/u);
  assert.match(ios, /unhandledrejection/u);
  assert.match(ios, /tn:ui-diagnostic/u);
  assert.match(ios, /TN_UI_PAGE:%@/u);
  assert.match(ios, /TN_UI_PAGE \[error\]/u);
});

test('the iOS host logs the overlay frame again on first state delivery', () => {
  // The frame at navigation finish plus the frame at first state delivery say together whether
  // the overlay tracked the parent through rotation or froze at attach size.
  const post = ios.slice(ios.indexOf('bool postIosUiMessage('));
  assert.match(post, /TN_UI_OVERLAY:\{\\"firstState\\":true/u);
  assert.match(post, /NSStringFromCGRect\(g_overlay\.frame\)/u);
});

test('the MRC iOS bridge keeps a non-owning overlay link only while its handler is registered', () => {
  assert.match(ios, /@property\(nonatomic, assign\) TnUiOverlayView\* overlay;/u);
  assert.doesNotMatch(ios, /@property\(nonatomic, weak\) TnUiOverlayView\* overlay;/u);

  const detach = ios.slice(ios.indexOf('void detachIosUiOverlay()'), ios.indexOf('/** Deliver one bridge frame'));
  assert.match(
    detach,
    /removeScriptMessageHandlerForName:kHostObject[\s\S]*g_overlay = nil;/u,
  );
});

test.skipIf(process.platform !== 'linux')('non-Linux keyboard routing links without a Linux-only Rust export', () => {
  const source = readFileSync(new URL('../src/platform/ui_overlay.cpp', import.meta.url), 'utf8');
  const fn = /bool uiOverlayInjectKey\([\s\S]*?\n\}/u.exec(source)?.[0];
  assert.ok(fn);
  const directory = makeTempDirSync('tn-ui-keyboard-abi-');
  const path = join(directory, 'stub.cpp');
  const executable = join(directory, 'stub');
  writeFileSync(path, `#include <cstdint>\n#define TN_ENABLE_UI_OVERLAY 1\nbool uiOverlayAttached() { return true; }\n${fn}\nint main() { return uiOverlayInjectKey(38, 0, 0, 0, true) ? 1 : 0; }\n`);
  const compile = spawnSync('c++', ['-U__linux__', path, '-o', executable], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  assert.equal(spawnSync(executable).status, 0, 'native child WebViews own keyboard input on non-Linux hosts');
});

test.skipIf(process.platform !== 'linux')('UI gestures finish outside the window and reset on cancellation or detach', () => {
  const window = readFileSync(new URL('../src/platform/window.cpp', import.meta.url), 'utf8');
  const overlay = readFileSync(new URL('../src/platform/ui_overlay.cpp', import.meta.url), 'utf8');
  const extract = (source, expression) => {
    const found = expression.exec(source)?.[0];
    assert.ok(found);
    return found;
  };
  const directory = makeTempDirSync('tn-ui-pointer-');
  const path = join(directory, 'pointer.cpp');
  const executable = join(directory, 'pointer');
  writeFileSync(path, `
#include <cassert>
#include <cstddef>
#include <iostream>
#include <string>
struct { void* sdlWindow = reinterpret_cast<void*>(1); } g_window;
void SDL_GetWindowSize(void*, int* width, int* height) { *width = 100; *height = 100; }
enum { SDL_EVENT_MOUSE_MOTION, SDL_EVENT_MOUSE_BUTTON_DOWN, SDL_EVENT_MOUSE_BUTTON_UP };
struct SDL_Event { int type; struct { float x, y; } motion, button; };
int g_domButtons = 0;
bool attached = true;
bool uiOverlayAttached() { return attached; }
void setUiOverlayAttached(bool value) { attached = value; }
void tn_ui_overlay_detach() {}
int keyboardResets = 0;
void countKeyboardReset() { ++keyboardResets; }
void (*g_resetKeyboard)() = &countKeyboardReset;
std::string delivered;
bool uiOverlayHitTest(float x, float y) { return x >= 0.1f && x <= 0.3f && y >= 0.1f && y <= 0.3f; }
bool uiOverlayInjectPointer(const char* type, float, float, int, int) { delivered = type; return true; }
void traceUiLatency(const char*, unsigned long long, const char*) {}
size_t uiOverlayHitRegionCount() { return 0; }
${extract(overlay, /struct UiPointerGesture \{[\s\S]*?\n\};\nUiPointerGesture g_uiGesture;/u)}
${extract(overlay, /bool uiOverlayRoutePointer\([\s\S]*?\n\}/u)}
${extract(overlay, /void detachDesktopUiOverlay\(\) \{[\s\S]*?\n\}/u)}
${extract(window, /bool uiViewportPoint\([\s\S]*?\n\}/u)}
${extract(window, /bool routePointerToUi\([\s\S]*?\n\}/u)}
int main() {
  SDL_Event event{};
  event.type = SDL_EVENT_MOUSE_BUTTON_DOWN; event.button = {20, 20}; g_domButtons = 1;
  assert(routePointerToUi(event));
  event.type = SDL_EVENT_MOUSE_BUTTON_UP; event.button = {-10, 20}; g_domButtons = 0;
  assert(routePointerToUi(event));
  assert(!g_uiGesture.uiOwned && !g_uiGesture.gameOwned);
  delivered.clear();
  // A move outside every UI island still reaches the page (hover) but stays the game's.
  assert(!uiOverlayRoutePointer("pointermove", 0.8f, 0.8f, 0, 1));
  assert(delivered == "pointermove");
  assert(uiOverlayRoutePointer("pointerdown", 0.2f, 0.2f, 1, 1));
  assert(uiOverlayRoutePointer("pointercancel", 0, 0, 0, 1));
  assert(delivered == "pointercancel");
  assert(!g_uiGesture.uiOwned && !g_uiGesture.gameOwned);
  assert(uiOverlayRoutePointer("pointerdown", 0.2f, 0.2f, 1, 1));
  detachDesktopUiOverlay();
  assert(!g_uiGesture.uiOwned && !g_uiGesture.gameOwned);
  assert(keyboardResets == 1);  // detach releases the keys the UI owned through the installed reset
  attached = true;
  assert(!uiOverlayRoutePointer("pointerdown", 0.8f, 0.8f, 1, 1));
  assert(!uiOverlayRoutePointer("pointercancel", 0, 0, 0, 1));
  assert(!g_uiGesture.gameOwned);
}
`);
  const compile = spawnSync('c++', [path, '-o', executable], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const run = spawnSync(executable, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test.skipIf(process.platform !== 'linux')('keyboard ownership survives focus changes until the matching release', () => {
  const source = readFileSync(new URL('../src/platform/window.cpp', import.meta.url), 'utf8');
  const structure = /struct UiKeyOwnership \{[\s\S]*?\n\};/u.exec(source)?.[0];
  const reset = /void resetUiOverlayKeyboard\(\) \{[\s\S]*?\n\}/u.exec(source)?.[0];
  assert.ok(structure, 'a key needs one ownership decision shared by repeats and release');
  assert.ok(reset);
  const directory = makeTempDirSync('tn-ui-key-owner-');
  const path = join(directory, 'keys.cpp');
  const executable = join(directory, 'keys');
  writeFileSync(path, `#include <cassert>\n#include <cstdint>\n${structure}
UiKeyOwnership g_uiKeys[1];
int releases = 0;
void uiOverlayInjectKey(uint32_t, uint32_t, uint32_t, uint32_t, bool down) { assert(!down); ++releases; }
${reset}
int main() {
    auto& key = g_uiKeys[0];
    assert(!key.route(true, false)); // Gameplay W down.
    assert(!key.route(true, true));  // Repeat after input takes focus.
    assert(!key.route(false, true)); // Gameplay must receive W up.
    assert(key.route(true, true));   // UI key down.
    assert(key.route(true, false));  // Repeat after a handler releases focus.
    assert(key.route(false, false)); // UI must receive that key up.
    assert(!key.route(true, false)); // Next gesture can belong to gameplay.
    assert(!key.route(false, false));
    assert(key.route(true, true));
    resetUiOverlayKeyboard();
    resetUiOverlayKeyboard();
    assert(releases == 1);
    assert(key.route(true, false));  // Repeat after detach remains owned by the cancelled UI.
    assert(key.route(false, false)); // Physical release stays out of gameplay.
    assert(!key.route(true, false)); // A fresh key can reach gameplay.
  }\n`);
  const compile = spawnSync('c++', [path, '-o', executable], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const run = spawnSync(executable, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('native CSS scroll traces round-trip the host double offsets without rounding', async () => {
  const source = readFileSync(new URL('../src/platform/ui_overlay.cpp', import.meta.url), 'utf8');
  const trace = /void traceCssState\(\) \{[\s\S]*?\n\}/u.exec(source)?.[0];
  assert.ok(trace, 'execute the actual trace function');
  const directory = makeTempDirSync('tn-css-state-precision-');
  const path = join(directory, 'trace.cpp');
  const executable = join(directory, 'trace');
  writeFileSync(path, `#include <cstdlib>
#include <cstdint>
#include <iostream>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string>
#include <vector>
size_t tn_css_ui_scrolled_ids(uint32_t* ids, size_t capacity) { if (ids && capacity) ids[0] = 7; return 1; }
uint32_t tn_css_ui_focused_id() { return 7; }
int tn_css_ui_scroll_offset(uint32_t, double* x, double* y) { *x = 1234567.0; *y = 0.123456789012345; return 1; }
${trace}
int main() { setenv("TN_CSS_UI_STATE_TRACE", "1", 1); traceCssState(); }
`);
  const compile = spawnSync('c++', ['-std=c++17', path, '-o', executable], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const run = spawnSync(executable, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { cssStateAt } = await import('../../../examples/native-css-hud/corpus/interactions-desktop.mjs');
  assert.deepEqual(cssStateAt(run.stdout.trim().split('\n')).scrollOf(7), [1234567, 0.123456789012345]);
});

test('Android corpus fails when any interaction observation is skipped or unreachable', () => {
  const source = readFileSync(new URL('../../../examples/native-css-hud/corpus/android.mjs', import.meta.url), 'utf8');
  // Execute the verdict in the real runner without launching its device/browser main program.
  const assignment = /entry\.pass\s*=\s*[\s\S]*?;/u.exec(source.slice(source.indexOf("async function runInteraction(")))?.[0];
  assert.ok(assignment, 'the Android interaction verdict must exist');
  const pass = new Function('entry', 'problems', 'exitOk', `${assignment} return entry.pass;`);
  const complete = { observations: 2, compared: [{ index: 0 }, { index: 1 }], skipped: 0, unreachable: [], mismatches: [] };
  assert.equal(pass(complete, [], true), true);
  for (const entry of [
    { ...complete, skipped: 1, unreachable: [{ index: 1, why: 'unsupported observation' }], compared: [{ index: 0 }] },
    { ...complete, unreachable: [{ index: 1, why: 'unsupported observation' }] },
    { ...complete, skipped: 1 },
    { ...complete, compared: [{ index: 0 }] },
  ]) assert.equal(pass(entry, [], true), false, JSON.stringify(entry));
  assert.equal(pass(complete, ['wrong backend'], true), false);
  assert.equal(pass(complete, [], false), false);
});
