// PRD-784 sweep: the native bundler resolved `@threenative/core/<subpath>` as src/<last segment>.ts, so
// `@threenative/core/spells` (src/spells/index.ts) failed to bundle for every native target.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coreSubpathSource } from '../scripts/bundle-native-engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.dirname(createRequire(path.join(here, '..', 'package.json')).resolve('@threenative/core/package.json'));

describe('native bundler core subpaths', () => {
  it('maps every core export to its source file, nested ones included', () => {
    const exports = JSON.parse(readFileSync(path.join(core, 'package.json'), 'utf8')).exports;
    const subpaths = Object.keys(exports).filter(key => key !== '.' && typeof exports[key] === 'object');
    expect(subpaths).toContain('./spells');
    for (const sub of subpaths) {
      const source = coreSubpathSource(core, `@threenative/core/${sub.slice(2)}`);
      expect(existsSync(source), `${sub} -> ${source}`).toBe(true);
    }
    expect(coreSubpathSource(core, '@threenative/core/spells/ultra')).toBe(path.join(core, 'src', 'spells', 'ultra', 'index.ts'));
  });

  it('names a subpath core does not export', () => {
    expect(() => coreSubpathSource(core, '@threenative/core/nope')).toThrow(/TN_NATIVE_ENGINE_UNBOUND: @threenative\/core\/nope/);
  });
});
