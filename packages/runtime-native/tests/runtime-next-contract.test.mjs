import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import { SDL3_ANDROID_VERSION } from '../scripts/package-android.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test.each(['tn-linux', 'tn-linux-quickjs'])('native cooperative yields avoid frame coupling without starving frames or timers (%s)', (build) => {
  const executable = join(root, 'build', build, 'mystral');
  assert.ok(existsSync(executable), 'Build the native host before running its scheduler contract');
  const output = execFileSync(executable, [
    'run', join(root, 'tests/fixtures/scheduler-yield.js'), '--no-sdl',
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.match(output, /TN_SCHEDULER_CONTRACT:/u);
});

test('Canvas2D raster and upload-dirtiness contracts execute in the native test lane', () => {
  const executable = join(root, 'build/tn-linux/threenative-canvas2d-dirty-test');
  assert.ok(existsSync(executable),
    `${executable} is not built. Run: cmake --build build/tn-linux --target threenative-canvas2d-dirty-test`);
  const output = execFileSync(executable, { encoding: 'utf8', timeout: 30_000 });
  assert.match(output, /canvas2d dirty tracking passed/u);
});

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function readCpp(stem) {
  return read(`${stem}.cpp`);
}

function implementedRows() {
  return JSON.parse(read('conformance/registry.json')).tests.filter((entry) => entry.status === 'implemented');
}

const RUNTIME_SCRIPT_HASHES = {
  'storage-polyfill.js': '7e03f256b0e11b5370bf86ccb5ae286be221080a1baa8339efe2aa570dd3c25d',
  'fetch-polyfill.js': '9dfb919c054b54618e19d090eb27534f10fda57886889c18fd5e99864df54461',
  'streams-polyfill.js': 'b57569ac2079bc5864eb7c8aefef6b03321acad8b6f6364b3de714e2bee64d83',
  'url-worker-polyfill.js': 'fb709b56f527c82cc7ba4d2c3430a6f17c81e0550f736d145819b25463811af3',
  'create-element-setup.js': '3891c716e3e7b8801f45306b50c5c8c5990042276524fbaac745b157389d1bee',
  'event-constructors-setup.js': '3e7f592806866915e7d4fecd051bb5268542cefb79324efc8e15c9bc73978a11',
  'image-support-init.js': '1a674470d63a89e607d065c4b19794e28e87b955b292d63dbd2f974e94e1e6ee',
  'onload-trigger.js': '396a17433bcc18d6193b3167404ff51faecc1451b1b9dfaeb6a3473e86c6371a',
  'install-async-pipelines.js': 'd58fb3fb55d24743273ea79f9ec72303a79ec91b322969d705a9f4d11ce47024',
  'image-bitmap-polyfill.js': '504b53df4835acd12dc9f9c0527dabb24218e3f6d445f175939bb3d1285b04f1',
  'webtransport-polyfill.js': '7a25c702d467985f89f3b8a6d4a3c222307397c22b9b76ed5381defefd8e8d32',
  'webtransport-stub.js': '9b653430e429a8fad538151523a2c4346b0b9c52a201ec5e01314128b788081e',
  'audio-context-constructor.js': 'c3436f70b2597d2d953f780a3388c24b7e60fa3697796973d5002d0c378de227',
  'audio-source-properties.js': 'e631cdd093d660c0ada6f9cf23e0627a2bd1f16d22d8c003c52d7f86419d29ef',
  'audio-gain-param.js': 'd12e77670eaafe552e90d9fcc78a95d51f872922880bb95b8d51e1bad23b9723',
  'audio-param.js': '375719b8424e57c24aec55ccf012d7e7048c39c72af4dfa25c5ee96bc722e683',
  'audio-panner-properties.js': '347b79924b271915fce4259f5cd1ca48ce334d59d76b18730014bd1670cf1cea',
  'canvas2d-properties.js': 'e9bd1ff7562fca7cb16ec1c57ffb05aee9dbead65e1d38cebb9d2d710af5bdf7',
};

const RUNTIME_SCRIPT_LOADERS = {
  'install-async-pipelines.js': 'evalEmbeddedRuntimeScriptWithResult',
  'image-bitmap-polyfill.js': 'evalEmbeddedRuntimeScript',
  'webtransport-polyfill.js': 'runtime_scripts::find',
  'webtransport-stub.js': 'runtime_scripts::find',
  'audio-context-constructor.js': 'evalAudioScript',
  'audio-source-properties.js': 'evalAudioScript',
  'audio-gain-param.js': 'evalAudioScript',
  'audio-param.js': 'evalAudioScript',
  'audio-panner-properties.js': 'evalAudioScript',
  'canvas2d-properties.js': 'evalCanvasScript',
};

function runtimeScriptConsumer(filename, sources) {
  if (filename === 'install-async-pipelines.js' || filename === 'image-bitmap-polyfill.js') {
    return null;
  }
  if (filename === 'webtransport-polyfill.js' || filename === 'webtransport-stub.js') {
    return sources.webtransport;
  }
  if (filename.startsWith('audio-')) return sources.audio;
  if (filename === 'canvas2d-properties.js') return sources.canvas;
  return sources.runtime;
}

function runtimeScriptLoader(filename) {
  return RUNTIME_SCRIPT_LOADERS[filename] ?? 'evalRuntimeScript\\(\\*jsEngine_';
}

function assertRuntimeScriptContract(filename, expectedHash, sources) {
  const source = read(`src/runtime-scripts/${filename}`);
  const actualHash = createHash('sha256').update(source).digest('hex');
  assert.equal(actualHash, expectedHash, `${filename} was changed without updating its contract`);
  const scriptName = filename.slice(0, -3);
  assert.match(sources.cmake, new RegExp(`\\b${scriptName}\\b`), `${filename} is not in the embed step`);
  const consumer = runtimeScriptConsumer(filename, sources);
  if (consumer) {
    assert.match(
      consumer,
      new RegExp(`${runtimeScriptLoader(filename)}.*"${scriptName}"`, 's'),
      `${filename} is not loaded by its native consumer`,
    );
  }
}

function webTransportContext(bridge = '') {
  const context = {
    console: { log() {}, warn() {}, error() {} },
  };
  runInNewContext(read('src/runtime-scripts/fetch-polyfill.js'), context, {
    filename: 'fetch-polyfill.js',
  });
  runInNewContext(read('src/runtime-scripts/streams-polyfill.js'), context, {
    filename: 'streams-polyfill.js',
  });
  runInNewContext(`
    globalThis.__wtStreamReadCredit = () => 0;
    globalThis.__wtStreamReleaseRead = () => 0;
    globalThis.__wtStreamShutdown = () => 0;
    globalThis.__wtSendDatagram = () => 0;
    globalThis.__wtClose = () => 0;
    globalThis.__wtNativeStats = () => ({
      sessions: 0, streams: 0, queuedReliableBytes: 0, queuedDatagrams: 0,
      queuedEvents: 0, inFlightReceiveBytes: 0, readCreditBytes: 0, pendingHeaderBytes: 0,
    });
  `, context, { filename: 'webtransport-bridge-defaults.js' });
  runInNewContext(bridge, context, { filename: 'webtransport-bridge-fixture.js' });
  runInNewContext(read('src/runtime-scripts/webtransport-polyfill.js'), context, {
    filename: 'webtransport-polyfill.js',
  });
  return context;
}

async function runWebTransport(context, source) {
  return runInNewContext(`(async () => { ${source}\n })()`, context, {
    filename: 'webtransport-contract-probe.js',
  });
}

test('official ThreeNative CMake presets and feature flags exist', () => {
  const presets = JSON.parse(read('CMakePresets.json'));
  const names = new Set(presets.configurePresets.map((preset) => preset.name));
  for (const name of ['tn-linux', 'tn-windows', 'tn-macos', 'tn-android', 'tn-ios']) {
    assert.ok(names.has(name), `missing configure preset ${name}`);
  }

  const cmake = read('CMakeLists.txt');
  for (const option of [
    'TN_ENABLE_CANVAS2D',
    'TN_ENABLE_VIDEO',
    'TN_ENABLE_RAYTRACING',
    'TN_ENABLE_WEBTRANSPORT',
    'TN_ENABLE_NATIVE_GLTF',
    'TN_ENABLE_DRACO',
    'TN_ENABLE_DEBUG_SERVER',
  ]) {
    assert.match(cmake, new RegExp(`option\\(${option}\\b`), `missing ${option}`);
  }
  assert.match(
    cmake,
    /elseif\(WIN32\)[\s\S]*?if\(TN_ENABLE_VIDEO\)[\s\S]*?windows_graphics_capture_impl\.cpp/u,
    'Windows capture sources must remain behind TN_ENABLE_VIDEO',
  );
  assert.match(
    cmake,
    /if\(MSVC\)[\s\S]*?OneCoreUap\.lib[\s\S]*?else\(\)[\s\S]*?api-ms-win-core-handle-l1-1-0/u,
  );
  assert.match(cmake, /else\(\)[\s\S]*?-Wl,--allow-multiple-definition/u);
});

