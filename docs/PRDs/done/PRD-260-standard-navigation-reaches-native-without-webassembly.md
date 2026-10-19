---
prd_contract: v1
---

# PRD-260 — Standard navigation reaches native without WebAssembly

**Status: DECLINED IN PHASE 0, 2026-08-29. No product code or dependency added.**
Repository `/home/joao/projects/threenative/threenative-engine`, remote
`https://github.com/ThreeNativeHQ/threenative.git`, branch `main`, baseline HEAD
`e8754ab24e8e227ab472690a3d8d7b6d2cd53550`. Binding charter:
[`docs/architecture/CHARTER.md`](../../architecture/CHARTER.md). Parent batch:
feature-mining.

**Outcome if Phase 0 survives:** the existing Godot-shaped `NavigationRegion3D`,
`NavigationAgent3D` and query surface runs from the same game source on browser and native without
shipping Recast WebAssembly to native. A pure-JavaScript backend may be private implementation; no
`TN.navcat`, second navigation API, steering/AI policy or backend types reach game code.

**Complexity:** +2 backend semantic comparison, +2 native performance/memory proof, +2 existing API
integration and fallback, +1 streamed/tiled consumer, +1 dependency/bundle isolation
= **8 → HIGH mode. Mandatory automated checkpoint after every phase.**

---

## 0. Decision first — consumer-gated platform parity, not a second nav stack

Navigation currently ships behind `@threenative/physics/navigation` with Recast. It is useful on the
web and deliberately browser-only because Recast is WebAssembly. PRD-052 measured zero mobile corpus
demand and replaced the platformer's need with 31 lines of portable steering. A later `abyss-framework`
web caller showed the existing framework path reduced a direct Recast control from 187 to 127
nonblank lines, a 60-line / 32.1% reduction.

That history says two things simultaneously:

- the navigation abstraction has real authoring value when a game needs a navmesh; and
- native parity has not yet earned the cost of another backend.

`isaac-mason/navcat` is new evidence, not automatic selection. At pinned commit
`bc9d3c3f372a9a94cde9c8c2382baa35c1ebd25f` it is MIT, npm `0.4.1`, pure JavaScript/TypeScript,
JSON-serializable, renderer-independent, and implements solo/tiled navmesh construction, querying,
path corridors, crowd movement, obstacle avoidance and flood-fill reachability. Its core does not
require DOM, React, WebGL, WebGPU or WebAssembly.

**Phase 0 may close this PRD as DECLINED with no product code.** Proceed only if a named native or
shared web/native consumer needs navmesh pathfinding that portable steering cannot satisfy and one
of these is measured:

1. hand-written replacement exceeds 60 nonblank lines or duplicates across two callers;
2. a streamed/procedural world needs tiled rebuilds or reachability that the current static Recast
   wrapper cannot provide portably; or
3. current browser-only navigation blocks a scaffold/application from a named Android acceptance
   path.

No benchmark-only crowd and no hypothetical MMO is a consumer.

---

## 1. Evidence and source read

| Source | Fact that constrains this PRD |
| --- | --- |
| `docs/PRDs/done/PRD-034-navigation-and-pathfinding.md` | Existing API/vocabulary and Recast ownership are already decided; do not redesign them. |
| `docs/PRDs/done/PRD-052-navigation-on-mobile.md` | Mobile demand previously failed the gate; 31 lines of steering won for platformer. |
| `docs/PRDs/OPPORTUNITY-AREAS.md` navigation row | Recast remains browser-only, but `abyss-framework` later proved 32.1%/60-line framework authoring reduction on web. |
| `packages/physics/src/navigation/index.ts` | Current subpath imports `recast-navigation`, initializes it and exports existing nodes/query construction. |
| `packages/physics/src/navigation/NavigationRegion3D.ts` | Region lifecycle and navmesh ownership are the public seam to preserve. |
| `packages/physics/src/navigation/NavigationAgent3D.ts` | Agent computes a next waypoint; the game still moves `CharacterBody3D`. Gameplay steering remains outside. |
| `packages/create-threenative/capabilities.json` | Navigation symbols already exist in the machine-readable public inventory. |
| `navcat` pinned `bc9d3c3f372a9a94cde9c8c2382baa35c1ebd25f` | MIT; pure JS; Three is an optional peer; `navcat`, `navcat/blocks`, `navcat/three` exports. |
| `navcat/blocks/generators/generate-solo-nav-mesh.ts` | Portable solo mesh-generation mechanism. |
| `navcat/blocks/generators/generate-tiled-nav-mesh.ts` | Portable tiled construction from positions/indices. |
| `navcat/blocks/agents/path-corridor.ts`, `crowd.ts`, `obstacle-avoidance.ts` | Detour-shaped agent mechanisms exist, but game-facing AI policy must not be imported wholesale. |
| `navcat/blocks/search/flood-fill-nav-mesh.ts` | Reachability diagnostics can support fail-closed generated-world validation. |

