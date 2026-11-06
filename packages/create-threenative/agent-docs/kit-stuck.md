## When the framework blocks you, write plain Three.js

When an `@threenative/*` API is broken, missing, or does not do what you need, replace only that piece with portable Three.js/plain code. Keep the loop, scenes, input, registry, and playtest bridge; avoid DOM globals, dynamic `import()`, and raw physics handles. **Report what blocked you** (API, expectation, result, replacement); do not stall the game.

## Stuck

`npx threenative doctor`, then `npx @threenative/playtest doctor`; a missing observation is not zero. A confirmed engine bug: `file-engine-bug` skill. Smallest correct change: `ponytail` skill. Slow frame: `threenative-performance` skill.
