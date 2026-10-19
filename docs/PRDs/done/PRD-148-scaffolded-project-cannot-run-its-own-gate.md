---
prd_contract: v1
---

# PRD-148 — A scaffolded project's `pnpm test` is a 16-clause shell string on a hard-coded port, and it cannot pass as generated

**Status: DONE, 2026-08-18.** Repeatable/glob scenarios, port selection, artifact isolation and
fail-closed empty suites are covered; all seven generated template gates pass. See [batch
verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** `pnpm test` in a new project is one command that runs every scenario in
`playtests/`, picks a free port, uses the right browser flags, and survives the user deleting a
scenario file.

**Depends on:** nothing. Do it **after**
[PRD-146](PRD-146-playtest-frames-vs-ticks.md), so the scenarios being run are honest before the
runner that runs them is rewritten.

**Blocks:** nothing.

**Complexity: 5 → MEDIUM mode.** A repeatable flag, a port fallback, and seven template
`package.json` files.

**Blast radius: 11 files.** `packages/playtest/src/runner/config.ts`,
`packages/playtest/src/runner/runner.ts`, `packages/playtest/src/runner/cli.ts`, the seven
`packages/create-threenative/templates/*/package.json`, and one `__tests__` spec. Plus
`templates/*/vite.config.ts` for §2.4.

---

## 1. Four defects, one root cause

`--scenario` takes exactly one value (`packages/playtest/src/runner/config.ts:62`, not
`repeatable`). Everything below follows from that.

### 1.1 The script is an `&&` chain, one clause per scenario

`templates/platformer/package.json:17` chains **sixteen** invocations. `templates/starter` chains
ten. Each clause repeats the URL, the port, the server command and the flags.

### 1.2 The port is hard-coded, ten to sixteen times, in one string

`4173` appears in every clause of every template. Changing it is a find-and-replace inside a 1.5 kB
shell line. And the runner fails closed when anything else holds it
(`runner.ts:1507`):

```
Managed server URL is already in use before startup.
```

The PRD-137 builder lost the run to an unrelated project of the user's that had been holding 4173
since the previous day. There is no flag, environment variable or config key that changes it.

### 1.3 The flags drift between clauses, and three templates ship the trap

`starter`, `minimal` and `shooter` run most clauses with **no `--browser-recipe webgpu` and no
`--headed`** — the exact headless-WebGPU trap the generated `AGENTS.md` spends a paragraph
warning about. As generated, on this machine, that fails:

```
Visual capture could not read a renderer adapter description (kind=webgpu)
```

**The smoke test a new user receives cannot pass out of the box.** `shooter` is the clearest case:
clause 1 has no recipe, clauses 2 and 3 do.

### 1.4 Deleting a scenario the docs invite you to delete breaks the script

The generated `AGENTS.md` says the shipped scenarios are ones "you may delete or rewrite". They are
enumerated by path in `package.json`, so deleting one turns `pnpm test` into a hard failure.
Nothing globs the directory. Nine of the starter's ten also assert platformer behaviour — coyote
time, jump buffer, respawn — that no other genre can satisfy, so a user building anything else
must delete them, and deleting them breaks the gate.

**Name the layer. 1.1, 1.2 and 1.3 are engine bugs** — the CLI cannot express "run these
scenarios" and cannot pick a port, and the template generator inherits both. **1.4 is a template
bug** with a CLI cause.

## 2. The fix

### 2.1 `--scenario` becomes repeatable and accepts a glob

`config.ts` already has a `repeatable: true` mechanism — `--browser-arg` uses it. Apply it to
`--scenario`, and resolve a glob against the project root. Then the whole template script is:

```json
"test": "vite build && threenative-playtest --scenario 'playtests/*.playtest.json' --browser-recipe webgpu --headed --server-command \"pnpm dev --host 127.0.0.1 --port $PORT --strictPort\""
```

A glob that matches **zero** files is an error, not a pass. That is the fail-closed rule, and it is
the difference between "the user deleted everything" and "the suite is green".

Scenarios run sequentially against one managed server — the server starts once instead of ten
times, which is also most of the suite's wall-clock back.

### 2.2 The port is chosen, not assumed

`--port 0` or the absence of an explicit port means "pick a free one and substitute it into the
server command and the URL". The current fail-closed behaviour stays for an **explicitly
requested** port: asking for 4173 and not getting it must still be an error.

### 2.3 One flag set per run, not per clause

Falls out of 2.1 — there is one invocation, so the flags cannot drift. Every template gets
`--browser-recipe webgpu --headed`. **Verify against a headless CI runner before assuming
`--headed` is universally right**; if it is not, that is a finding and the recipe needs a
headless-capable variant, which is a bigger question than this PRD.

### 2.4 The template's own `vite.config.ts` stops fighting the runner

The scaffolded config sets `server.watch.usePolling: true` with no ignore list. The runner writes
`artifacts/playtest/*` **inside the project**; the watcher sees it and full-reloads the page
mid-scenario; the runner then reports `TN_PLAYTEST_PAGE_NAVIGATED` and blames the game — *"Remove
the navigation from the game."* Two runs were lost before the cause was clear, and the fix the
builder wrote is four lines the template should have shipped:

```ts
server: { watch: { ignored: ["**/artifacts/**", "**/screenshots/**", "**/playtests/**"], usePolling: true } }
```

Fix it in every template. **Also consider defaulting `--artifacts` outside the project root**,
which removes the collision instead of ignoring it — that is the better fix and the reason it is
not the primary one is that it changes where users look for artifacts. Owner's call; state it in
the commit message.

### 2.5 Shape constraints

Read the batch README's shape rules first. Specifics:

- **DRY.** This whole PRD *is* a DRY fix: one port, one flag set, one server, one invocation. The
  measure of success is `grep -c 4173 templates/*/package.json` going from 10–16 to **0**.
- **SRP.** `package.json`'s `test` script says *run the gate*. It does not encode which scenarios
  exist, on which port, with which flags — the directory says which scenarios exist and the CLI
  owns its own defaults.
- **KISS.** A repeatable flag and a glob. **No config file.** A `playtest.config.ts` is the
  obvious next thought and it is refused: it is a second place for the truth to live, and the
  glob plus the CLI's existing flags already covers every case in the tree.

## 3. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | `pnpm vitest run packages/playtest/src/runner/*.test.ts` | pass — repeated `--scenario` accumulates; a glob expands; a glob matching nothing **throws** |
| 2 | scaffold each of the seven templates and run `pnpm test` **as generated** | exit `0` for all seven — this fails today for at least three |
| 3 | hold the default port with another process, then run a scaffolded `pnpm test` | exit `0` — a free port was chosen |
| 4 | request an occupied port explicitly | **fails**, with the existing message |
| 5 | in a scaffolded project, delete half the scenarios and re-run `pnpm test` | exit `0` |
| 6 | delete **all** of them and re-run | **fails** — an empty suite is not a pass |
| 7 | run a scenario that writes artifacts into the project with the dev server up | no `TN_PLAYTEST_PAGE_NAVIGATED` |
| 8 | `grep -c 4173 packages/create-threenative/templates/*/package.json` | `0` everywhere |
| 9 | `pnpm typecheck && pnpm lint && pnpm test && pnpm test:templates` | exit `0` |

Rows 5 and 6 are the pair. Row 5 alone is satisfied by making the suite vacuous.

## 4. What this does not claim

Not that the scenarios themselves are right — nine of the starter's ten assert platformer
behaviour and that is [PRD-136](PRD-136-scaffolded-gate-survives-first-edit.md)'s
open §5 question, not this one. Not that `--headed` is correct in CI; §2.3 flags it as
unverified. Not that parallel scenario execution is addressed — this makes one server serve many
scenarios sequentially, which is a wall-clock win, not concurrency.