---

## 2. Proposed shape

### Phase 0 comparison, not integration

Build one deterministic fixture with:

- a lower route, an elevated route, an unreachable island and a narrow clearance;
- at least two agent radii;
- one off-mesh connection only if both backends express it honestly;
- fixed start/end queries and golden reachability/path envelopes; and
- a tiled rebuild arm only when the named consumer requires streaming.

Run three arms:

1. current Recast web baseline through the existing ThreeNative API;
2. `navcat` as an ordinary game dependency/control using the same input geometry; and
3. the same `navcat` control in packed desktop native and Android emulator.

The control must first prove that navcat itself bundles and executes unchanged. Framework work begins
only where unchanged execution fails at a ThreeNative-owned platform seam or where adapting the
existing public API materially removes duplicated caller work.

### Surviving integration

If Phase 0 passes, keep the public API and select a private backend below it:

```ts
new NavigationRegion3D({ geometry, agentRadius, agentHeight, cellSize })
new NavigationAgent3D({ region, radius, height, maxSpeed })
agent.targetPosition = destination
const next = agent.nextPathPosition
```

Illustrative only: existing names/signatures win. Do not add a backend selector unless a real caller
must choose. Expected policy is:

- browser may retain Recast while parity is proven;
- native uses the portable backend when it meets the semantic/performance gate;
- reports identify backend and unsupported features honestly; and
- unsupported semantic differences fail or report a reason instead of returning a plausible wrong
  path.

A later result may select navcat everywhere if its measured semantics, speed, memory, bundle size and
maintenance cost beat dual-backend drift. That is a Phase 0/1 decision, not an assumption.

---

## 3. Ownership

| Concern | Owner |
| --- | --- |
| Navigation region/agent/query vocabulary | existing `@threenative/physics/navigation` API |
| Backend initialization, geometry conversion and platform selection | navigation subpath implementation |
| Native packaging without WASM | runtime/build gates |
| Level geometry, agent sizes, targets and off-mesh links | game/generated content |
| Movement, acceleration, combat, aggro, formation, animation and avoidance style | game code |
| Generic content residency and streamed tile lifetime | PRD-253 |
| Procedural terrain fields and terrain query parity | PRD-251 |
| Worker execution for off-thread tile generation | PRD-250 standard `Worker` surface |

PRD-251/253 may become the named consumer, but they may not create a second navigation scheduler or
embed navcat vocabulary into world APIs.

---

## 4. Non-goals and hard refusals

- **No second public navigation API.** No `TN.navcat`, `NavCatRegion`, backend-specific polygon IDs or
  navcat configuration objects cross the package boundary.
- **No AI/gameplay package.** Crowd goals, formations, flocking, combat movement, patrol policy,
  animation and obstacle style stay game-owned.
- **No mandatory ECS or controller.** Agents remain usable with ordinary Three objects and existing
  `CharacterBody3D` handoff.
- **No automatic platform claim from pure JavaScript.** Native package/run/screenshot/path evidence is
  required.
- **No full dynamic world system.** PRD-253 owns residency; PRD-251 owns terrain fields; PRD-250 owns
  worker semantics.
- **No silent Recast/navcat semantic drift.** Paths need not be byte-identical, but both must satisfy
  the same reachability, clearance and bounded-path acceptance.
