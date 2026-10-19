---
prd_contract: v1
---

# PRD-150 — Nothing reports what a loaded model actually is, so placing it is guesswork

**Status: DONE, 2026-08-18.** The inspect command reports bounds, clips, bones and likely units;
failure cases and the playtest console artifact pass. See [batch verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** one command tells you a `.glb`'s bounds, units, forward axis, clip names and bone
names, before you write the line that places it — instead of after two wrong screenshots.

**Depends on:** nothing.

**Blocks:** nothing. [PRD-142](PRD-142-bone-sockets-and-attachment.md) shares the root cause and
is independently useful.

**Complexity: 3 → LOW mode.** One CLI subcommand over the loader that already exists.

**Blast radius: 3 files.** A new command under `packages/create-threenative/src/`, its
`__tests__` spec, and the generated `AGENTS.md`.

---

## 1. The defect

`ctx.assets` is two methods (`packages/core/src/assets.ts:11-12`):

```ts
model<T = unknown>(path: string): Promise<T>;
texture(path: string): Promise<Texture>;
```

`model` returns `unknown`. Nothing reports bounds, scene units, forward axis, clip names or bone
names, and no tool in the repository does either. The consequences from the PRD-137 build:

| What was not known | What it cost |
| --- | --- |
| The viewmodel's bounds | Two wrong attempts — a 1.4 m rifle through the camera, then shrunk to a toy |
| The weapon's units | `Enemy.ts:178` — *"its raw bounds are 8 x 30 x 112 … or attaching it to a hand makes a 112 metre AK"* |
| The clip names | `Rifle.ts:80` builds a `Set` of names and silently no-ops on any `#play` that misses |
| The bone names | `findBone(model, /right.*hand|hand.*r$|hand_r/i)` — three conventions guessed |

The build's answer was `measure.mjs`, a standalone Node script that parses the `.glb` with
`GLTFLoader` and prints the box and the clips. Getting `GLTFLoader` to run under Node at all took
**three DOM shims** — `self`, `createImageBitmap`, `URL.createObjectURL`. That is a real barrier
between a builder and a fact the file already contains.

Compounding it: the supplied capture harness prints only console **errors**, so a `console.info`
measurement logged from inside the running game never reaches the terminal either. Both routes to
the number are closed.

## 2. Where this belongs

**Not on `ctx.assets`.** Question (a): could the game write this portably? Yes — `new
Box3().setFromObject(model)` is plain Three.js and runs on both targets, and the PRD-137 build does
exactly that at `Enemy.ts:179`. A `model.bounds` convenience on the loader fails question (a) and
does not get admitted.

**It belongs in the tooling**, where the problem actually is: the builder needed the number *before
writing code*, at a terminal, and there was no way to get it without writing a loader harness with
DOM shims.

```sh
npx create-threenative inspect public/assets/weapon-ak47.glb
```

```
weapon-ak47.glb
  bounds     8.000 x 30.000 x 112.000   (centre 0.000, 15.000, 0.000)
  units      likely centimetres — longest axis 112.0
  clips      (none)
  bones      (none)
  meshes     3   materials 2   textures 1

player-viewmodel.glb
  bounds     0.573 x 0.392 x 1.394      (centre -0.002, 0.050, 0.407)
  units      likely metres
  clips      Walk, Run, Reload, Shoot, Idle
  bones      mixamorigHips, mixamorigSpine, … (54)
```

`--json` for a machine reader, since agents are the primary consumer of this repository's tooling.

**"Likely centimetres" is a heuristic and must be labelled as one.** glTF specifies metres; a file
authored in centimetres is technically out of spec and only detectable by looking at the numbers.
Printing a guess as a fact is the kind of confident wrongness this repository is built against — so
it prints the longest axis beside it and the reader decides.

### 2.1 Shape constraints

Read the batch README's shape rules first. Specifics:

- **SRP.** `inspect` reads a file and prints facts. It does not convert units, rescale, re-export,
  cache, or write anything. A tool that starts fixing assets is a pipeline, and that is a different
  PRD nobody has asked for.
- **DRY.** It uses the same `GLTFLoader` path the runtime uses. If it grows its own parser, or a
  second set of DOM shims beside whatever the loader already needs, the fix is in the wrong place —
  and the fact that `measure.mjs` needed three shims to run is itself worth checking against
  `packages/runtime-native/src/gltf/`, which already solved loading glTF outside a browser.
- **KISS.** One subcommand, one optional `--json`. No watch mode, no directory recursion, no
  thumbnail rendering.
- **Not a runtime API.** §2 refuses `model.bounds` on question (a). If implementation finds itself
  adding to `@threenative/core`, the design has drifted.

## 3. Second half: the capture harness must show non-error console output

The measurement route from *inside* a running game is closed too, because the harness surfaces only
`console.error`. A builder who logs `console.info("bounds", box)` sees nothing.

This is a smaller fix in a different place, and it is included because it is the same gap: **the
builder could not see a number the machine already had.** Surface `console.info`/`warn` in the
harness's console artifact, filtered but present.

Note the boundary: `tools/capture.mjs` in the sandbox is the *experiment's* harness, supplied by
PRD-137, and the ledger correctly scores it as not-the-framework. What is in scope here is the
console artifact the **playtest runner** writes — `artifacts/playtest/console.json` — which is
framework code.

## 4. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | `pnpm vitest run packages/create-threenative/__tests__/inspect.spec.ts` | pass — a fixture `.glb` reports the expected bounds, clip names and bone count |
| 2 | same spec, failure rows | a missing file, a non-glTF file and a corrupt `.glb` each **throw** with a message naming the file |
| 3 | `npx create-threenative inspect <the PRD-137 viewmodel>` | prints `0.573 x 0.392 x 1.394` and `Walk, Run, Reload, Shoot, Idle` — the numbers `measure.mjs` produced |
| 4 | `--json` output | parses, and contains every field the human output shows |
| 5 | a playtest run with a `console.info` in the game | the string appears in `artifacts/playtest/console.json` |
| 6 | `pnpm typecheck && pnpm lint && pnpm test` | exit `0` |

Row 3 is the regression test against the real problem: the tool must produce the number the builder
had to write a script to get.

## 5. What this does not claim

Not that asset units are fixed — `inspect` reports, it does not convert, and `RIFLE_LENGTH = 1.02`
stays a game constant. Not that the forward-axis report is reliable: there is no axis metadata in
glTF and any answer is inferred from geometry, so it is printed as an observation and labelled.
Not that this covers textures, materials or compression. Not that
`threenative-asset-mcp` should do it instead — that server discovers assets to download and this
inspects one on disk; if the owner prefers it there, that is a defensible relocation and the
surface is unchanged.
