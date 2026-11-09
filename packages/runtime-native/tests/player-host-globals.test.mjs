// PRD-784 sweep: the V8 engine player (desktop and PS4) ran only its own prelude, so the manifest's pure-JS
// globals were missing: skinned-crowd died on URLSearchParams and procedural-animals on AbortController.
// The player now installs the embedded scripts it names in kPlayerRuntimeScripts. This runs those scripts,
// in that order, in a bare context (only the JS builtins, as a fresh V8 isolate has) and checks the globals.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const player = readFileSync(path.join(pkg, 'src', 'engine', 'player', 'v8_main.cpp'), 'utf8');

describe('V8 engine player host globals', () => {
  it('installs the self-contained manifest globals', () => {
    const list = /kPlayerRuntimeScripts\[\] = \{([^}]*)\}/.exec(player)?.[1];
    expect(list, 'v8_main.cpp names no kPlayerRuntimeScripts').toBeDefined();
    const names = [...list.matchAll(/"([\w-]+)"/g)].map(m => m[1]);
    const after = /kPlayerRuntimeTail = R"JS\(([\s\S]*?)\)JS"/.exec(player)?.[1];
    expect(after, 'v8_main.cpp names no kPlayerRuntimeTail').toBeDefined();

    const context = vm.createContext({});
    vm.runInContext('globalThis.tn = {};', context);
    for (const name of names) vm.runInContext(readFileSync(path.join(pkg, 'src', 'runtime-scripts', `${name}.js`), 'utf8'), context, { filename: name });
    vm.runInContext(after, context);

    const manifest = JSON.parse(readFileSync(path.join(pkg, 'shim-manifest.json'), 'utf8'));
    const promised = manifest.shims
      .filter(s => names.some(n => s.evidence === `packages/runtime-native/src/runtime-scripts/${n}.js`))
      .map(s => s.name)
      .filter(n => n !== 'fetch');
    expect(promised).toEqual(expect.arrayContaining(['AbortController', 'URLSearchParams', 'TextDecoder', 'ReadableStream', 'KeyboardEvent']));
    for (const name of [...promised, 'self']) expect(vm.runInContext(`typeof ${name}`, context), name).not.toBe('undefined');
    // The player has no __httpRequestAsync, so a fetch here would only reject: it stays absent, as before.
    expect(vm.runInContext('typeof fetch', context)).toBe('undefined');
    expect(vm.runInContext('new URLSearchParams("a=1&b=2").get("b")', context)).toBe('2');
    expect(vm.runInContext('new AbortController().signal.aborted', context)).toBe(false);
  });

  // vfx-gallery mounts with `document.getElementById("app") ?? undefined`; the player's document had no
  // getElementById, so the bundle died with "document.getElementById is not a function" on PS4.
  it('answers getElementById with null: the player has no page', () => {
    const shim = /kDocumentShim = R"JS\(([\s\S]*?)\)JS"/.exec(player)?.[1];
    expect(shim, 'v8_main.cpp names no kDocumentShim').toBeDefined();
    const context = vm.createContext({ __tnCreateCanvas2D: () => ({}) });
    vm.runInContext(shim, context);
    expect(vm.runInContext('document.getElementById("app")', context)).toBeNull();
  });
});