test('native host publishes explicit platform facts before the game bundle', () => {
  const runtime = read('src/runtime.cpp');
  // The handle is `platformInfo`, not `platform`: the same scope calls the `platform::` namespace
  // for safe-area insets, and a local of that name reads as a shadow of it.
  const descriptorStart = runtime.indexOf('auto platformInfo = jsEngine_->newObject();');
  const descriptorEnd = runtime.indexOf('jsEngine_->setProperty(nativeHost, "captureScreenshot"', descriptorStart);
  assert.ok(descriptorStart >= 0, 'native platform descriptor construction is missing');
  assert.ok(descriptorEnd > descriptorStart, 'native platform descriptor must precede host services');
  const descriptor = runtime.slice(descriptorStart, descriptorEnd);

  for (const branch of [
    ['#if defined(__ANDROID__)', 'android'],
    ['#elif defined(__APPLE__) && TARGET_OS_IPHONE', 'ios'],
    ['#elif defined(__APPLE__)', 'macos'],
    ['#elif defined(_WIN32)', 'windows'],
    ['#elif defined(__linux__)', 'linux'],
  ]) {
    assert.ok(descriptor.includes(branch[0]), `missing native platform branch ${branch[0]}`);
    assert.match(descriptor, new RegExp(`platformOs = "${branch[1]}"`));
  }
  assert.ok(
    descriptor.indexOf('#if defined(__ANDROID__)') < descriptor.indexOf('#elif defined(__linux__)'),
    'Android must be selected before the overlapping Linux macro',
  );
  assert.match(descriptor, /constexpr int kNativeMobileTouchCapacity = 2;/u);
  assert.match(descriptor, /const int maxTouchPoints = kNativeMobileTouchCapacity;/u);
  assert.match(descriptor, /const int maxTouchPoints = 0;/u);
  assert.doesNotMatch(descriptor, /maxTouchPoints\s*=\s*touchDeviceCount/u);
  assert.match(descriptor, /setProperty\(nativeHost, "platform", platformInfo\)/u);

  const pointerStart = runtime.indexOf('setProperty(playtestHost, "pointer"');
  const pointerEnd = runtime.indexOf('setProperty(nativeHost, "playtestInput", playtestHost)', pointerStart);
  assert.ok(pointerStart >= 0, 'native playtest pointer input is missing');
  assert.ok(pointerEnd > pointerStart, 'native playtest pointer input must be registered');
  const pointerHost = runtime.slice(pointerStart, pointerEnd);
  assert.match(pointerHost, /pointerId\s*=\s*args\.size\(\) >= 5/u);
  assert.match(pointerHost, /pointerType\s*=\s*args\.size\(\) >= 6/u);
  assert.match(pointerHost, /isPrimary\s*=\s*args\.size\(\) >= 7/u);
  // A touch pointer marks the UI's pointer kind, as a real finger does in `pollEvents`.
  assert.match(pointerHost, /uiOverlaySetPointerKind\(event\.pointerType == "touch"\)/u);
  const playtestInput = runtime.slice(runtime.indexOf('auto playtestHost = jsEngine_->newObject();'), pointerEnd);
  // A held `Shift` reaches the UI's key route, so `["Shift","Tab"]` is Shift+Tab.
  assert.match(playtestInput, /uiOverlayTrackModifier\(event\.key, event\.type == "keydown", held\)/u);
  assert.match(playtestInput, /uiOverlayRouteKey\(event\.key\.c_str\(\), event\.type == "keydown", event\.shiftKey\)/u);
  for (const [name, seam] of [['wheel', 'uiOverlayRouteWheel'], ['media', 'uiOverlaySetEnvironment'], ['advanceClock', 'uiOverlayAdvanceClock']]) {
    const start = playtestInput.indexOf(`setProperty(playtestHost, "${name}"`);
    assert.ok(start >= 0, `native playtest ${name} input is missing`);
    assert.ok(playtestInput.indexOf(seam, start) > start, `native playtest ${name} must reach ${seam}`);
  }

  const deviceBridge = read('../playtest/src/three/device.ts');
  assert.match(deviceBridge, /method === "input\.pointers"/u);
  assert.match(deviceBridge, /"pointerdown"[\s\S]*"pointerup"/u);
  assert.match(deviceBridge, /pointer\.id[\s\S]*"touch"/u);
  assert.match(deviceBridge, /method === "input\.wheel"/u);
  assert.match(deviceBridge, /method === "input\.media"/u);
  assert.match(deviceBridge, /playtestInput\?\.advanceClock\?\.\(ticks\)/u);

  const smoke = read('../../examples/native-smoke/src/game.ts');
  for (const helper of ['getPlatform', 'isWeb', 'isNative', 'isMobile', 'isTouchscreenAvailable']) {
    assert.match(smoke, new RegExp(`\\b${helper}\\b`), `native smoke must consume ${helper}`);
  }
  assert.match(smoke, /TN_NATIVE_PLATFORM:/u);
});

test('native project bundling defaults dependency selection to production mode', () => {
  const bundler = read('scripts/bundle.mjs');
  const defaultMode = bundler.indexOf("process.env.NODE_ENV ??= 'production';");
  const viteBuild = bundler.indexOf('await build({', defaultMode);
  assert.ok(defaultMode >= 0, 'native bundling must default NODE_ENV so React links its production build');
  assert.ok(viteBuild > defaultMode, 'the production default must be installed before Vite loads dependencies');
  assert.match(
    bundler.slice(viteBuild),
    /define:\s*\{\s*'process\.env\.NODE_ENV': JSON\.stringify\(process\.env\.NODE_ENV\)\s*\}/u,
    'the Vite API must inline NODE_ENV; setting the parent process alone leaves both React builds in the bundle',
  );
});