- **No runtime backend download.** Native bundle is deterministic and offline-capable.
- **No WebAssembly fallback smuggled into mobile.** Native artifact inspection must prove absence.
- **No dependency adoption before ordinary-dependency proof.** If game-level navcat works unchanged
  with acceptable LOC and parity, that may be the final answer.

---

## 5. Phase 0 — earn the platform seam or decline

### Consumer gate

Name the exact game/scaffold, target and scenario before implementation. Acceptable examples are a
streamed terrain traversal, multi-level FPS route or large authored scene where steering cannot
represent obstacle routing. A synthetic fixture supports the gate; it cannot be the consumer.

### Required measurements

For current Recast web and navcat web/desktop-native/Android-emulator arms:

- input triangle count and tile count;
- build/init p50/p95 and peak/steady memory where available;
- query p50/p95 for fixed route corpus;
- path length and corridor point count;
- reachable/unreachable truth table;
- agent-radius clearance behavior;
- bundle bytes and WASM bytes;
- main-thread hitch during generation/query;
- deterministic serialized navmesh hash where the backend promises stable serialization; and
- caller nonblank LOC through existing API versus ordinary dependency.

Android emulator can close package, launch, deterministic query and bounded CPU/memory gates. A
physical device remains required before claiming production mobile performance.

### Proceed gate

Proceed to integration only if:

- a named consumer passes the opening gate;
- ordinary navcat runs on native and satisfies route/clearance semantics;
- existing ThreeNative API integration removes at least 40 nonblank caller lines or a platform seam
  the game cannot write;
- generation/query costs fit the named startup/frame budget, or PRD-250 can move generation behind
  standard `Worker` without adding proprietary jobs; and
- bundle isolation keeps navcat/recast out of games that do not import navigation.

Otherwise mark this PRD DECLINED or record ordinary dependency as the final answer.

### Phase 0 executed result — DECLINE

The opening consumer gate failed, so the backend comparison intentionally stopped before building a
synthetic fixture:

1. The capability manifest still exposes `NavigationAgent3D` and `NavigationRegion3D` from
   `@threenative/physics/navigation`, with Recast initialization as a binding constraint. The public
   vocabulary exists and was not redesigned.
2. The production caller census found exactly one non-test import outside the frozen control:
   `examples/abyss-framework/src/scenes/NavigationProbe.ts`. It is the known web Recast probe, not a
   named native or shared web/native acceptance path. No scaffold source imports the navigation
   subpath.
3. PRD-052 already executed the relevant native product decision: the platformer replaced its
   navmesh dependency with 31 lines of portable steering and passed browser plus Android emulator
   chase/avoidance scenarios. Reopening a second backend without a stronger caller would reverse
   measured evidence.
4. PRD-251 and PRD-253 remain `PROPOSED`; their `:→impl` rows are plans, not live consumers. They may
   reopen this decision only after a real streamed/procedural traversal exists.
5. Primary-source verification confirmed navcat `0.4.1` is MIT, pure JavaScript, JSON-serializable,
   renderer-independent and exports `navcat`, `navcat/blocks` and optional `navcat/three`. That makes
   it a credible future ordinary dependency, not a reason to manufacture current demand.

Proceed-gate result:

| Gate | Result |
| --- | --- |
| named native/shared consumer | **FAIL — none exists** |
| ordinary navcat native parity | NOT RUN — synthetic evidence cannot satisfy the failed consumer gate |
| at least 40 caller lines or unportable seam removed | **FAIL — the executed native need is 31 steering lines** |
| startup/frame budget | NOT RUN — no named workload owns a budget |
| bundle isolation | PRESERVED — no navcat dependency or adapter was added |

No clean-install sandbox was built for PRD-260 because there is no feature to validate and the PRD
explicitly rejects a benchmark-only crowd as a consumer. The `feature-mining-sandbox-validation`
workflow applies to shipped features; this decline leaves the installed game surface unchanged.

---

## 6. Integration ledger

Every `→impl` cell must resolve or disappear on decline.