test('Win32 window creation does not require a Vulkan-capable host', () => {
  const windowSource = read('src/platform/window.cpp');
  assert.match(windowSource, /#elif !defined\(_WIN32\)[\s\S]*?SDL_WINDOW_VULKAN/u);
  assert.doesNotMatch(windowSource, /#else\s+flags \|= SDL_WINDOW_VULKAN/u);
});

test('native hosts forward one coarse safe-area value through resize and rotation', () => {
  const input = read('src/platform/input.cpp');
  assert.match(input, /refreshSafeAreaInsets\(\)/u);
  assert.match(input, /getSafeAreaInsets\(\)/u);
  assert.match(input, /setSafeAreaInsets\(int top, int right, int bottom, int left\)/u);
  assert.match(input, /processResize\(int width, int height\)[\s\S]*refreshSafeAreaInsets\(\)/u);

  const window = read('src/platform/window.cpp');
  assert.match(window, /SDL_EVENT_WINDOW_RESIZED[\s\S]*processResize/u);

  const activity = read('android/app/src/main/java/com/mystral/engine/MystralActivity.java');
  assert.match(activity, /getSafeAreaInsets\(\)/u);
  assert.match(activity, /WindowInsets\.Type\.systemBars\(\) \| WindowInsets\.Type\.displayCutout\(\)/u);

  const ios = read('ios/main.mm');
  assert.match(ios, /safeAreaInsets/u);
  assert.match(ios, /UIDeviceOrientationDidChangeNotification/u);

  const runtime = read('src/runtime.cpp');
  assert.match(runtime, /safeAreaInsets/u);
  assert.match(runtime, /platform::refreshSafeAreaInsets\(\)/u);

  const fixture = { bottom: 24, left: 18, right: 42, top: 80 };
  assert.deepEqual(
    Object.keys(fixture).sort(),
    ['bottom', 'left', 'right', 'top'],
    'the asymmetric fixture must remain four-sided rather than collapsing to one padding value',
  );
});

test('deprecated native GLTF and Draco paths fail closed before compilation', () => {
  const cmake = read('CMakeLists.txt');
  assert.match(cmake, /TN_ENABLE_NATIVE_GLTF was removed/u);
  assert.match(cmake, /TN_ENABLE_DRACO was removed/u);
  assert.doesNotMatch(cmake, /src\/utils\/cgltf_impl\.cpp|src\/gltf\/gltf_loader\.cpp|draco::draco/u);

  const runtime = read('src/runtime.cpp');
  assert.doesNotMatch(runtime, /setupGLTF|setupDraco|MYSTRAL_HAS_DRACO|__loadGLTF/u);
  const downloader = read('scripts/download-deps.mjs');
  // cgltf is provisioned for the engine's own glTF loader (PRD-515), parsing only; the legacy host never links it.
  assert.doesNotMatch(downloader, /\bdraco\b/u, 'deprecated native decoder dependencies must not be provisioned');
});

test('runtime JavaScript is byte-stable, embedded, and loaded by the bootstrap', () => {
  const sources = {
    cmake: read('CMakeLists.txt'),
    runtime: read('src/runtime.cpp'),
    webtransport: read('src/webtransport/webtransport.cpp'),
    audio: readCpp('src/audio/audio_bindings'),
    canvas: readCpp('src/canvas/canvas2d_bindings'),
  };
  for (const [filename, expectedHash] of Object.entries(RUNTIME_SCRIPT_HASHES)) {
    assertRuntimeScriptContract(filename, expectedHash, sources);
  }
  const { cmake, runtime, webtransport, audio, canvas } = sources;
  assert.doesNotMatch(runtime, /const char\*\s+\w+\s*=\s*R"/u, 'runtime bootstrap still owns a raw JavaScript string');
  assert.doesNotMatch(runtime, /jsEngine_->eval\("/u, 'runtime bootstrap still evaluates an inline JavaScript literal');
  assert.doesNotMatch(webtransport, /kWebTransportPolyfill|R"JS\(\s*\(function/u, 'WebTransport bootstrap still owns an extracted JavaScript string');
  assert.doesNotMatch(audio, /engine->eval\(R"/u, 'Web Audio bindings still own a raw JavaScript string');
  assert.doesNotMatch(audio, /engine->evalScript\(\s*"/u, 'Web Audio constructor still owns an inline JavaScript string');
  assert.doesNotMatch(canvas, /const char\*\s+setupPropertyInterceptors\s*=\s*R"/u, 'Canvas2D bindings still own a raw JavaScript string');
  assert.match(runtime, /__tnOnloadCallback/u, 'onload trigger must receive the callback through the host bridge');
});

/**
 * The hash above says the script changed on purpose. It cannot say the change works, and this one
 * is a seam: every property the script defines calls a `__native*` name the C++ bindings must
 * register, and a script that delegates to a name nobody installed throws inside a 2D context the
 * game never sees fail — the shape that rendered a white cockpit on native. So run the script the
 * way the runtime does and check both sides of the seam.
 */
test('the Canvas2D property script delegates to bindings the native side registers', () => {
  const calls = [];
  const native = (name, value) => calls.push([name, value]);
  // Mutable so a read can be proven to observe restored native state, not a JavaScript shadow.
  let lineJoin = 'round';
  const dashSegments = { 0: 5, 1: 3, length: 2 };
  const ctx = {
    __nativeGetLineCap: () => 'butt',
    __nativeSetLineCap: (value) => native('lineCap', value),
    __nativeGetLineJoin: () => lineJoin,
    __nativeSetLineJoin: (value) => { native('lineJoin', value); lineJoin = value; },
    // The binding returns a host array-like, not a JS Array. Copying it is the whole job: the spec
    // says getLineDash hands back a copy, and Three's dashed materials call .slice() on it.
    __nativeGetLineDash: () => dashSegments,
    __nativeSetFillStyle: (value) => native('fillStyle', value),
    __nativeSetStrokeStyle: (value) => native('strokeStyle', value),
    __nativeSetLineWidth: (value) => native('lineWidth', value),
    __nativeSetGlobalAlpha: (value) => native('globalAlpha', value),
    __nativeSetFont: (value) => native('font', value),
    __nativeSetTextAlign: (value) => native('textAlign', value),
    __nativeSetTextBaseline: (value) => native('textBaseline', value),
  };
  runInNewContext(read('src/runtime-scripts/canvas2d-properties.js'), { __canvas2dContextTemp: ctx });

  assert.equal(ctx.lineJoin, 'round', 'the getter must read the native value, not a shadow copy');
  ctx.lineJoin = 'bevel';
  assert.deepEqual(calls.at(-1), ['lineJoin', 'bevel']);
  lineJoin = 'miter';
  assert.equal(ctx.lineJoin, 'miter', 'a read observes restored native state, not a JavaScript shadow');

  const dash = ctx.getLineDash();
  assert.ok(Array.isArray(dash), 'getLineDash must return a real Array');
  // Array.from re-homes it: the script builds the copy inside the runtime's realm, the way the
  // real engine does, and a cross-realm Array is not deep-strict-equal to one made out here.
  assert.deepEqual(Array.from(dash), [5, 3]);
  dash[0] = 99;
  dash.push(99);
  const second = ctx.getLineDash();
  assert.notEqual(dash, second, 'each call must hand back a fresh array');
  assert.deepEqual(Array.from(second), [5, 3], 'the returned pattern is a copy');
  assert.deepEqual(dashSegments, { 0: 5, 1: 3, length: 2 }, 'the native segments are not mutated');

  // Every name the script reaches for must exist on the C++ side. `setLineDash`, `clip` and
  // `createRadialGradient` are methods the bindings install directly; the game calls them by name.
  const bindings = readCpp('src/canvas/canvas2d_bindings');
  for (const name of [...new Set([...read('src/runtime-scripts/canvas2d-properties.js').matchAll(/__native\w+/gu)].map((match) => match[0])), 'setLineDash', 'clip', 'createRadialGradient']) {
    assert.match(bindings, new RegExp(`"${name}"`, 'u'), `${name} is not registered by canvas2d_bindings`);
  }
});

test('WebTransport stream writes wait for native capacity and retain their input', async () => {
  const context = webTransportContext(`
    globalThis.writeCalls = [];
    globalThis.shutdownCalls = [];
    globalThis.__wtConnect = () => 71;
    globalThis.__wtCreateStream = (() => {
      let next = 4;
      return () => (next += 4) - 4;
    })();
    globalThis.__wtStreamWrite = (_id, sid, bytes, fin) => {
      writeCalls.push({ sid, bytes: Array.from(bytes), fin });
      if (sid === 4) return writeCalls.filter((call) => call.sid === sid).length === 1 ? -2 : bytes.byteLength;
      return -2;
    };
    globalThis.__wtStreamShutdown = (...args) => { shutdownCalls.push(args); return 0; };
    globalThis.__wtNativeStats = () => ({
      sessions: 1, streams: 2, queuedReliableBytes: 0, queuedDatagrams: 0,
      queuedEvents: 0, inFlightReceiveBytes: 0, readCreditBytes: 0, pendingHeaderBytes: 0,
    });
  `);
  const encoded = await runWebTransport(context, `
    const transport = new WebTransport('https://fixture.test:4433');
    __wtDispatch(71, 'ready', 1200);
    const first = await transport.createBidirectionalStream();
    const firstWriter = first.writable.getWriter();
    const original = new Uint8Array([1, 2, 3]);
    let firstSettled = false;
    const firstWrite = firstWriter.write(original).then(() => { firstSettled = true; return 'resolved'; }, () => { firstSettled = true; return 'rejected'; });
    await Promise.resolve();
    await Promise.resolve();
    const blocked = !firstSettled;
    original[0] = 9;
    __wtDispatch(71, 'writable');
    const firstResult = await firstWrite;

    const second = await transport.createBidirectionalStream();
    const secondWriter = second.writable.getWriter();
    secondWriter.closed.catch(() => {});
    const reason = { tag: 'capacity-abort' };
    let secondSettled = false;
    const secondWrite = secondWriter.write(new Uint8Array([4])).then(
      () => { secondSettled = true; return 'resolved'; },
      (error) => { secondSettled = true; return error === reason ? 'reason' : 'other'; },
    );
    await Promise.resolve();
    await Promise.resolve();
    const secondBlocked = !secondSettled;
    const abortResult = await secondWriter.abort(reason).then(() => 'resolved', () => 'rejected');
    const secondResult = await secondWrite;
    return JSON.stringify({
      blocked, firstResult, secondBlocked, secondResult, abortResult,
      calls: writeCalls, shutdownCalls,
    });
  `);
  const result = JSON.parse(encoded);
  assert.equal(result.blocked, true);
  assert.equal(result.firstResult, 'resolved');
  assert.equal(result.secondBlocked, true);
  assert.equal(result.secondResult, 'reason');
  assert.equal(result.abortResult, 'resolved');
  assert.deepEqual(result.calls.slice(0, 2), [
    { sid: 4, bytes: [1, 2, 3], fin: false },
    { sid: 4, bytes: [1, 2, 3], fin: false },
  ]);
  assert.deepEqual(result.shutdownCalls, [[71, 8, 0, 1]]);
});

test('WebTransport close waits for native FIN and shutdown keeps stream directions separate', async () => {
  const context = webTransportContext(`
    globalThis.writeCalls = [];
    globalThis.shutdownCalls = [];
    globalThis.__wtConnect = () => 72;
    globalThis.__wtCreateStream = (() => {
      let next = 4;
      return () => { const sid = next; next += 4; return sid; };
    })();
    globalThis.__wtStreamWrite = (_id, sid, bytes, fin) => {
      writeCalls.push({ sid, bytes: Array.from(bytes), fin });
      return bytes.byteLength;
    };
    globalThis.__wtStreamShutdown = (...args) => { shutdownCalls.push(args); return 0; };
    globalThis.__wtNativeStats = () => ({
      sessions: 1, streams: 2, queuedReliableBytes: 0, queuedDatagrams: 0,
      queuedEvents: 0, inFlightReceiveBytes: 0, readCreditBytes: 0, pendingHeaderBytes: 0,
    });
  `);
  const encoded = await runWebTransport(context, `
    const transport = new WebTransport('https://fixture.test:4433');
    __wtDispatch(72, 'ready', 1200);
    const first = await transport.createBidirectionalStream();
    const firstWriter = first.writable.getWriter();
    await firstWriter.write(new Uint8Array([7]));
    let closeSettled = false;
    const closePromise = firstWriter.close().then(() => { closeSettled = true; return 'resolved'; }, () => { closeSettled = true; return 'rejected'; });
    await Promise.resolve();
    await Promise.resolve();
    const closeBlocked = !closeSettled;
    __wtDispatch(72, 'streamWriteClosed', 4);
    const closeResult = await closePromise;
    const firstReader = first.readable.getReader();
    await firstReader.cancel('read-side');

    const second = await transport.createBidirectionalStream();
    const secondWriter = second.writable.getWriter();
    const secondReader = second.readable.getReader();
    await secondReader.cancel('read-side-2');
    const abortResult = await secondWriter.abort('write-side-2').then(() => 'resolved', () => 'rejected');

    const third = await transport.createBidirectionalStream();
    const thirdWriter = third.writable.getWriter();
    thirdWriter.closed.catch(() => {});
    let finCloseSettled = false;
    let finAbortSettled = false;
    const finClose = thirdWriter.close().then(
      () => { finCloseSettled = true; return 'resolved'; },
      (error) => { finCloseSettled = true; return error === 'cancel-fin' ? 'reason' : 'rejected'; },
    );
    await Promise.resolve();
    await Promise.resolve();
    const finAbort = thirdWriter.abort('cancel-fin').then(
      () => { finAbortSettled = true; return 'resolved'; },
      (error) => { finAbortSettled = true; return error === 'cancel-fin' ? 'reason' : 'other'; },
    );
    const finCloseResult = await finClose;
    const finAbortResult = await finAbort;
    return JSON.stringify({
      closeBlocked, closeResult, abortResult, finCloseSettled, finAbortSettled,
      finCloseResult, finAbortResult, writeCalls, shutdownCalls,
    });
  `);
  const result = JSON.parse(encoded);
  assert.equal(result.closeBlocked, true);
  assert.equal(result.closeResult, 'resolved');
  assert.equal(result.abortResult, 'resolved');
  assert.equal(result.finCloseSettled, true);
  assert.equal(result.finAbortSettled, true);
  assert.equal(result.finCloseResult, 'reason');
  assert.equal(result.finAbortResult, 'reason');
  assert.deepEqual(result.writeCalls, [
    { sid: 4, bytes: [7], fin: false },
    { sid: 4, bytes: [], fin: true },
    { sid: 12, bytes: [], fin: true },
  ]);
  assert.deepEqual(result.shutdownCalls, [
    [72, 4, 0, 0],
    [72, 8, 0, 0],
    [72, 8, 0, 1],
    [72, 12, 0, 1],
  ]);
});

test('WebTransport releases a FIN read only after queued bytes drain and reports live resources', async () => {
  const context = webTransportContext(`
    globalThis.releaseCalls = [];
    globalThis.__wtConnect = () => 73;
    globalThis.__wtStreamReadCredit = () => 0;
    globalThis.__wtStreamReleaseRead = (...args) => { releaseCalls.push(args); return 0; };
    globalThis.__wtStreamShutdown = () => 0;
    globalThis.__wtNativeStats = () => ({
      sessions: 1, streams: 1, queuedReliableBytes: 0, queuedDatagrams: 0,
      queuedEvents: 0, inFlightReceiveBytes: 2, readCreditBytes: 4, pendingHeaderBytes: 0,
    });
  `);
  const encoded = await runWebTransport(context, `
    const transport = new WebTransport('https://fixture.test:4433');
    __wtDispatch(73, 'ready', 1200);
    const incomingReader = transport.incomingBidirectionalStreams.getReader();
    __wtDispatch(73, 'incomingBidi', 20);
    const incoming = (await incomingReader.read()).value;
    const reader = incoming.readable.getReader();
    __wtDispatch(73, 'streamData', 20, new Uint8Array([1, 2]), false);
    __wtDispatch(73, 'streamData', 20, new Uint8Array(0), true);
    await Promise.resolve();
    const before = releaseCalls.length;
    const statsBefore = __wtResourceStats();
    const value = await reader.read();
    const done = await reader.read();
    await Promise.resolve();
    await Promise.resolve();
    const statsAfter = __wtResourceStats();
    return JSON.stringify({
      before, value: Array.from(value.value), done: done.done,
      releaseCalls, statsBefore, statsAfter,
    });
  `);
  const result = JSON.parse(encoded);
  assert.equal(result.before, 0);
  assert.deepEqual(result.value, [1, 2]);
  assert.equal(result.done, true);
  assert.deepEqual(result.releaseCalls, [[73, 20]]);
  assert.equal(result.statsBefore.native.inFlightReceiveBytes, 2);
  assert.equal(result.statsBefore.native.readCreditBytes, 4);
  assert.equal(result.statsBefore.js.queuedReceiveBytes, 2);
  assert.equal(result.statsAfter.js.queuedReceiveBytes, 0);
});

test('WebTransport rejects unsupported options before allocation and settles native failures', async () => {
  const context = webTransportContext(`
    globalThis.connectCalls = 0;
    globalThis.__wtConnect = () => { connectCalls += 1; return 74; };
    globalThis.__wtCreateStream = () => 4;
    globalThis.__wtStreamWrite = () => -2;
    globalThis.__wtStreamShutdown = () => 0;
    globalThis.__wtNativeStats = () => ({
      sessions: 1, streams: 1, queuedReliableBytes: 0, queuedDatagrams: 0,
      queuedEvents: 0, inFlightReceiveBytes: 0, readCreditBytes: 0, pendingHeaderBytes: 0,
    });
  `);
  const encoded = await runWebTransport(context, `
    const unsupported = [];
    for (const options of [
      { requireUnreliable: true },
      { congestionControl: 'low-latency' },
      { serverCertificateHashes: [new Uint8Array([1])] },
      { allowPooling: true },
    ]) {
      try { new WebTransport('https://fixture.test:4433', options); unsupported.push(false); }
      catch (error) { unsupported.push(error instanceof TypeError); }
    }
    const allocated = connectCalls;
    const transport = new WebTransport('https://fixture.test:4433', {});
    __wtDispatch(74, 'ready', 1200);
    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    writer.closed.catch(() => {});
    const pending = writer.write(new Uint8Array([1])).then(() => 'resolved', (error) => ({
      name: error.name, source: error.source, code: error.streamErrorCode,
    }));
    await Promise.resolve();
    await Promise.resolve();
    __wtDispatch(74, 'streamWriteError', 4, 99);
    const writeResult = await pending;
    const closed = transport.closed.then(() => 'resolved', (error) => error.name);
    __wtDispatch(74, 'error', 'peer failure');
    __wtDispatch(74, 'closed', 'peer failure', 55);
    const closedResult = await closed;
    return JSON.stringify({ unsupported, allocated, writeResult, closedResult });
  `);
  const result = JSON.parse(encoded);
  assert.deepEqual(result.unsupported, [true, true, true, true]);
  assert.equal(result.allocated, 0);
  assert.deepEqual(result.writeResult, { name: 'WebTransportError', source: 'stream', code: 99 });
  assert.equal(result.closedResult, 'WebTransportError');
});

test('WebTransport keeps aggregate reliable bytes, write operations, and datagrams bounded', async () => {
  const context = webTransportContext(`
    globalThis.writeCalls = [];
    globalThis.__wtConnect = () => 75;
    globalThis.__wtCreateStream = (() => {
      let next = 4;
      return () => { const sid = next; next += 4; return sid; };
    })();
    globalThis.__wtStreamWrite = (_id, sid, bytes, fin) => {
      writeCalls.push({ sid, length: bytes.byteLength, fin });
      if (bytes.byteLength === 1024 * 1024 &&
          writeCalls.filter((call) => call.sid === sid).length === 1) return -2;
      return bytes.byteLength;
    };
    globalThis.__wtNativeStats = () => ({
      sessions: 1, streams: 2, queuedReliableBytes: 0, queuedDatagrams: 0,
      queuedEvents: 0, inFlightReceiveBytes: 0, readCreditBytes: 0, pendingHeaderBytes: 0,
    });
  `);
  const encoded = await runWebTransport(context, `
    const transport = new WebTransport('https://fixture.test:4433');
    __wtDispatch(75, 'ready', 1200);
    const first = await transport.createBidirectionalStream();
    const second = await transport.createBidirectionalStream();
    const firstWriter = first.writable.getWriter();
    const secondWriter = second.writable.getWriter();
    firstWriter.closed.catch(() => {});
    secondWriter.closed.catch(() => {});
    let firstSettled = false;
    let secondSettled = false;
    const firstWrite = firstWriter.write(new Uint8Array(1024 * 1024)).then(
      () => { firstSettled = true; return 'resolved'; },
      () => { firstSettled = true; return 'rejected'; },
    );
    const secondWrite = secondWriter.write(new Uint8Array([1])).then(
      () => { secondSettled = true; return 'resolved'; },
      () => { secondSettled = true; return 'rejected'; },
    );
    await Promise.resolve();
    await Promise.resolve();
    const exactBoundary = !firstSettled && secondSettled && writeCalls.length === 1 &&
      writeCalls[0].length === 1024 * 1024;
    __wtDispatch(75, 'writable');
    const reliableResults = [await firstWrite, await secondWrite];

    const zeroWriter = (await transport.createBidirectionalStream()).writable.getWriter();
    zeroWriter.closed.catch(() => {});
    const zeroResults = await Promise.all(Array.from({ length: 257 }, () =>
      zeroWriter.write(new Uint8Array(0)).then(() => 'resolved', () => 'rejected')));
    for (let i = 0; i < 300; i += 1) __wtDispatch(75, 'datagram', new Uint8Array([i & 255]));
    const stats = __wtResourceStats();
    return JSON.stringify({
      exactBoundary, reliableResults,
      zeroResolved: zeroResults.filter((value) => value === 'resolved').length,
      zeroRejected: zeroResults.filter((value) => value === 'rejected').length,
      stats,
    });
  `);
  const result = JSON.parse(encoded);
  assert.equal(result.exactBoundary, true);
  assert.deepEqual(result.reliableResults, ['resolved', 'rejected']);
  assert.equal(result.zeroResolved, 256);
  assert.equal(result.zeroRejected, 1);
  assert.equal(result.stats.js.queuedDatagrams, 256);
  assert.equal(result.stats.js.incomingDatagramDrops, 44);
  assert.equal(result.stats.js.queuedReliableBytes, 0);
  assert.ok(result.stats.js.queuedReliableOperations <= 256);
});

test('WebTransport local close settles writers and clears retained stream and datagram queues', async () => {
  const context = webTransportContext(`
    globalThis.nativeSession = true;
    globalThis.__wtConnect = () => 76;
    globalThis.__wtCreateStream = () => 4;
    globalThis.__wtStreamWrite = (_id, _sid, bytes) => bytes.byteLength;
    globalThis.__wtClose = () => { nativeSession = false; };
    globalThis.__wtNativeStats = () => ({
      sessions: nativeSession ? 1 : 0, streams: nativeSession ? 1 : 0, queuedReliableBytes: 0, queuedDatagrams: 0,
      queuedEvents: 0, inFlightReceiveBytes: 0, readCreditBytes: 0, pendingHeaderBytes: 0,
    });
  `);
  const encoded = await runWebTransport(context, `
    const transport = new WebTransport('https://fixture.test:4433');
    __wtDispatch(76, 'ready', 1200);
    const pair = await transport.createBidirectionalStream();
    const writer = pair.writable.getWriter();
    writer.closed.catch(() => {});
    const closePromise = writer.close().then(() => 'resolved', (error) => error.name);
    const reader = pair.readable.getReader();
    __wtDispatch(76, 'streamData', 4, new Uint8Array([1, 2, 3]), false);
    __wtDispatch(76, 'datagram', new Uint8Array([9]));
    const datagramWriter = transport.datagrams.writable.getWriter();
    const datagramClosed = datagramWriter.closed.then(() => 'resolved', (error) => error.name);
    transport.close({ closeCode: 8, reason: 'local-close' });
    __wtDispatch(76, 'closed', 'local-close', 8);
    const closeResult = await closePromise;
    const datagramClosedResult = await datagramClosed;
    const closedResult = await transport.closed.then((info) => ({
      state: 'resolved', code: info.closeCode, reason: info.reason,
    }), (error) => ({ state: error.name }));
    const stats = __wtResourceStats();
    return JSON.stringify({
      closeResult, datagramClosedResult, closedResult,
      streamCount: transport._state.streams.size,
      streamBytes: transport._state.streams.size ? 1 : 0,
      stats,
    });
  `);
  const result = JSON.parse(encoded);
  assert.equal(result.closeResult, 'WebTransportError');
  assert.equal(result.datagramClosedResult, 'WebTransportError');
  assert.deepEqual(result.closedResult, { state: 'resolved', code: 8, reason: 'local-close' });
  assert.equal(result.streamCount, 0);
  assert.equal(result.streamBytes, 0);
  assert.equal(result.stats.native.sessions, 0);
  assert.equal(result.stats.js.sessions, 0);
  assert.equal(result.stats.js.queuedDatagrams, 0);
  assert.equal(result.stats.js.queuedReceiveBytes, 0);
});

test('WebTransport incoming queue cancellation preserves delivered bidi streams and shuts down discarded halves', async () => {
  const context = webTransportContext(`
    globalThis.shutdownCalls = [];
    globalThis.__wtConnect = () => 77;
    globalThis.__wtStreamWrite = (_id, _sid, bytes) => bytes.byteLength;
    globalThis.__wtStreamShutdown = (...args) => { shutdownCalls.push(args); return 0; };
    globalThis.__wtNativeStats = () => ({
      sessions: 1, streams: 2, queuedReliableBytes: 0, queuedDatagrams: 0,
      queuedEvents: 0, inFlightReceiveBytes: 0, readCreditBytes: 0, pendingHeaderBytes: 0,
    });
  `);
  const encoded = await runWebTransport(context, `
    const transport = new WebTransport('https://fixture.test:4433');
    __wtDispatch(77, 'ready', 1200);
    const incomingReader = transport.incomingBidirectionalStreams.getReader();
    __wtDispatch(77, 'incomingBidi', 4);
    __wtDispatch(77, 'incomingBidi', 8);
    __wtDispatch(77, 'incomingBidi', 12);
    const accepted = (await incomingReader.read()).value;
    await incomingReader.cancel('stop-listening');
    __wtDispatch(77, 'incomingBidi', 16);
    const acceptedWriteResult = await accepted.writable.getWriter().write(new Uint8Array([5]));
    const acceptedWrite = acceptedWriteResult === undefined ? 'resolved' : acceptedWriteResult;
    return JSON.stringify({ acceptedWrite, shutdownCalls });
  `);
  const result = JSON.parse(encoded);
  assert.equal(result.acceptedWrite, 'resolved');
  assert.deepEqual(result.shutdownCalls, [
    [77, 8, 0, 0],
    [77, 8, 0, 1],
    [77, 12, 0, 0],
    [77, 12, 0, 1],
    [77, 16, 0, 0],
    [77, 16, 0, 1],
  ]);
});

test('CLI build tools are separate units behind an unchanged dispatch surface', () => {
  const main = read('src/cli/main.cpp');
  const cmake = read('CMakeLists.txt');
  const bundler = read('src/cli/bundler.cpp');
  const lightmap = read('src/cli/lightmap.cpp');
  const dispatcher = read('src/cli/tool_dispatch.cpp');
  const artifactCheck = read('scripts/verify-cli-artifact-diff.mjs');

  // A backstop, not the contract. What actually proves the split is asserted directly below: the
  // tool bodies are absent from main.cpp, dispatchBuildTool is the surface, and CMake builds
  // bundler.cpp/lightmap.cpp as their own unit. PRD-368 added 11 lines of startup config here -
  // deriving the pipeline-cache identity from the embedded bundle - which is runtime wiring, not a
  // tool body, so the cap moves with it rather than the split being loosened. PRD-400 adds runtime
  // web-UI readiness/deadline wiring here; the direct split assertions below remain the contract.
  // The native-css renderer adds 17 lines of the same kind: choosing which overlay backend attaches.
  // PRD-614 adds 11 net lines: refusing the web UI when the environment asks SDL for Wayland, read from
  // the same variables the desktop gate routes.
  assert.ok(main.split('\n').length <= 1913, 'main.cpp still contains a build-time tool body');
  assert.doesNotMatch(main, /static int (compileBundle|bakeLightmaps)\(/u);
  assert.match(main, /dispatchBuildTool\(argc, argv\)/u);
  assert.match(dispatcher, /mystral::vfs::getExecutablePath\(\)[\s\S]*mystral-tools/u);
  assert.match(cmake, /add_executable\(mystral-tools[\s\S]*src\/cli\/bundler\.cpp[\s\S]*src\/cli\/lightmap\.cpp/u);
  assert.match(cmake, /add_executable\(mystral[\s\S]*src\/cli\/tool_dispatch\.cpp/u);
  assert.doesNotMatch(cmake, /add_executable\(mystral\s*\n[^)]*src\/cli\/bundler\.cpp/u);
  assert.match(bundler, /int compileBundle\(const BundlerOptions& opts\)/u);
  assert.match(lightmap, /int bakeLightmaps\(const LightmapOptions& opts\)/u);
  assert.match(artifactCheck, /byteIdentical/u);
  assert.match(artifactCheck, /--before/u);
  assert.match(artifactCheck, /--after/u);
});

test('JSValueHandle ownership is an Engine API with a move-only guard', () => {
  const engine = read('include/mystral/js/engine.h');
  const quickjs = read('src/js/quickjs_engine.cpp');
  const v8 = read('src/js/v8_engine.cpp');
  const jsc = read('src/js/jsc_engine.mm');
  const churn = read('tests/handle_lifetime_test.cpp');

  for (const method of ['freezeHandle', 'freeHandle', 'outstandingHandleCount']) {
    assert.match(engine, new RegExp(`\\b${method}\\b`), `missing Engine ownership method ${method}`);
  }
  assert.match(engine, /class JSValueGuard[\s\S]*JSValueGuard\(const JSValueGuard&\) = delete/u);
  assert.match(quickjs, /void freeHandle\(JSValueHandle value\) override/u);
  assert.match(v8, /void freeHandle\(JSValueHandle value\) override/u);
  assert.match(read('src/js/jsc_engine.mm'), /frameHandleRefs_|protectedHandleRefs_/u);
  assert.match(jsc, /const auto persistent = protectedHandleRefs_\.find\(rawValue\)[\s\S]*const auto frame = frameHandleRefs_\.find\(rawValue\)/u);
  assert.match(churn, /handles-created=[\s\S]*outstanding/u);
});

test('same-source first proof scene uses required Three.js WebGPU contract without runtime branches', () => {
  const sourcePath = 'conformance/scenes/shared/first-proof-game.js';
  assert.ok(existsSync(join(root, sourcePath)), `${sourcePath} missing`);
  const source = read(sourcePath);
  assert.match(source, /import \* as THREE from ['"]three\/webgpu['"]/);
  assert.match(source, /new THREE\.Scene\(/);
  assert.match(source, /new THREE\.PerspectiveCamera\(/);
  assert.match(source, /new THREE\.BoxGeometry\(/);
  assert.match(source, /new THREE\.MeshStandardMaterial\(\{\s*color:\s*0x4488ff/s);
  assert.match(source, /new THREE\.DirectionalLight\([^,]+,\s*3\s*\)/);
  assert.match(source, /requestAnimationFrame\(/);
  assert.doesNotMatch(source, /\bif\s*\(|\bswitch\s*\(|typeof\s+(window|document|process|canvas|navigator)/, 'game source must not branch on host runtime');
});

test('implemented registry rows each map to their own real scene and runner is not hardcoded to first proof', () => {
  const rows = implementedRows();
  assert.ok(rows.length >= 5, 'expected more than one genuine implemented compatibility scene');
  const scenes = new Set(rows.map((entry) => entry.scene));
  assert.ok(scenes.size >= 4, 'implemented rows must not all reuse the cube first-proof scene');
  for (const row of rows) {
    assert.ok(row.scene, `${row.id} missing scene`);
    assert.ok(existsSync(join(root, row.scene)), `${row.id} scene path does not exist: ${row.scene}`);
  }
  const runner = read('conformance/run-conformance.mjs');
  assert.doesNotMatch(runner, /first-proof-entry\.js|first-proof-native-bundle\.js/, 'runner must not hardcode the first proof entry/bundle');
  assert.match(runner, /test\.scene/, 'runner must resolve each registry row scene');
  assert.match(runner, /firefox|browser/i, 'runner must execute a real browser reference path');
  assert.match(runner, /pixelMismatchRatio|perceptualDeltaE/, 'runner must compute pixel/perceptual metrics');
});

test('upstream Three.js GLTFLoader/module/polyfill compatibility sources cover required browser assumptions', () => {
  const glb = read('conformance/scenes/shared/gltf-loader-glb.js');
  assert.match(glb, /import \{ GLTFLoader \} from ['"]three\/addons\/loaders\/GLTFLoader\.js['"]/);
  assert.match(glb, /new LoadingManager|new THREE\.LoadingManager/);
  assert.match(glb, /new Request\(/);
  assert.match(glb, /AbortController/);
  assert.match(glb, /response\.headers\.get/);
  assert.doesNotMatch(glb, /Mystral\.loadGLTF|__loadGLTF|globalThis\.loadGLTF/, 'GLTF conformance must use upstream JS GLTFLoader, not native loader');

  const external = read('conformance/scenes/shared/gltf-loader-external.js');
  assert.match(external, /GLTFLoader/);
  assert.match(external, /setURLModifier/);
  assert.match(external, /fixture\.bin/);
  assert.match(external, /fixture\.png/);

  const texture = read('conformance/scenes/shared/texture-blob-imagebitmap.js');
  for (const token of ['Blob', 'blob.stream', 'URL.createObjectURL', 'URL.revokeObjectURL', 'createImageBitmap']) {
    assert.match(texture, new RegExp(token.replace('.', '\\.')));
  }
  assert.doesNotMatch(texture, /mesh\.rotation/u, 'texture parity capture must be frame-stable');

  const runtime = read('conformance/scenes/shared/runtime-events.js');
  for (const token of ['addEventListener', 'dispatchEvent', 'PointerEvent', 'TouchEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    assert.match(runtime, new RegExp(token));
  }
});

test('mobile presets keep unsupported APIs honest rather than hiding them', () => {
  const gradle = read('android/app/build.gradle.kts');
  assert.match(gradle, /TN_ENABLE_CANVAS2D=OFF/);
  assert.match(gradle, /TN_ENABLE_VIDEO=OFF/);
  assert.match(gradle, /TN_ENABLE_WEBTRANSPORT=OFF/);
  const tests = read('tests/runtime-next-contract.test.mjs');
  assert.match(tests, /Canvas2D|VIDEO|WEBTRANSPORT|unsupported APIs honest/i);
});

test('conformance registry and gate docs cover migrated M0-M11 and M15-M16', () => {
  const registry = JSON.parse(read('conformance/registry.json'));
  for (const id of ['01-basic-cube', '02-buffer-geometry', '03-perspective-camera', '04-orthographic-camera', '05-hierarchy']) {
    assert.ok(registry.tests.some((entry) => entry.id === id), `missing conformance test ${id}`);
  }

  const status = ['G1-desktop-host.md', 'G2-conformance.md', 'G3-mobile-bring-up.md', 'G4-threading-native-systems.md', 'G5-profiling.md']
    .map((file) => read(`docs/${file}`))
    .join('\n');
  for (const i of [...Array.from({ length: 12 }, (_, index) => index), 15, 16]) {
    assert.match(status, new RegExp(`\\bM${i}\\b`), `missing M${i} milestone`);
  }
});


test('Android default gate is generated from the public core native smoke at catalog Three.js', () => {
  const smokePath = 'examples/native-smoke/src/game.ts';

  const buildScript = read('scripts/build-android-first-proof.mjs');
  assert.match(buildScript, new RegExp(smokePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'Android bundle build must use the public core smoke path');
  assert.match(buildScript, /@threenative\/core/, 'Android bundle must enforce the public core API import');
  assert.match(buildScript, /EXPECTED_THREE_VERSION = '0\.185\.1'/, 'Android bundle must close the catalog Three.js gap');
  assert.match(buildScript, /executable\(runtimeRoot, 'esbuild'\)/, 'Android bundle must be generated with the pinned runtime-package esbuild dependency');
  assert.match(buildScript, /metadataOutput/, 'Android bundle build must produce traceable input metadata');

  const gradle = read('android/app/build.gradle.kts');
  assert.match(gradle, /buildAndroidFirstProofBundle/, 'Android Gradle build must invoke reproducible first proof bundling');
  assert.match(gradle, /preBuild[\s\S]*buildAndroidFirstProofBundle/, 'Android preBuild must depend on generated bundle task');
  assert.match(gradle, /examples\/native-smoke\/src/, 'Android Gradle inputs must track the public core smoke');
  assert.match(gradle, /generatedThreeNativeAssets/, 'Android proof assets must live in a modeled build directory');
  assert.match(gradle, /assets\.setSrcDirs/, 'Android packaging must consume only modeled generated assets');

  const activity = read('android/app/src/main/java/com/mystral/engine/MystralActivity.java');
  assert.match(activity, /TN_PLAYTEST_MAILBOX_ROOT/, 'Android activity must pass the host mailbox root to SDL_main');
  const androidMain = read('src/platform/android_main.cpp');
  assert.match(androidMain, /TN_PLAYTEST_MAILBOX_ROOT|tn-playtest-request\.json/, 'Android native entry must configure the mailbox bridge');
});

test('desktop playtests inject the shared mailbox before game evaluation and service screenshot artifacts in the host', () => {
  const cli = read('src/cli/main.cpp');
  const mailboxSetupStart = cli.indexOf('const char* configuredMailboxRoot');
  const gameLoadStart = cli.indexOf('if (!runtime->loadScript(opts.scriptPath))', mailboxSetupStart);
  assert.notEqual(mailboxSetupStart, -1, 'desktop mailbox setup call site is missing');
  assert.notEqual(gameLoadStart, -1, 'desktop game load call site is missing');
  assert.ok(gameLoadStart > mailboxSetupStart, 'desktop game load must follow mailbox setup');
  const mailboxSetup = cli.slice(mailboxSetupStart, gameLoadStart);
  assert.match(mailboxSetup, /runtime->evalScript\(mailbox,\s*"threenative-playtest-mailbox\.js"\)/u);
  assert.match(mailboxSetup, /globalThis\.TN_PLAYTEST_ENDPOINT/u);
  assert.match(mailboxSetup, /globalThis\.TN_PLAYTEST_MAILBOX/u);
  assert.match(mailboxSetup, /tn-playtest-request\.json/u);
  assert.match(mailboxSetup, /tn-playtest-response\.json/u);

  const runtime = read('src/runtime.cpp');
  const screenshotServiceStart = runtime.indexOf('void processPlaytestScreenshotRequest()');
  const frameLoopStart = runtime.indexOf('bool pollEvents() override');
  const frameLoopEnd = runtime.indexOf('void quit() override', frameLoopStart);
  assert.notEqual(screenshotServiceStart, -1, 'screenshot service definition is missing');
  assert.notEqual(frameLoopStart, -1, 'runtime frame loop is missing');
  assert.notEqual(frameLoopEnd, -1, 'runtime frame loop boundary is missing');
  const screenshotService = runtime.slice(screenshotServiceStart, frameLoopStart);
  const frameLoop = runtime.slice(frameLoopStart, frameLoopEnd);
  assert.match(screenshotService, /tn-playtest-screenshot-request\.txt/u);
  assert.match(screenshotService, /saveScreenshot\(screenshotPath\)/u);
  const renderedFrame = frameLoop.indexOf('executeAnimationFrameCallbacks();');
  const screenshotRequest = frameLoop.indexOf('processPlaytestScreenshotRequest();');
  assert.ok(renderedFrame >= 0, 'frame loop must execute animation callbacks');
  assert.ok(screenshotRequest > renderedFrame, 'frame loop must service screenshots after rendering');
  assert.equal(
    (frameLoop.match(/processPlaytestScreenshotRequest\(\);/gu) ?? []).length,
    1,
    'frame loop must invoke the screenshot service at its call site',
  );
});

test('screenshot mode finalizes pipeline capture before the platform-safe exit path', () => {
  const cli = read('src/cli/main.cpp');
  const screenshotStart = cli.indexOf('static int runScreenshotMode');
  const screenshotEnd = cli.indexOf('\n#if !TN_ENABLE_VIDEO', screenshotStart);
  assert.ok(screenshotStart >= 0, 'screenshot mode definition is missing');
  assert.ok(screenshotEnd > screenshotStart, 'screenshot mode boundary is missing');
  const screenshot = cli.slice(screenshotStart, screenshotEnd);
  const finalize = screenshot.indexOf('host.finalizePipelineCapture();');
  const exit = screenshot.indexOf('_exit(finalizeCpuProfile(success ? 0 : 1));');
  assert.ok(finalize >= 0, 'screenshot mode must finalize native pipeline capture');
  assert.ok(exit > finalize, 'capture finalization must precede the immediate exit');
  assert.match(screenshot, /#ifndef MYSTRAL_CLI_NO_MAIN[\s\S]*_exit\(finalizeCpuProfile\(success \? 0 : 1\)\);/u);
  assert.match(screenshot, /#else[\s\S]*runtime\.reset\(\);[\s\S]*return finalizeCpuProfile\(success/u);

  const withoutFinalization = screenshot.replace('host.finalizePipelineCapture();', '');
  assert.throws(
    () => assert.match(withoutFinalization, /host\.finalizePipelineCapture\(\);/u),
    /finalizePipelineCapture/u,
    'the regression must fail when screenshot mode stops finalizing the capture',
  );
});

test('native capture drains completions that finish after the final poll', () => {
  const pipelines = readCpp('src/webgpu/bindings_pipelines');
  assert.match(
    pipelines,
    /pool\.workers\.clear\(\);[\s\S]*drainAsyncPipelineCompiles\(state\);/u,
    'shutdown must drain worker completions before emitting the completion marker',
  );
  assert.match(pipelines, /if \(pool\.finalized\) return;/u);

  const withoutDrain = pipelines.replace('drainAsyncPipelineCompiles(state);', '');
  assert.throws(
    () => assert.match(withoutDrain, /pool\.workers\.clear\(\);[\s\S]*drainAsyncPipelineCompiles\(state\);/u),
    /drainAsyncPipelineCompiles/u,
    'the regression must fail when shutdown discards late completions',
  );
});

const generatedAndroidBundle = 'android/app/build/generated/threenative/assets/scripts/main.js';
const generatedAndroidMeta = `${generatedAndroidBundle}.meta.json`;

/**
 * Two builders write to that one path. This gate is about the first-proof bundle
 * (`build-android-first-proof.mjs`); `build-android-conformance.mjs` stamps
 * `threenative-android-conformance` and carries no native-smoke provenance at all. Guarding on
 * existence alone meant any `--target android` conformance run poisoned `pnpm test` with a SHA
 * mismatch against native-smoke — a red pointing at entirely the wrong thing, which is exactly
 * how repair rounds get spent on the wrong layer.
 *
 * A *different* known kind is not this gate's subject, so it is skipped. A missing or
 * unrecognised kind still runs the assertions: an artifact this cannot identify must not
 * silently stop being checked.
 */
function generatedAndroidBundleIsForeign() {
  if (!existsSync(join(root, generatedAndroidMeta))) return false;
  try {
    const kind = JSON.parse(read(generatedAndroidMeta)).kind;
    return typeof kind === 'string' && kind !== 'threenative-android-first-proof';
  } catch {
    return false;
  }
}

test.skipIf(
  !existsSync(join(root, generatedAndroidBundle)) ||
    !existsSync(join(root, generatedAndroidMeta)) ||
    generatedAndroidBundleIsForeign(),
)('generated Android bundle provenance [requires the generated Android first-proof artifacts]', async () => {
  const smoke = read('../../examples/native-smoke/src/game.ts');
  const crypto = await import('node:crypto');
  const expectedHash = crypto.createHash('sha256').update(smoke).digest('hex');

  const generated = read(generatedAndroidBundle);
  assert.match(generated, new RegExp(`THREENATIVE_ANDROID_NATIVE_SMOKE_SOURCE_SHA256:${expectedHash}`));
  assert.match(generated, /THREENATIVE_ANDROID_NATIVE_SMOKE_ENTRY:examples\/native-smoke\/src\/game\.ts/);
  for (const marker of ['TN_NATIVE_SMOKE_THREE:0.185.1', 'TN_NATIVE_SMOKE_READY:webgpu', 'TN_NATIVE_SMOKE_FIRST_FRAME', 'TN_NATIVE_SMOKE_300_FRAMES:300']) {
    assert.match(generated, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const meta = JSON.parse(read(generatedAndroidMeta));
  const inputPaths = Object.keys(meta.inputs || {}).join('\n');
  assert.equal(meta.publicApiPackage, '@threenative/core');
  assert.equal(meta.catalogThree, '0.185.1');
  assert.equal(meta.installedThree, '0.185.1');
  assert.match(inputPaths, /examples\/native-smoke\/src\/game\.ts/);
  assert.match(inputPaths, /node_modules\/three\/package\.json/);

  assert.doesNotMatch(generated, /glb-parser|parseGLB|loadGLB|DamagedHelmet|PBR shader|textureSample\(baseColorTexture/i, 'Android default gate must not be the custom raw-WebGPU/GLB-parser sample');
});

test('Android preserves native crash evidence and QuickJS reports each evaluation boundary', () => {
  // The contract is unchanged — Android must not touch a disposition debuggerd owns — but the
  // mechanism moved. It used to be five bare `signal()` calls in runtime.cpp guarded by an
  // `#ifdef __ANDROID__`; it is now a policy value in `platform/crash_policy.h`, decided once and
  // provable without crashing a process. Pin the policy, not the `#ifdef` it replaced.
  const runtime = read('src/runtime.cpp');
  assert.match(runtime, /platform::installCrashHandlers\(\)/, 'the runtime must reach the crash-handler policy rather than calling signal() itself');
  assert.doesNotMatch(runtime, /\bsignal\s*\(\s*SIG(SEGV|ABRT|BUS|TRAP|ILL)/, 'runtime.cpp must not install crash-signal handlers directly again');

  // Converted from two source-text assertions (PRD-229 Phase 5) that read crash_policy.h and
  // crash_handlers.cpp as strings. They went red on 8ff06738 for a reformat that changed no
  // behaviour. The contract executable observes the real signal disposition through
  // sigaction(2) with a stand-in for debuggerd, so it answers the same question by watching what
  // happens rather than by reading how it is written.
  const policyExecutable = join(root, 'build/tn-linux', 'threenative-crash-handler-policy-test');
  if (!existsSync(policyExecutable))
    assert.fail(
      `${policyExecutable} is not built. Run: cmake --build build/tn-linux --target threenative-crash-handler-policy-test`,
    );
  const policyOutput = execFileSync(policyExecutable, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(
    policyOutput,
    /PASS Android with no MYSTRAL_SHOW_CRASH_DIALOG leaves the handlers to the platform/u,
    'Android must preserve the original signal for debuggerd tombstones',
  );
  assert.match(
    policyOutput,
    /PASS the Android policy leaves SIGSEGV chained to debuggerd's stand-in/u,
    'the applier must honour the Android policy on the signal that lost the tombstones',
  );
  assert.match(
    policyOutput,
    /PASS negative control: the desktop policy replaces SIGSEGV/u,
    'the proof needs its negative control: a policy that takes the disposition away, observably',
  );

  const quickjs = read('src/js/quickjs_engine.cpp');
  for (const marker of [
    'Runtime limits:',
    'evalScript compile begin:',
    'evalScript compile complete:',
    'evalScript execute begin:',
    'evalScript execute complete:',
    'evalScript pending jobs begin:',
    'evalScript pending jobs complete:',
  ]) {
    assert.ok(quickjs.includes(marker), `missing QuickJS boundary marker: ${marker}`);
  }
  assert.match(quickjs, /JS_EVAL_TYPE_GLOBAL\s*\|\s*JS_EVAL_FLAG_COMPILE_ONLY/);
  assert.match(quickjs, /JS_EvalFunction\(context_, compiled\)/);

  assert.match(quickjs, /androidQuickJsStackLimit = 4 \* 1024 \* 1024/,
    'QuickJS must use no more than half of the requested Android SDLThread stack');

  const deps = read('scripts/download-deps.mjs');
  assert.match(deps, /process\.exitCode = 1/,
    'dependency downloader must fail closed when a download throws');
  assert.match(deps, /Dependency download failed:/,
    'dependency downloader must fail closed when any dependency reports failure');
  assert.match(deps, /execFileSync\((?:'tar'|tarBinary\(\)), \['-x(?:z|J)f', archivePath, '-C', destDir\]/,
    'archive extraction must pass native Windows paths directly to tar without shell rewriting');
  assert.match(deps, /archivePath\.endsWith\('\.zip'\) \|\| archivePath\.endsWith\('\.aar'\)/,
    'Android SDL AARs must be extracted as ZIP archives before CMake configures');
  assert.match(deps, /const androidDeps = \['sdl3', 'wgpu-android', 'sdl3-android', 'quiche-android', 'v8-android', 'webp-source'\]/,
    'a clean Android build must download the SDL Java glue, the Android AAR, V8 and the WebP source');
  // Until 2026-08-16 `third_party/v8-android/` existed only where somebody had unpacked it by hand,
  // so a fresh checkout could not build Android V8 at all. This file is the only supported
  // reconstruction path, and the pin is what makes "reconstructible" mean the same bytes.
  assert.match(deps, /import \{ provisionAndroidV8 \} from '\.\/build-android-v8\.mjs'/,
    'Android V8 must use the owned source builder');
  assert.match(deps, /if \(name === 'v8-android'\) \{[\s\S]*?provisionAndroidV8/,
    'the supported Android V8 dependency path must delegate to the source builder');
  assert.doesNotMatch(deps, /v8-android-jit\.zip/,
    'Android V8 must not fall back to the historical 4 KB archive');
  const nativeBuild = read('scripts/native-build.mjs');
  assert.match(nativeBuild, /VCPKG_INSTALLATION_ROOT[\s\S]*x64-windows-static/,
    'Windows builds must consume the static-CRT HTTP dependencies installed by the platform lane');
  assert.match(deps, /gradle\/v8\.13\.0\/gradle\/wrapper\/gradle-wrapper\.jar[\s\S]*GRADLE_WRAPPER_SHA256/,
    'Android dependency reconstruction must restore the excluded wrapper from an immutable Gradle tag and verify it');
  assert.match(deps, /'wgpu-android':[\s\S]*version: 'v25\.0\.2\.2'/,
    'Android must use the first verified modern wgpu-native release that accepts Three.js WGSL on the emulator');
  assert.doesNotMatch(deps, /wgpu-android[\s\S]{0,800}v22\.1\.0\.5/,
    'Android must not regress to the wgpu-native release that rejects Three.js diagnostic directives');
  assert.doesNotMatch(deps, /wgpu-android[\s\S]{0,800}v24\.0\.3\.1/,
    'Android must not regress to the wgpu-native release whose naga rejects the Three.js gradientMap textureLoad');
});

const sdlActivityPath = `third_party/sdl3/SDL3-${SDL3_ANDROID_VERSION}/android-project/app/src/main/java/org/libsdl/app/SDLActivity.java`;
test.skipIf(!existsSync(join(root, sdlActivityPath)))('Android SDL thread stack evidence [requires downloaded third_party SDL3]', () => {
  const sdlActivity = read(sdlActivityPath);
  assert.match(sdlActivity, /new Thread\(null, new SDLMain\(\), "SDLThread", 8 \* 1024 \* 1024\)/,
    'Android SDLThread must reserve enough native stack for QuickJS and WebGPU callbacks');
});

test('CLI excludes disabled video and debug-server implementations from mobile-style builds', () => {
  const cli = read('src/cli/main.cpp');
  assert.match(cli, /#if !TN_ENABLE_VIDEO[\s\S]*Video recording is disabled in this build/,
    'video CLI mode must not link disabled recorder implementations');
  assert.match(cli, /#if !TN_ENABLE_DEBUG_SERVER[\s\S]*Debug server is disabled in this build/,
    'debug CLI mode must not link disabled server implementations');
});

test('V8 callbacks remain valid across framework render frames', () => {
  const v8 = read('src/js/v8_engine.cpp');
  assert.match(v8, /NativeFunctionRef[\s\S]*SetWeak\(functionRef/,
    'native callbacks retained by JavaScript must live until V8 garbage collection');
  assert.doesNotMatch(v8, /frameNativeFunctions_/, 'frame cleanup must not delete live native callbacks');
});

test('desktop V8 drains Promise microtasks from the host frame loop', () => {
  const engine = read('include/mystral/js/engine.h');
  const runtime = read('src/runtime.cpp');
  const v8 = read('src/js/v8_engine.cpp');

  assert.match(engine, /virtual void processMicrotasks\(\)/,
    'the engine contract must expose an explicit microtask checkpoint');
  assert.match(runtime, /void processMicrotasks\(\) \{\s*jsEngine_->processMicrotasks\(\);\s*\}/,
    'the runtime frame loop must delegate Promise job processing to its engine');
  assert.match(v8,
    /void processMicrotasks\(\) override[\s\S]*PumpMessageLoop[\s\S]*PerformMicrotaskCheckpoint\(\)/,
    'V8 embedders must pump foreground tasks before checkpointing Promise microtasks');
});

test('native DOM creates namespaced elements through the active element factory', () => {
  const setup = read('src/runtime-scripts/create-element-setup.js');
  assert.match(setup,
    /document\.createElementNS = (?:function\(_namespace, tagName\) \{\s*return document\.createElement\(tagName\);|\(_namespace, tagName\) => document\.createElement\(tagName\);)/,
    'Three.js createElementNS calls must reach the native canvas override');
  assert.match(read('src/runtime.cpp'), /evalRuntimeScript\(\*jsEngine_, "create-element-setup"/,
    'the native DOM setup must load the extracted element factory');
});

test('native surface renderer declines retained target subrect capability', () => {
  const renderer = read('src/engine/player/core-webgpu.mjs');
  assert.match(renderer, /supportsRetainedTargetSubrect\s*=\s*false;/u,
    'core must not create retained-target subrects for the native surface-owned scene pass');
});

test('QuickJS native callback results have independent engine ownership', () => {
  const quickjs = read('src/js/quickjs_engine.cpp');
  assert.match(quickjs, /if \(result\.ptr\)[\s\S]*return JS_DupValue\(ctx, \*val\)/,
    'native callback results must outlive their temporary C++ handles');
});

test('the device exposes asynchronous pipeline creation, and it leaves the main loop', () => {
  const installer = read('src/runtime-scripts/install-async-pipelines.js');
  const bindings = readCpp('src/webgpu/bindings');
  const pipelines = readCpp('src/webgpu/bindings_pipelines');
  const runtime = read('src/runtime.cpp');

  // Without these, WebGPURenderer.compileAsync() throws "not a function" and every pipeline is
  // built lazily on the draw that first needs it, mid-play, instead of behind a loading screen.
  //
  // They are native handlers as of PRD-327, not the JavaScript wrap this file used to be. The wrap
  // was `Promise.resolve(this.createRenderPipeline(descriptor))` — an asynchronous signature over
  // a synchronous compile, which is permitted and bought nothing: the contract executable measured
  // it holding the main thread for 96.5 ms of an 84.5 ms compile (ratio 1.14).
  assert.match(
    bindings,
    /"GPUDevice", "createRenderPipelineAsync"/,
    'GPUDevice must expose createRenderPipelineAsync',
  );
  assert.match(
    bindings,
    /"GPUDevice", "createComputePipelineAsync"/,
    'GPUDevice must expose createComputePipelineAsync',
  );
  // Two implementations of one entry point is the failure mode this replaced; the JavaScript wrap
  // must be gone rather than shadowed.
  assert.doesNotMatch(
    installer,
    // `=(?!=)` so the file's own `typeof device.createRenderPipelineAsync === "function"` check,
    // which is the assertion that the native handler is installed, does not read as an assignment.
    /device\.createRenderPipelineAsync\s*=(?!=)/,
    'the JavaScript wrap must not reinstall createRenderPipelineAsync over the native handler',
  );
  // Still asynchronous in the sense that matters: the compile is enqueued, not run here.
  assert.match(
    pipelines,
    /enqueueCompile\(state,/,
    'the async handlers must hand the compile to the pool rather than run it inline',
  );
  // The completion crosses back on the game thread, in the segment that already does exactly this
  // for worker messages. Anywhere else is a JS engine entered from a worker.
  assert.match(
    runtime,
    /drainAsyncPipelineCompiles\(bindingsState_\)/,
    'pipeline completions must be settled from pollEvents()',
  );
  // A failure must reject rather than throw synchronously: a caller awaits these.
  assert.match(
    installer,
    /deferred\.reject\(new Error\(String\(error\)\)\)/,
    'a failed pipeline build must reject the returned promise',
  );
});

test('buffer mapping remains deferred and only polls when work is pending', () => {
  const resources = readCpp('src/webgpu/bindings_resources');
  const runtime = read('src/runtime.cpp');
  const mapStart = resources.indexOf('static js::JSValueHandle handleGpuBufferMapAsync');
  const mapEnd = resources.indexOf('\njs::JSValueHandle handleGpuDeviceCreateBuffer', mapStart);
  assert.ok(mapStart >= 0, 'GPUBuffer.mapAsync handler is missing');
  assert.ok(mapEnd > mapStart, 'GPUBuffer.mapAsync handler boundary is missing');
  const mapHandler = resources.slice(mapStart, mapEnd);

  assert.match(
    mapHandler,
    /pendingBufferMapPromise\(state, requestId\)/u,
    'mapAsync must return a deferred promise owned by the JS settlement map',
  );
  assert.doesNotMatch(
    mapHandler,
    /wgpuDevicePoll|wgpuDeviceTick|wgpuInstanceProcessEvents|wait_for\s*\(|while\s*\(/u,
    'mapAsync must not block while polling the backend for completion',
  );

  const drainStart = resources.indexOf('void drainAsyncBufferMaps(BindingsState* state)');
  const drainEnd = resources.indexOf('\nvoid shutdownAsyncBufferMaps', drainStart);
  assert.ok(drainStart >= 0, 'buffer-map drain is missing');
  assert.ok(drainEnd > drainStart, 'buffer-map drain boundary is missing');
  const drain = resources.slice(drainStart, drainEnd);
  assert.match(
    drain,
    /state->asyncBufferMaps\.pending\.empty\(\)\) return;/u,
    'pollEvents must skip backend polling when there are no pending maps',
  );
  assert.match(
    drain,
    /pollBufferMapCallbacks\(state\)/u,
    'pending map completion must be polled at the host settlement boundary',
  );
  assert.match(
    runtime,
    /webgpu::drainAsyncBufferMaps\(bindingsState_\);[\s\S]*webgpu::drainAsyncPipelineCompiles\(bindingsState_\);/u,
    'buffer maps must settle from pollEvents on the game thread',
  );
});

test('buffer-map promise ownership survives repeated device-facade installation', async () => {
  const source = read('src/runtime-scripts/install-async-pipelines.js');
  const context = {};
  const install = runInNewContext(source.replace(/;\s*$/u, ''), context);
  const device = {
    createComputePipelineAsync: () => undefined,
    createRenderPipelineAsync: () => undefined,
    createBuffer: () => undefined,
  };

  assert.equal(install(device), true);
  const pending = context.__tnBufferMapPending(17);
  assert.equal(context.__tnBufferMapPendingCount(), 1);

  assert.equal(install(device), true);
  assert.equal(
    context.__tnBufferMapPendingCount(),
    1,
    'reinstalling a native device facade must not replace the live resolver map',
  );
  assert.equal(context.__tnBufferMapSettle(17, true), true);
  await pending;
  assert.equal(context.__tnBufferMapPendingCount(), 0, 'settlement must release the resolver');
});

test('native AudioContext exposes the positional graph used by Three.js', () => {
  const audio = readCpp('src/audio/audio_bindings');
  const audioConstructor = read('src/runtime-scripts/audio-context-constructor.js');
  const audioSmoke = read('tests/audio-play-at-smoke.ts');
  assert.match(audioConstructor, /function AudioContext\(\)[\s\S]*__tnCreateAudioContext/,
    'the JavaScript constructor must call the native AudioContext factory');
  assert.match(audioConstructor, /Object\.defineProperties\(this, Object\.getOwnPropertyDescriptors\(native\)\)/,
    'QuickJS must copy the native AudioContext surface onto a JavaScript constructor receiver');
  assert.match(audio, /evalAudioScript\(\*engine, "audio-context-constructor"/u,
    'the constructor shim must execute as an embedded classic script before game modules load');
  assert.match(audio, /setProperty\(jsCtx, "listener", listener\)/,
    'AudioContext must expose a listener object');
  assert.match(audio, /setProperty\(jsCtx, "createPanner"/,
    'AudioContext must expose createPanner for Three.js PositionalAudio');
  assert.match(audio, /installAudioNodeBindings\(engine, jsNode, nodePtr\)/,
    'native audio nodes must route connect and disconnect to the C++ graph');
  assert.match(audio, /setTargetAtTime[\s\S]*setValueAtTime[\s\S]*linearRampToValueAtTime/,
    'GainNode AudioParam must expose the methods used by Three.js and AudioBus fades');
  assert.match(audio, /newFunction\("setPosition"/,
    'the mixer must accept Three.js listener position updates');
  assert.match(audio, /newFunction\("setOrientation"/,
    'the mixer must accept Three.js listener orientation updates');
  assert.match(audio, /void processAudioEvents\(\)[\s\S]*getProperty\(handle->second, "onended"\)/,
    'source completion must be dispatched to JavaScript outside the SDL audio callback');
  const runtime = read('src/runtime.cpp');
  assert.match(runtime, /audio::processAudioEvents\(\)/,
    'the main loop must drain native audio completion events');
  assert.match(audioSmoke, /async function main\(\)/,
    'the shared audio proof must compile as an Android QuickJS script without top-level await');
  assert.doesNotMatch(audioSmoke, /^await /m,
    'Android QuickJS loads the shared audio proof as a classic script');
});

test('native audio ownership is independent of recyclable JavaScript handle owners', () => {
  const audio = readCpp('src/audio/audio_bindings');
  assert.doesNotMatch(
    audio,
    /g_(?:audioContexts|audioBuffers|sourceNodes|sourceHandles|gainNodes|pannerNodes)\[js(?:Ctx|Buffer|Node)\.ptr\]/u,
    'a recycled V8 Persistent address must not replace and destroy a live native audio object',
  );
  for (const registry of [
    'g_audioContexts[ctxPtr]',
    'g_audioBuffers[bufferPtr]',
    'g_sourceNodes[nodePtr]',
    'g_sourceHandles[nodePtr]',
    'g_gainNodes[nodePtr]',
    'g_pannerNodes[nodePtr]',
  ]) {
    assert.ok(audio.includes(registry), `${registry} must use stable native identity`);
  }
});


test('all three Android engine-default sites agree', () => {
  // The Android default is stated in three places, and PRD-130 requires them to agree: a preset that
  // contradicts the platform block is how `-DMYSTRAL_USE_V8=ON` came to work on one machine only.
  // Without this, flipping two of the three leaves the build picking a winner silently depending on
  // whether it went through Gradle, the preset, or a bare CMake configure.
  const gradle = read('android/app/build.gradle.kts');
  const cmake = read('CMakeLists.txt');
  const presets = JSON.parse(read('CMakePresets.json'));

  const gradleDefault = /providers\.gradleProperty\("threenativeJsEngine"\)\.orElse\("(\w+)"\)/u.exec(gradle)?.[1];
  assert.equal(gradleDefault, 'v8', 'the Gradle property default must be the Android default engine');

  // The platform block opts out of V8 only when something else was explicitly asked for.
  assert.match(
    cmake,
    /if\(NOT MYSTRAL_USE_QUICKJS AND NOT MYSTRAL_USE_JSC\)\s*\n\s*set\(MYSTRAL_USE_V8 ON\)/u,
    'the CMake Android platform block must default to V8',
  );

  const android = presets.configurePresets.find(({ name }) => name === 'tn-android');
  assert.ok(android, 'the tn-android preset must exist');
  assert.equal(android.cacheVariables.MYSTRAL_USE_V8, 'ON', 'the tn-android preset must select V8');
  assert.equal(android.cacheVariables.MYSTRAL_USE_QUICKJS, 'OFF', 'the tn-android preset must not also select QuickJS');
  assert.match(android.displayName, /V8/u, 'the preset name must not still advertise the old engine');
});

test('the QuickJS rollback stays reachable', () => {
  // A rollback that stops building is not a rollback. PRD-130 keeps QuickJS as the documented escape
  // for a device or ABI that turns out not to tolerate V8.
  const gradle = read('android/app/build.gradle.kts');
  assert.match(gradle, /engine != "quickjs" && engine != "v8"/u,
    'the Gradle engine property must still accept quickjs');
  assert.match(gradle, /-PthreenativeJsEngine=quickjs/u,
    'the rollback flag must be named where someone editing this file will see it');
  const cmake = read('CMakeLists.txt');
  assert.match(cmake, /MYSTRAL_USE_QUICKJS/u, 'the QuickJS option must still exist in CMake');
});

test('the file-callback drain is bounded, so one asset burst cannot own a frame', () => {
  // A native run of a real game measured a single `fileCallbacks` phase of 625-1043 ms during
  // launch: the reads are issued in parallel, so every completed read arrives at once and each
  // callback copies its bytes into a fresh ArrayBuffer before the game continues. The work is the
  // same either way; the bound is what gives the loading screen a frame between batches. This keeps
  // an unbounded `while (!pendingFileCallbacks_.empty())` from coming back.
  const runtime = read('src/runtime.cpp');
  const drain = /void processPendingFileCallbacks\(\) \{[\s\S]*?\n {4}\}/u.exec(runtime);
  assert.ok(drain, 'processPendingFileCallbacks must exist');
  assert.match(drain[0], /const auto deadline = std::chrono::steady_clock::now\(\) \+/u,
    'the drain must carry a time budget');
  assert.match(drain[0], /count < \d+/u, 'the drain must carry a count cap');
  assert.match(drain[0], /if \(std::chrono::steady_clock::now\(\) >= deadline\) break;/u,
    'the drain must stop at its budget');
  assert.match(drain[0], /processMicrotasks\(\);/u,
    'a callback may enqueue the next read, so its continuation runs before the next callback');
  // The engine already bounds its scheduler drain the same way; the two must not drift apart.
  assert.match(runtime, /void executeSchedulerCallbacks\(\) \{[\s\S]*?const auto deadline/u);
});