| # | New thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Shared backend-neutral fixture | NOT CREATED — no consumer | backend-specific happy paths | n/a |
| 2 | Ordinary navcat native control | NOT CREATED — consumer gate stopped first | assumption that pure JS is portable | n/a |
| 3 | Private native backend adapter | NOT CREATED | browser-only failure for named consumer | n/a |
| 4 | Backend report | NOT CREATED | opaque backend selection | n/a |
| 5 | Bundle isolation | unchanged; navigation stays an opt-in subpath | accidental dependency leakage | existing non-navigation builds remain the evidence |
| 6 | Android query scenario | NOT CREATED — PRD-052's steering scenario remains the native answer | web-only evidence | n/a |

---

## 7. Acceptance criteria

- [x] Phase 0 executed the caller census and declined before integration because no named native or
      shared consumer exists.
- [x] Existing `NavigationRegion3D`, `NavigationAgent3D`, `NavigationObstacle3D` and query vocabulary
      remain unchanged; no backend types leak.
- [x] No route corpus, native parity, performance or mobile claim is made for navcat because the
      proceed gate did not open.
- [x] No navcat dependency, private adapter, backend selector, jobs surface or navigation WASM path
      was added.
- [x] The executed native product answer remains PRD-052's game-owned steering, including its
      browser/Android emulator evidence and explicit physical-device limits.
- [x] PRD-251/253 may reopen this decision only when their proposed consumers become real and satisfy
      this PRD's opening gate.

---

## 8. Negative controls

| Gate | Mutation | Expected red |
| --- | --- | --- |
| Reachability | Seal the only valid corridor | route becomes unreachable on every backend |
| Vertical separation | Collapse elevated layer into lower floor | wrong-layer assertion fails |
| Agent radius | Enlarge radius beyond narrow gap | path through gap is rejected |
| Native purity | Inject/import WebAssembly into portable arm | native bundle/content gate fails |
| Bundle isolation | Build starter without navigation import | navcat/recast tokens or bytes cause failure |
| Backend honesty | Force unsupported feature and return empty path | explicit unsupported reason required; silent empty path fails |
| Determinism | Reorder input triangles within supported normalization | semantic route corpus remains stable or nondeterminism is recorded and integration stops |
| Consumer value | Delete adapter and use ordinary navcat directly | if caller remains below threshold and parity holds, framework integration is declined |

---

## 9. Borrow map

| Source | Take | Do not take |
| --- | --- | --- |
| `navcat/src` and `blocks/generators/*` | pure-JS navmesh data, solo/tiled generation concepts, serializable structures | public navcat types/names as ThreeNative API |
| `navcat/blocks/search/flood-fill-nav-mesh.ts` | reachability validation shape | editor/debug UI |
| `navcat/blocks/agents/path-corridor.ts` | corridor maintenance and query semantics | gameplay steering policy |
| `navcat/blocks/agents/crowd.ts`, `obstacle-avoidance.ts` | stress/reference algorithms only when named consumer needs them | framework crowd manager, formations, AI presets |
| existing Recast wrapper | public Godot-like vocabulary, callers and parity fixture | WASM on native, backend IDs in game code |

All navcat code/reference use is under its MIT licence. Exact pinned commit:
`bc9d3c3f372a9a94cde9c8c2382baa35c1ebd25f`.

---

## 10. Rollback and kill conditions

**Rollback:** remove the private portable backend and restore browser Recast plus explicit native
unsupported reporting. Existing game APIs and web callers remain intact.

**Kill when:** no named native consumer exists; 31–60 lines of game steering remains smaller; ordinary
navcat dependency is already the simpler answer; route/clearance semantics diverge materially;
startup/memory/bundle cost misses the named budget; integration needs backend-specific public types;
mobile still requires WASM; or dual-backend maintenance is larger than the authoring/platform value.

## 11. Validation command for this Phase 0 decision

```sh
git diff --check -- docs/PRDs/done/PRD-260-standard-navigation-reaches-native-without-webassembly.md
pnpm check:docs
```

Expected: both commands exit zero. This decision changes planning documents only; it does not add
navcat, change navigation code or claim a native navigation backend.
