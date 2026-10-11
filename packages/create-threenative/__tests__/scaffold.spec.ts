import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { compileAssets } from "@threenative/assets";
import { describe, expect, it } from "vitest";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { loadConfig } from "../src/config.js";
import {
  cliHelp,
  createProject,
  discoverKitManifests,
  discoverTemplateNames,
  parseArgs,
  scaffoldCompletionMessage,
} from "../src/index.js";

const run = promisify(execFile);

const TEMPLATE_ROOT = path.resolve("packages/create-threenative/templates");
const KIT_FIXTURE_ROOT = path.resolve("packages/create-threenative/__tests__/fixtures/kits");
/** Where a generated project reads a reference page: the installed `create-threenative` copy
 * (PRD-449), the same path `assertReferenceBundle` checks against the package's bundle. */
const REFERENCE_PREFIX = "node_modules/create-threenative/agent-docs/references/";
const ASSET_MCP = "threenative-asset-mcp";
const SCULPT_MCP = "threenative-sculpt-mcp";
const ENGINE_MCP = "threenative-engine-mcp";
// Every server launches through a shim in `@threenative/core`, the one package a ThreeNative
// project always depends on directly, so the path resolves whatever the package manager did with
// the server packages themselves.
const CORE_SHIM = "./node_modules/@threenative/core/mcp";
const ALL_TEMPLATES = discoverTemplateNames(TEMPLATE_ROOT);
const AGENT_ROLE_PATHS = [
  ".threenative/agents/builder.md",
  ".threenative/agents/verifier.md",
  ".claude/agents/threenative-builder.md",
  ".claude/agents/threenative-verifier.md",
  ".agents/skills/threenative-builder/SKILL.md",
  ".agents/skills/threenative-verifier/SKILL.md",
] as const;

// The engine-bug report skill ships through `agent-files` to every scaffold, in the two skill
// directories hosts discover: Claude Code reads `.claude/skills`, Codex reads `.agents/skills`.
const BUG_REPORT_SKILL_PATHS = [
  ".claude/skills/file-engine-bug/SKILL.md",
  ".agents/skills/file-engine-bug/SKILL.md",
] as const;

// Refreshed for the startup-readiness loading gate: each template's `src/render/loading.ts` was
// reduced to the shared `startup.whenReady()` contract and every template's AGENTS.md carries
// the readiness wording into the shipped scaffold.
//
// Refreshed by PRD-219, in the commit that changed the bytes. Two shipped things moved: the
// starter's menu proof became cross-target (`noNetworkErrors` is a reasoned opt-out, because the
// browser is the only target with a CDP network observer), and the capability manifest every
// template embeds gained the Android viewport, rotation, tap and IME helpers that proof needed.
// The starter's name field also gained autoCapitalize/autoCorrect/spellCheck: a phone keyboard
// rewrites what the player typed unless the field says not to.
// Recomputed 2026-08-30 for `minimal` only: its atmosphere sky and aerial-perspective
// in-scattering were both scaled by 24, a value authored when that template had no post chain.
// The chain now exposes the pass and tone-maps it, so the same radiance was applied twice and
// exposed again — median frame luminance 203 of 255 against 22 for the template's last good
// baseline. Both multipliers are 1.5, calibrated on a scaffolded render rather than chosen.
// Recomputed again for the chasers' measured routes: they now step only once startup
// reports ready, so a slow lane cannot spend part of the route before anything observes it.
// Recomputed 2026-08-30 for `platformer` only: c2ba91d9 re-measured that template's performance
// budgets against the running frame — the previous 70 draws / 3350 triangles were counted behind
// the loading layer, on a frame the player never sees — and moved the scenario to 200 / 7700
// against a measured 160 / 6127. The frame-time ceiling deliberately did not move.
// Recomputed 2026-08-30 for all seven: `pnpm build` regenerated `capabilities.json` and the
// capability reference derived from it, and every scaffold embeds both, so exporting one public
// symbol moves every template's bytes. Six of the seven moved for that reason alone; platformer
// also carries its chasers' route change.
// Recomputed 2026-10-02 for create-threenative 0.2.8: every template pins the scaffolder version.
// Recomputed 2026-08-31 from the values CI measured, not from a local run.
//
// These were updated three times in a row and were wrong all three times, because they were
// computed against a WORKING TREE that carried another lane's uncommitted template edits. CI
// checks out only committed files, so the numbers disagreed by construction and no amount of
// re-running locally could converge them. If this table needs updating again, take the values
// from a CI failure's `Received` block, or compute them from a clean checkout of HEAD — never
// from a dirty tree in a checkout more than one lane is working in.
// Recomputed 2026-08-31 again: the godrays stage now refuses by name when the shadow map is not
// allocated yet instead of throwing and taking the whole chain with it, and the shared
// look fragment points at the lighting docs. Both are embedded in every scaffold.
// Recomputed 2026-08-31 for PRD-295: every template's AGENTS.md now carries the Fab import route
// (fab_search_assets -> fab_list_owned -> fab_import_asset) in the shared asset-mcp-loop fragment,
// and that fragment is embedded in all seven scaffolds.
// Recomputed 2026-08-31 for PRD-304: every template gained `src/render/quality.ts`, its
// `postprocessing.ts` was rewritten to read it, and its AGENTS.md/CLAUDE.md pair gained the
// quality-tier section — three files per scaffold, so all eight trees move. Computed from a
// committed lane worktree rebased onto origin/main, with no sibling edits in it.
// Recomputed 2026-08-31 for PRD-314: every template's AGENTS.md/CLAUDE.md pair gained the clip
// conformance paragraph (clipPoseError, clipTrackBindings, clipBoneCoverage, boneContact), and the
// generated capability reference embedded in every scaffold gained their four entries.
// Recomputed 2026-09-01 for PRD-304's repair: seven templates' `worldEnvironment.ts` now
// requests its normal/metalness/roughness texture nodes lazily, because asking for them is
// what created the extra render target that made the mobile look a black screen. `sailing`
// never had those lines, so its tree is unchanged and its hash does not move.
// Recomputed 2026-09-03 for PRD-338's authoring-layer pass: the shipped playtest skill, the
// debug-surface page and capture-the-frame all teach `doctor --url`'s room lines and the new
// scene/stride assertions, and all three are copied into every scaffold.
// Recomputed 2026-09-02 for PRD-338, then again the same day when the `scene` assertion family
// landed: the generated assertion reference is embedded in every scaffold and gained a kind.
// Recomputed 2026-09-02 for PRD-338: the playtest bridge gained the `scene.observe` capability
// and the stride observation, so the capability manifest and the reference generated from it
// both moved, and those bytes are embedded in every scaffold. The action-rpg tree moves for a
// second reason — its AGENTS.md/CLAUDE.md pair now states the stride convention.
// Recomputed 2026-09-02 after the named-export capability correction, on origin/main's
// refreshed genre kits.
// Recomputed 2026-09-04 after merging PR #99: every scaffold gains the loading, trace, audio,
// streaming, and alpha-antialiasing surfaces; starter also retains its authored coastal look.
// Recomputed 2026-09-04 for PRD-349 after observing the old pin fail: every template documents
// cook defaults and overrides; starter and sailing also omit their assets opt-outs.
// Recomputed 2026-09-04 after the observed PRD-349 alignment-doc red: every template and its
// generated capability reference now document the automatic unchanged-size fallback.
// Re-pinned after folding that guidance into the existing paragraph to retain the 100-line
// agent-document budget; the template contract red and all ten changed hashes were observed.
// Recomputed 2026-09-04 for the sceneNodes and causedBy assertion families: the generated
// assertion reference every scaffold ships now documents 28 kinds, so all ten trees move by that
// one file. Recomputed again the same day, on the merge, for PRD-265 and PRD-278 AC9: the playtest
// protocol also gained a public `IPlaytestSetupConfirmation` — the read-back that lets a report
// tell what a bridge confirmed from what the runner asked for — which the generated capability
// reference carries into every scaffold too. The values below are measured on the merged tree, so
// they are neither branch's. `sailing` moves for a third reason: its native scenario now asserts
// the render chain it applies on the desktop host.
// Recomputed 2026-09-05 on the merge of origin/main (PRD-357) into this lane. Both sides had
// re-pinned this table for unrelated reasons — PRD-265/PRD-278 here, PRD-349's cook defaults
// there — so neither branch's values describe the merged tree. All ten are measured from the
// merged worktree with no sibling lane's edits in it, per the clean-checkout rule above.
// Recomputed 2026-09-05 on the merge of origin/main into the PRD-298 lane. This branch adds
// capability manifest entries, and the generated reference built from them is embedded in
// every scaffold, so all ten trees move by those bytes. Measured on the merged worktree.
// Recomputed 2026-09-05 for PRD-300's ownership correction. Removing the unsupported health
// and body-height damage aliases and moving terrain streaming to TerrainTiles changes the
// generated capability manifest and capability reference copied into every scaffold, so all
// ten trees move again. Values come from the clean committed tree's Received block, not a dirty
// sibling worktree; no template source or scaffold implementation changed.
// Recomputed 2026-09-07 for the `assets.audio` config seam: `parseAudioConfig` became the CLI's
// validation path and entered the public surface, so the capability manifest and the reference
// generated from it each gained exactly one entry — a 20-line pure addition, no deletions — and
// both files are copied verbatim into every scaffold, so all ten trees move by those bytes.
// Measured on this tree; `worker-scaffold-delta.mjs` names the only two changed repo files that
// reach a scaffold, and neither of the concurrent lane's edits (`src/build.ts`,
// `__tests__/build.spec.ts`) appears in one. No template source or scaffold implementation moved.
// Recomputed 2026-09-07 again, one variable later: every template's AGENTS.md gained the
// `audio: "none"` opt-out beside the `models`/`textures` ones it already listed, and
// `pnpm sync:agents` carried that line into each generated CLAUDE.md — 20 files, one line each,
// one added phrase. Ablation names the whole cause: restoring only those 20 docs to HEAD returns
// all ten hashes to the values above, so nothing else in this lane reaches a scaffold. The docs
// arrive through the templating step rather than a verbatim copy, which is why a content-hash
// matcher does not list them and this ablation is the evidence instead.
// Recomputed 2026-10-03 for PRD-339's opt-in exposure integration at 8bf16f4c3.
// All thirteen actual no-install baseline52/current trees were byte-compared: only the
// generated worldEnvironment/autoExposure/quality wiring, two GPU/readback helper modules,
// and token-identical instruction whitespace changed. Default cost remains off; actual
// consumer GPU captures are byte-identical to the qualified public images. Measurement:
// docs/verification/prd339-exposure-proof/completion-consumer-8bf16f4.json.
// Current develop c18a42b integration: all13 actual generated trees were byte-compared
// against reviewed 8bf trees; only the copied Three compute-only Storage3DTexture patch changed.
// Recomputed in the isolated PR398 lane for linear coverage blending and coherent input moments;
// actual no-install generation changes only starter. All thirteen generator hashes were measured.
// Recomputed for the additional matched-surface depth guard; all other twelve stay unchanged.
// Recomputed for bounded integer depth donors; actual no-install generation changes only starter.
// Recomputed after existing temporal declarations moved; all thirteen trees measured, only starter moves.
// Re-measured on current develop plus TS7: restoring only each compiler manifest and
// rain's shader API import recovers all 13 develop fingerprints.
// PR388 producer delivery: compared all 13 immutable eab0cdbfe/generated trees. Only
// package.json patch declarations and copied Vite/Tailwind patch bytes differ; every other
// generated file remains byte-identical. Fingerprints still cover the complete tree.
// PR381 color/depth attachment caches: all thirteen actual createProject trees change only in the
// copied Three patch. Restoring the previous patch bytes recovers every published fingerprint.
// PR381 bounded compressed uploads: all thirteen actual trees change only in the copied
// Three patch. Restoring the previous patch recovers every prior fingerprint.
// Recomputed from clean committed c22e5ba8d for the independently reviewed bounded-upload
// package patch embedded by every scaffold. No template, capability or appearance change.
const PRD_201_PARENT_SCAFFOLD_HASHES: Readonly<Record<string, string>> = {
  // Measured by the actual thirteen-tree createProject equality test on the Oct 6
  // af6dfc8 + ba72eed publication merge, after capability and canonical patch generation.
  // Measured through all thirteen actual createProject trees on the Oct 4 published-head
  // merge with develop 15adf350; preserves Strata instructions and develop template changes.
  // Recomputed 2026-10-01 on merging develop (#375, #376) into the PRD-466/467/468 branch: every
  // template AGENTS/CLAUDE pair keeps the optional terrain reference sentence. Values are the
  // observed no-install createProject trees of the merged tree.
  // Recomputed 2026-10-01 on the merge of develop a602467db (PRD-458/473): every template's frame
  // budget now comes from resolveTargetFps, so ten trees move and `rts` does not; the capability reference (365 -> 368 entries) then moved all eleven, because it ships in every scaffold.
  // Recomputed 2026-10-01, three times, each by a real run that found the previous tree wrong:
  // the first gave each quality.ts a software adapter policy; the second found ten of eleven
  // setupPost callers never forwarded the adapter fact to it; the third found no template but
  // `starter` set `renderChainTier`, so a low preset still ran the high render chain. The same ten
  // trees move on each of the last two. `starter` is unchanged throughout — its setupPost hands the
  // whole environment to createAdaptiveQuality and its quality.ts already carried the chain tier.
  // Values measured through createProject by the spec that asserts them, not by hand.
  // Recomputed again 2026-10-01 for `sailing` alone: `sailMotion` is a range across landed cloth
  // readbacks, and one landed copy makes that range zero by arithmetic, so the sails scenario now
  // holds long enough for two copies to arrive on a CPU rasteriser and asserts the landed count
  // beside it. Only the two sailing template files changed, so only this one tree moves.
  // Recomputed again 2026-10-01 after merging the quality/post chain into this branch and landing
  // the rts sim's order, queue and event-record fixes: `rts` alone moves, and it is the only one of
  // the eleven that carries `src/sim/`. Measured through createProject on the merged tree.
  // Recomputed 2026-10-01 on the merge of develop (PRD-470/471/472/474) into the rain + snow
  // branch (PRD-469, PRD-473): the merged tree carries both sides' engine and manifest bytes, so
  // all thirteen trees, rain and snow included, were re-measured through createProject.
  // Recomputed 2026-10-02 rebasing the FabCLI manual-login fallback onto develop: the shared
  // threenative-assets skill ships in every scaffold, so all thirteen trees move.
  // Recomputed 2026-10-02 on the merge of develop 114e268ef into the strata branch
  // (PRD-466/467/468): the merged tree carries both sides' template bytes, so eleven trees were
  // re-measured through createProject. Rain and snow carry none of this branch's template changes
  // and kept develop's values.
  // Measured through actual createProject trees after exposure/fog consolidation and restamping,
  // then again on the merge carrying the WebGPU adapter-retention Three patch: the scaffolded
  // `patches/three@0.185.1.patch` is the only byte that moved on top of the exposure/fog tree, so
  // all thirteen trees move again. Values below are the merged-tree measurement, not either side's.
  // Recomputed on the PRD-478 merge into PR 473 (develop b12b257f1 + the runbook branch): the
  // merged Three patch changes every kit; starter also carries the merged render source.
  // Recomputed 2026-10-09 on the merge of develop (31 commits, PRD-494 sharded bundles) into the
  // strata branch: measured through createProject on the merged tree.
  // Recomputed 2026-10-10 after integrating develop 1a5314a1: measured through createProject on
  // the merged tree, including its latest template changes.
  // Recomputed through all thirteen actual createProject trees after merging develop 2d2124792
  // into PRD-571; these fingerprints cover both the exposure and landed base changes.
  "action-rpg": "257fa6d8b3e95c642f829600a74eee7d203deacf356f31dd047181df2da2c033",
  minimal: "095a48b7498f6728b60daf13deceff0d93c22045cb903d0319ad80816c6f2365",
  platformer: "f0ae170f7b2e9bb52e6a0887d36d7385ef5709e6538cb84595a702ad7e367b46",
  puzzle: "a6fb07854dafd8c319dd9aa0dd4fe1cc78b2ae07c555ea3fa250ac2b2a1453a6",
  racing: "7dd7aa66804a454f2c3ae6b16e32517f7cdcd92c0f5b38ff971c7ebf66fc834e",
  rain: "93f8227373687566e46cc8d7f03586cb346b05bb5a5589c97a3e0ee83be76d91",
  rts: "67f59aeac3cf3f8af6a3df412824293b7b1ac1f8f1e6a96ee6565bb29b7624b1",
  runner: "82a16382e3d09128324d03468ef9e69fa2ba5c85c8441be3e2d1342e57d4b47d",
  // Initial finite-height readiness plus its scene-owned lifecycle helper and mirrored docs.
  sailing: "349e4e8d9b6e0bf2b7508828fb2422b4007b5724cc76e48785e87c9ab25a0d7b",
  shooter: "772513e8e41b1e241863fe9c74bf207085968102e45337b4868d2451609aad52",
  snow: "53a8e6e9e8a01f1699ba063368e994d6e1f1431ea580d4fa7270a2c11c661489",
  starter: "9d49e7de6d900b217cb6b7ac382309930764e29bda18297659bca4d7137a831b",
  "tower-defense": "e409e2de944c81ecd03d31b5ee404ff763263f8acb414e274e37546bc14da01a",
};

const GENERATED_SCAFFOLD_METADATA =
  /^(?:node_modules(?:\/|$)|dist(?:\/|$)|\.vite(?:\/|$)|coverage(?:\/|$)|pnpm-lock\.yaml$|package-lock\.json$|yarn\.lock$)/u;

/** Stages a broken template in a throwaway copy of the template tree and hands the body its
 * root, so a negative control never edits the shipped templates. It used to edit them in place
 * and put them back: `createProject` resolved its own root, so there was nowhere else to stage
 * one. Vitest runs spec files in parallel, so any file scaffolding `starter` during that window
 * read a template that was broken on purpose for this one — `build.spec.ts` failed intermittently
 * on `must launch from './node_modules/', not '-y'`, a red with nothing wrong behind it.
 * `createProject` now takes a template root; the copy is this test's alone. */
async function withBrokenTemplateFile<T>(
  relativePath: string,
  content: string | undefined,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await makeTempDir("threenative-broken-template-");
  try {
    // The package layout the scaffolder reads: templates/ plus the package-level siblings it
    // reaches up to (template-assets, agent-docs, agent-files). The copied tree
    // is the templates dir; the siblings ride along so a test breaks exactly the file it names.
    const packageDirectory = path.dirname(TEMPLATE_ROOT);
    for (const sibling of ["template-assets", "agent-docs", "agent-files"]) {
      await cp(path.join(packageDirectory, sibling), path.join(root, sibling), {
        recursive: true,
      });
    }
    await cp(TEMPLATE_ROOT, path.join(root, "templates"), { recursive: true });
    const file = relativePath.startsWith("agent-files/")
      ? path.join(root, relativePath)
      : path.join(root, "templates", relativePath);
    if (content === undefined) await rm(file);
    else await writeFile(file, content);
    return await body(path.join(root, "templates"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function scaffoldTreeHash(directory: string): Promise<string> {
  const files: Array<[string, Buffer]> = [];
  async function walk(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const file = path.join(current, entry.name);
      // A linked skill directory reports isDirectory() false, so it needs the stat to be walked
      // like the real one — otherwise the tree hash silently drops half of every skill.
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await stat(file)).isDirectory())) {
        await walk(file);
      } else {
        const relative = path.relative(directory, file);
        if (!GENERATED_SCAFFOLD_METADATA.test(relative)) {
          files.push([relative, await readFile(file)]);
        }
      }
    }
  }
  await walk(directory);
  const hash = createHash("sha256");
  for (const [relative, contents] of files) {
    hash.update(relative).update("\0").update(contents).update("\0");
  }
  return hash.digest("hex");
}

const STARTER_PATHS = [
  // Ignores the asset compile step's generated outputs; the sources in assets/ ship.
  ".gitignore",
  ".codex/config.toml",
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/hooks/ponytail-context.mjs",
  ".claude/skills/ponytail/SKILL.md",
  ".agents/skills/ponytail/SKILL.md",
  ".codex/hooks.json",
  "kit.json",
  "package.json",
  "patches/three@0.185.1.patch",
  "patches/vite@8.2.0.patch",
  "patches/@tailwindcss__node@4.3.3.patch",
  "threenative.config.ts",
  "tools/look.mjs",
  "scripts/reference.mjs",
  "scripts/visual-loop.mjs",
  "index.html",
  "tailwind.config.ts",
  "tsconfig.json",
  "src/style.css",
  "vite.config.ts",
  "src/game.ts",
  "src/main.ts",
  "src/scenes/Play.ts",
  "src/render/lighting.ts",
  "src/render/postprocessing.ts",
  "src/render/worldEnvironment.ts",
  "src/render/temporalAA.ts",
  "src/render/temporalAAInput.ts",
  "src/render/temporalAAResolve.ts",
  "src/render/temporalCurrentArea.ts",
  "src/render/temporalCurrentFootprint.ts",
  "src/render/temporalCurrentFootprintMath.ts",
  "src/render/temporalCurrentProducer.ts",
  "src/render/temporalCurrentReplay.ts",
  "src/render/temporalCurrentSelection.ts",
  "src/render/temporalCurrentVisibility.ts",
  "src/render/temporalResolve.ts",
  "src/render/exposure.ts",
  "src/render/autoExposure.ts",
  "src/render/volumetricFog.ts",
  "src/render/volumetricFogOptions.ts",
  "src/render/volumetricFogVolume.ts",
  "src/render/volumetricFogTransport.ts",
  "src/render/palette.ts",
  "src/render/materials.ts",
  "src/render/arena.ts",
  "src/render/shapes.ts",
  "src/render/camera.ts",
  "src/render/easing.ts",
  "src/render/sky.ts",
  "src/render/pennant.ts",
  "src/render/loading.ts",
  "src/entities/Crate.ts",
  "src/entities/Goal.ts",
  "src/entities/Player.ts",
  "src/ui/Hud.tsx",
  "src/ui/Menu.tsx",
  "src/ui/GameUi.tsx",
  "src/ui/main.tsx",
  "src/ui/App.tsx",
  "src/state.ts",
  // PRD-449: three, and only the three that prove a new game works. The other 21 are engine
  // guards in `packages/create-threenative/template-playtests/starter/`, which `pnpm test:templates`
  // copies into the scaffold; the "exactly three" assertion below is what keeps them out.
  "playtests/survives.playtest.json",
  "playtests/play.playtest.json",
  "native-playtests/react-hud.playtest.json",
  "playtests/production-readiness.playtest.json",
  "assets/native-proof.glb",
  "assets/native-proof.png",
  "public/icon.png",
  "assets/pickup.wav",
  // PRD-449: no `agent-docs/` — the recipes ship in the installed `create-threenative`, and the
  // "ships no reference bundle" test is what pins that.
];

const MINIMAL_RENDER_PATHS = [
  "src/render/palette.ts",
  "src/render/camera.ts",
  "src/render/sky.ts",
  "src/render/lighting.ts",
  "src/render/loading.ts",
  "src/render/materials.ts",
  "src/render/postprocessing.ts",
] as const;

const PLATFORMER_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "kit.json",
  "package.json",
  "threenative.config.ts",
  "src/game.ts",
  "src/main.ts",
  "src/state.ts",
  "src/scenes/Boot.ts",
  "src/scenes/Play.ts",
  "src/entities/Fox.ts",
  "src/entities/Pickup.ts",
  "src/entities/Walker.ts",
  "src/level/Checkpoints.ts",
  "src/level/Stage.ts",
  "src/render/blocks.ts",
  "src/render/camera.ts",
  "src/render/fox.ts",
  "src/render/lighting.ts",
  "src/render/loading.ts",
  "src/render/materials.ts",
  "src/render/palette.ts",
  "src/render/pickups.ts",
  "src/render/postprocessing.ts",
  "src/render/props.ts",
  "src/render/sky.ts",
  "src/render/scenery.ts",
  "src/render/walkers.ts",
  "src/render/waterfall.ts",
  "public/icon.png",
  "playtests/coyote.playtest.json",
  "playtests/collect.playtest.json",
  "playtests/damage.playtest.json",
  "playtests/hud.playtest.json",
  "playtests/jump.playtest.json",
  "playtests/move.playtest.json",
  "playtests/respawn.playtest.json",
  "playtests/stomp.playtest.json",
  "playtests/survives.playtest.json",
  "playtests/performance.playtest.json",
  "playtests/native/touch-controls.playtest.json",
];

describe("create-threenative", () => {
  it("discovers manifests and generates its template help from them", () => {
    const manifests = discoverKitManifests(TEMPLATE_ROOT);
    expect(manifests.map(({ name }) => name)).toEqual(
      [...manifests].map(({ name }) => name).sort(),
    );
    for (const name of ["minimal", "platformer", "starter"]) {
      expect(manifests.some((manifest) => manifest.name === name)).toBe(true);
    }
    expect(manifests.find(({ name }) => name === "platformer")).toMatchObject({
      blurb: expect.any(String),
      genre: "platformer",
      kit: true,
      title: "Fox Dash",
    });
    const help = cliHelp();
    expect(help).toContain("Templates:");
    const width = Math.max(...manifests.map(({ name }) => name.length));
    for (const manifest of manifests) {
      expect(help).toContain(
        `${manifest.name.padEnd(width)}  ${manifest.title}: ${manifest.blurb}`,
      );
    }
  });

  it("derives the scaffold completion message from every discovered kit", async () => {
    const root = await makeTempDir("threenative-message-manifests-");
    try {
      const templates = path.join(root, "templates");
      await cp(TEMPLATE_ROOT, templates, { recursive: true });
      await cp(path.join(KIT_FIXTURE_ROOT, "scratch"), path.join(templates, "scratch"), {
        recursive: true,
      });
      const manifests = discoverKitManifests(templates);

      expect(scaffoldCompletionMessage(manifests)).toBe(
        `Templates: ${manifests
          .map(({ name }) => (name === "starter" ? `${name} (default)` : name))
          .join(", ")}. Choose with --template <name>.\n`,
      );
      expect(scaffoldCompletionMessage(manifests)).toContain("scratch");
      const source = await readFile(
        path.resolve("packages/create-threenative/src/index.ts"),
        "utf8",
      );
      expect(source).toContain("scaffoldCompletionMessage(discoverKitManifests())");
      expect(source).not.toContain("Templates: minimal (smallest)");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps package flags and template substitution single-sourced", async () => {
    const source = await readFile(path.resolve("packages/create-threenative/src/index.ts"), "utf8");
    expect(source.match(/const PACKAGE_SOURCE_FLAGS =/gu)).toHaveLength(1);
    expect(
      source.match(/type PackageSourceName = keyof typeof PACKAGE_SOURCE_FLAGS;/gu),
    ).toHaveLength(1);
    expect(source).not.toMatch(/type PackageSourceName = ["']/u);
    expect(
      source.match(/for \(const \[name, flag\] of Object\.entries\(PACKAGE_SOURCE_FLAGS\)\)/gu),
    ).toHaveLength(1);
    expect(source).not.toContain("for (const [name, flag] of [");
    expect(source.match(/function substituteTemplateVariables\(/gu)).toHaveLength(1);
    // Declaration plus its one call: `renderTemplate`. The reference bundle no longer renders
    // through it (PRD-449), so a second call site means a new substitution nobody gated.
    expect(source.match(/substituteTemplateVariables\(/gu)).toHaveLength(2);
    expect(source.match(/replaceAll\(placeholder, value\)/gu)).toHaveLength(1);
  });

  it("keeps every no-install scaffold tree byte-stable against the PRD parent", async () => {
    const root = await makeTempDir("threenative-scaffold-stability-");
    try {
      const actual: Record<string, string> = {};
      for (const template of ALL_TEMPLATES) {
        const { target } = await createProject(
          { install: false, target: template, template },
          root,
        );
        expect(PRD_201_PARENT_SCAFFOLD_HASHES[template]).toBeDefined();
        actual[template] = await scaffoldTreeHash(target);
      }
      expect(actual).toEqual(PRD_201_PARENT_SCAFFOLD_HASHES);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("copies the canonical native icon to every fixed generated output", async () => {
    const canonical = await readFile(
      path.resolve("packages/create-threenative/template-assets/icon.png"),
    );
    const root = await makeTempDir("threenative-scaffold-icon-");
    try {
      for (const template of ALL_TEMPLATES) {
        const { target } = await createProject(
          { install: false, target: `${template}-game`, template },
          root,
        );
        expect(await readFile(path.join(target, "public/icon.png")), template).toEqual(canonical);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // PRD-449: the pages ship inside the installed `create-threenative`, so the scaffold writes no
  // `agent-docs/` at all. The links the generated instructions carry must still resolve, or a
  // cold agent follows one into a dead path — checked here against the package's bundle, which is
  // exactly what the package's `files` list installs.
  it("should ship no reference bundle and leave every link resolving in the package", async () => {
    const root = await makeTempDir("threenative-reference-bundle-");
    const bundleDirectory = path.resolve("packages/create-threenative/agent-docs/references");
    try {
      const result = await createProject(
        { install: false, target: "my-game", template: "starter" },
        root,
      );
      await expect(lstat(path.join(result.target, "agent-docs"))).rejects.toThrow();
      const instructionFiles = [
        "AGENTS.md",
        "CLAUDE.md",
        ...(await readdir(path.join(result.target, ".agents/skills"))).map(
          (skill) => `.agents/skills/${skill}/SKILL.md`,
        ),
      ];
      for (const file of instructionFiles) {
        const content = await readFile(path.join(result.target, file), "utf8");
        const pages = [
          ...content.matchAll(
            /create-threenative\/agent-docs\/references\/([a-z0-9][a-z0-9-]*\.md)/gu,
          ),
        ].map((match) => match[1] ?? "");
        for (const page of pages) {
          expect(
            existsSync(path.join(bundleDirectory, page)),
            `${file} links a page the package does not ship: ${page}`,
          ).toBe(true);
        }
        // Not a vacuous pass: the template's own instructions are the link index.
        if (file === "AGENTS.md") expect(pages.length).toBeGreaterThan(10);
      }
      // Nothing substitutes into the pages any more, so a token would ship literally.
      for (const page of await readdir(bundleDirectory)) {
        const content = await readFile(path.join(bundleDirectory, page), "utf8");
        expect(content, page).not.toContain("__PROJECT_NAME__");
        expect(content, page).not.toContain("__PROJECT_ID__");
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("should expose the shared visual workflow and authoring scripts in a fresh scaffold", async () => {
    const root = await makeTempDir("threenative-dream-loop-scaffold-");
    try {
      const result = await createProject(
        { install: false, target: "dream-game", template: "starter" },
        root,
      );
      // The page lives in the installed package, not the project (PRD-449); the generated skill
      // still points at the file it ships.
      const workflow = await readFile(
        path.resolve("packages/create-threenative/agent-docs/references/dream-loop.md"),
        "utf8",
      );
      expect(workflow).toContain("node scripts/reference.mjs");
      expect(workflow).toContain("node scripts/visual-loop.mjs");
      expect(workflow).toContain("Anshu Chimala");
      for (const host of [".agents/skills", ".claude/skills"]) {
        const visual = await readFile(
          path.join(result.target, host, "threenative-visuals/SKILL.md"),
          "utf8",
        );
        const assets = await readFile(
          path.join(result.target, host, "threenative-assets/SKILL.md"),
          "utf8",
        );
        expect(visual).toContain(REFERENCE_PREFIX);
        expect(assets).toContain(REFERENCE_PREFIX);
      }
      await expect(stat(path.join(result.target, "scripts/reference.mjs"))).resolves.toBeTruthy();
      await expect(stat(path.join(result.target, "scripts/visual-loop.mjs"))).resolves.toBeTruthy();
      const gitignore = await readFile(path.join(result.target, ".gitignore"), "utf8");
      for (const rule of [".dream-loop/", "node_modules/", ".env", ".env.*", "!.env.example"])
        expect(gitignore).toContain(rule);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // One stored copy, two host directories. A duplicated skill drifts the day one adapter is
  // edited, and a copied `capabilities.json` drifts the day the engine dependency moves — the
  // installed `@threenative/core` copy is what the MCP actually reads.
  it("should store each skill once and link it into the Claude host directory", async () => {
    const root = await makeTempDir("threenative-single-skill-copy-");
    try {
      const { target } = await createProject(
        { install: false, target: "linked-skill-game", template: "starter" },
        root,
      );
      const claudeSkills = path.join(target, ".claude", "skills");
      const stored = (
        await readdir(path.join(target, ".agents", "skills"), { withFileTypes: true })
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(stored.length).toBeGreaterThan(0);
      // Claude Code gets builder and verifier as subagents, not skills, so it has no skill to link.
      const linked = (await readdir(claudeSkills, { withFileTypes: true })).map(
        (entry) => entry.name,
      );
      for (const subagentOnly of ["threenative-builder", "threenative-verifier"]) {
        expect(stored).toContain(subagentOnly);
        expect(linked, subagentOnly).not.toContain(subagentOnly);
        await expect(lstat(path.join(claudeSkills, subagentOnly))).rejects.toThrow();
        await expect(
          lstat(path.join(target, ".claude", "agents", `${subagentOnly}.md`)),
        ).resolves.toBeTruthy();
      }
      expect(linked.sort()).toEqual(
        stored.filter((name) => !["threenative-builder", "threenative-verifier"].includes(name)),
      );
      for (const name of linked) {
        const link = path.join(claudeSkills, name);
        expect((await lstat(link)).isSymbolicLink(), `${name} is a second stored copy`).toBe(true);
        expect(await realpath(link)).toBe(
          await realpath(path.join(target, ".agents", "skills", name)),
        );
      }
      for (const dropped of ["capabilities.json", "AGENT-ROLES.md"]) {
        await expect(lstat(path.join(target, dropped)), dropped).rejects.toThrow();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // One stored copy per skill: `.claude/skills` is a symlink into `.agents/skills`, so breaking the
  // stored file breaks both host reads the scaffolder asserts on.
  it.each([
    "agent-files/.agents/skills/threenative-visuals/SKILL.md",
    "agent-files/.agents/skills/threenative-assets/SKILL.md",
  ])("should fail when %s names an absent dream-loop recipe", async (relativePath) => {
    const source = await readFile(
      path.resolve("packages/create-threenative", relativePath),
      "utf8",
    );
    await withBrokenTemplateFile(
      relativePath,
      source.replaceAll(
        `${REFERENCE_PREFIX}dream-loop.md`,
        `${REFERENCE_PREFIX}missing-dream-loop.md`,
      ),
      async (root) => {
        await expect(
          createProject(
            { install: false, target: "broken-dream-game", template: "starter" },
            path.dirname(root),
            root,
          ),
        ).rejects.toThrow(/RED observed: referenced recipe missing/u);
      },
    );
  });

  it("should preserve asset licensing and sculpt gates when target acquisition is used", async () => {
    const recipe = await readFile(
      path.resolve("packages/create-threenative/agent-docs/references/sculpt-from-a-reference.md"),
      "utf8",
    );
    expect(recipe).toContain(`${REFERENCE_PREFIX}dream-loop.md`);
    expect(recipe).toContain("CREDITS.md");
    const assets = await readFile(
      path.resolve(
        "packages/create-threenative/agent-files",
        ".agents/skills",
        "threenative-assets/SKILL.md",
      ),
      "utf8",
    );
    expect(assets).toContain("sculpt_plan");
    expect(assets).toContain("sculpt_spec_gate");
    expect(assets).toContain("sculpt_compare");
    expect(assets).toContain("sculpt_pass_gate");
    expect(assets).toContain(`${REFERENCE_PREFIX}dream-loop.md`);
    expect(assets).toContain("CREDITS.md");
  });

  it.each(ALL_TEMPLATES)(
    "should overlay the canonical builder and verifier roles on the %s scaffold",
    async (template) => {
      const root = await makeTempDir(`threenative-agent-roles-${template}-`);
      try {
        const result = await createProject(
          { install: false, target: `${template}-game`, template },
          root,
        );
        const contents = await Promise.all(
          AGENT_ROLE_PATHS.map(async (relativePath) => {
            const content = await readFile(path.join(result.target, relativePath), "utf8");
            expect(content, relativePath).not.toContain("__PROJECT_NAME__");
            expect(content, relativePath).not.toContain("__PROJECT_ID__");
            return [relativePath, content] as const;
          }),
        );
        const files = new Map(contents);
        const builder = files.get(".threenative/agents/builder.md") ?? "";
        const verifier = files.get(".threenative/agents/verifier.md") ?? "";
        expect(builder).toContain("one bounded player-visible outcome");
        expect(builder).toContain("engine-owned or game-owned");
        expect(builder).toContain("production readiness");
        expect(verifier.toLowerCase()).toContain("read-only");
        expect(verifier).toContain("must not edit");
        expect(new Set(verifier.match(/`(?:PASS|REQUEST_CHANGES|NOT_OBSERVED)`/gu))).toEqual(
          new Set(["`PASS`", "`REQUEST_CHANGES`", "`NOT_OBSERVED`"]),
        );

        const adapterPaths = [
          [".claude/agents/threenative-builder.md", ".claude/agents/threenative-verifier.md"],
          [
            ".agents/skills/threenative-builder/SKILL.md",
            ".agents/skills/threenative-verifier/SKILL.md",
          ],
        ] as const;
        for (const [builderPath, verifierPath] of adapterPaths) {
          const builderAdapter = files.get(builderPath) ?? "";
          const verifierAdapter = files.get(verifierPath) ?? "";
          expect(builderAdapter).toContain(".threenative/agents/builder.md");
          expect(builderAdapter).toContain("AGENTS.md");
          expect(verifierAdapter).toContain(".threenative/agents/verifier.md");
          expect(verifierAdapter).toContain("AGENTS.md");
          expect(builderAdapter.length).toBeLessThan(500);
          expect(verifierAdapter.length).toBeLessThan(500);
        }

        const bugSkillBodies = await Promise.all(
          BUG_REPORT_SKILL_PATHS.map(async (relativePath) => {
            const content = await readFile(path.join(result.target, relativePath), "utf8");
            expect(content, relativePath).not.toContain("__PROJECT_NAME__");
            expect(content, relativePath).not.toContain("__PROJECT_ID__");
            return content;
          }),
        );
        for (const skill of bugSkillBodies) {
          expect(skill).toContain("gh auth status");
          expect(skill).toContain("gh issue create");
          expect(skill).toContain("ThreeNativeHQ/threenative");
        }
        // Both host adapters ship one recipe; a drift between them ships two contracts.
        expect(new Set(bugSkillBodies).size).toBe(1);
        const packageJson = JSON.parse(
          await readFile(path.join(result.target, "package.json"), "utf8"),
        ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const dependencyNames = [
          ...Object.keys(packageJson.dependencies ?? {}),
          ...Object.keys(packageJson.devDependencies ?? {}),
        ];
        expect(dependencyNames).not.toContain("claude");
        expect(dependencyNames).not.toContain("codex");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps the starter's shipped assets mobile-shippable", async () => {
    // Mobile has no WebAssembly, so neither Basis-decoded textures nor Meshopt-decoded geometry
    // can ship there — the red hit on 2026-08-27: `build:android` on a machine with the Basis
    // encoder refused TN_NATIVE_KTX2_UNSUPPORTED on a starter scaffold that had built clean the
    // week before, purely because the encoder got installed in between.
    //
    // The template used to pin `models`/`textures` to `"none"` to prevent it, which held for
    // android and followed the same game onto web: one shipped 2,003 MB of manifest output with
    // no compressed texture in it. The build names its `--target` and the compile step now drops
    // the passes that target cannot decode, so this asserts what a mobile bake *produces* rather
    // than what the config file says — and the web bake of the same config stays compressed.
    const root = await makeTempDir("threenative-scaffold-mobile-");
    try {
      await mkdir(path.join(root, "assets"), { recursive: true });
      await cp(path.join(TEMPLATE_ROOT, "starter", "assets"), path.join(root, "assets"), {
        recursive: true,
      });
      // Gradients with ±3 levels of noise resist PNG compression without violating PRD-351's quality floor like pure noise.
      const noise = (x: number, y: number, shift: number): number => {
        let value = Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 1, 0x27d4eb2d);
        value ^= value >>> 16;
        return ((value >>> shift) % 7) - 3;
      };
      await writeFile(
        path.join(root, "assets", "web-codec-proof.png"),
        rgbaPng({
          blue: (x, y) => 48 + Math.floor((x + y) / 2) + noise(x, y, 16),
          green: (x, y) => 48 + y + noise(x, y, 8),
          height: 128,
          red: (x, y) => 48 + x + noise(x, y, 0),
          width: 128,
        }),
      );

      await compileAssets({ cwd: root, platform: "android" });
      const android = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      ) as { entries: Record<string, { extensions?: string[]; output: string }> };
      const mobileOutputs = Object.values(android.entries);
      expect(mobileOutputs.length).toBeGreaterThan(0);
      for (const entry of mobileOutputs) {
        expect(entry.output).not.toMatch(/\.ktx2$/u);
        expect(entry.extensions ?? []).not.toContain("EXT_meshopt_compression");
      }

      await rm(path.join(root, "public"), { force: true, recursive: true });
      await compileAssets({ cwd: root, platform: "web" });
      const web = JSON.parse(
        await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
      ) as { entries: Record<string, { output: string }> };
      expect(web.entries["native-proof.png"]?.output).toMatch(/\.png$/u);
      expect(web.entries["web-codec-proof.png"]?.output).toMatch(/\.ktx2$/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should generate the starter tree without catalog protocols", async () => {
    const root = await makeTempDir("threenative-scaffold-");
    try {
      const result = await createProject(
        { install: false, target: "my-game", template: "starter" },
        root,
      );
      expect(result.template).toBe("starter");
      const packageJson = await readFile(path.join(result.target, "package.json"), "utf8");
      expect(packageJson).not.toContain("catalog:");
      const packageManifest = JSON.parse(packageJson) as {
        pnpm?: { patchedDependencies?: Record<string, string> };
      };
      expect(packageManifest.pnpm?.patchedDependencies).toEqual({
        "three@0.185.1": "patches/three@0.185.1.patch",
        "vite@8.2.0": "patches/vite@8.2.0.patch",
        "@tailwindcss/node@4.3.3": "patches/@tailwindcss__node@4.3.3.patch",
      });
      expect(STARTER_PATHS).toContain("playtests/survives.playtest.json");
      for (const relativePath of STARTER_PATHS) {
        await expect(
          readFile(path.join(result.target, relativePath), "utf8"),
        ).resolves.toBeTruthy();
      }
      // The whole point of the cut (PRD-449): a new game proves itself with three scenarios, and
      // the engine's own guards live outside the template. `readdir` rather than the STARTER_PATHS
      // membership, so a file nobody added to the list still fails here.
      expect(
        (await readdir(path.join(result.target, "playtests"))).filter((name) =>
          name.endsWith(".playtest.json"),
        ),
      ).toEqual([
        "play.playtest.json",
        "production-readiness.playtest.json",
        "survives.playtest.json",
      ]);
      // A scaffolded project must land with audio every target can decode, WAV included, or its
      // first `--target android` build installs and shows nothing.
      const pickupAudio = await readFile(path.join(result.target, "assets/pickup.wav"));
      expect(pickupAudio.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(pickupAudio.subarray(8, 12).toString("ascii")).toBe("WAVE");
      const agents = await readFile(path.join(result.target, "AGENTS.md"), "utf8");
      expect(agents).toContain("my-game");
      expect(agents).not.toContain("__PROJECT_NAME__");
      await expect(readFile(path.join(result.target, "CLAUDE.md"), "utf8")).resolves.toContain(
        "Generated mirror of AGENTS.md",
      );
      await expect(
        readFile(path.join(result.target, "src/entities/Player.ts"), "utf8"),
      ).resolves.toContain("debug()");
      await expect(
        readFile(path.join(result.target, "src/scenes/Play.ts"), "utf8"),
      ).resolves.toMatch(/ctx\.entities\.add\(\s*"player"/u);
      const renderFiles = await Promise.all(
        ["lighting.ts", "postprocessing.ts", "materials.ts"].map((file) =>
          readFile(path.join(result.target, "src/render", file), "utf8"),
        ),
      );
      expect(renderFiles.join("\n")).not.toContain("@threenative/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The compile step owns public/'s generated outputs; the sources ship in assets/. With no
  // raw copy left in public/, any dev server or build must compile first — which is what
  // playtests/assets.playtest.json proves against a served game.
  it("should ship source assets and never scaffold an empty assets directory", async () => {
    const root = await makeTempDir("threenative-scaffold-assets-");
    try {
      const result = await createProject(
        { install: false, target: "my-game", template: "starter" },
        root,
      );
      await expect(
        readFile(path.join(result.target, "assets/native-proof.glb")),
      ).resolves.toBeTruthy();
      const gitignore = await readFile(path.join(result.target, ".gitignore"), "utf8");
      expect(gitignore).toContain("public/assets.manifest.json");
      for (const absent of ["assets/.gitkeep", "public/assets.manifest.json"]) {
        await expect(stat(path.join(result.target, absent))).rejects.toThrow();
      }
      // The packed CLI itself depends on @threenative/assets, so a local-pack install needs a
      // pnpm override per provided source, not just a rewritten direct pin.
      const sourced = await createProject(
        {
          install: false,
          packageSources: {
            "@threenative/assets": "/tmp/assets.tgz",
            "create-threenative": "/tmp/cli.tgz",
          },
          target: "sourced-game",
          template: "starter",
        },
        root,
      );
      const sourcedManifest = JSON.parse(
        await readFile(path.join(sourced.target, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        pnpm?: { overrides?: Record<string, string> };
      };
      expect(sourcedManifest.devDependencies?.["@threenative/assets"]).toBe("file:/tmp/assets.tgz");
      expect(sourcedManifest.dependencies?.["@threenative/assets"]).toBeUndefined();
      expect(sourcedManifest.pnpm?.overrides).toMatchObject({
        "@threenative/assets": "file:/tmp/assets.tgz",
        "create-threenative": "file:/tmp/cli.tgz",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should generate loader-valid identifiers at the leading-digit boundary", async () => {
    const root = await makeTempDir("threenative-scaffold-identifiers-");
    try {
      for (const [target, expectedId] of [
        ["123-game", "com.threenative.game123game"],
        ["fox-game", "com.threenative.foxgame"],
      ] as const) {
        const result = await createProject({ install: false, target, template: "minimal" }, root);
        await expect(loadConfig(result.target)).resolves.toMatchObject({
          app: { id: expectedId },
          ui: { renderer: "native" },
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should scaffold the minimal six-file render layer", async () => {
    const root = await makeTempDir("threenative-minimal-render-");
    try {
      const result = await createProject(
        { install: false, target: "minimal-look", template: "minimal" },
        root,
      );
      for (const relativePath of MINIMAL_RENDER_PATHS) {
        await expect(
          readFile(path.join(result.target, relativePath), "utf8"),
        ).resolves.toBeTruthy();
      }
      await expect(readFile(path.join(result.target, "src/game.ts"), "utf8")).resolves.toContain(
        "export default game",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(ALL_TEMPLATES)(
    "should bind the game used by UI intents in the %s template",
    async (template) => {
      const source = await readFile(path.join(TEMPLATE_ROOT, template, "src/game.ts"), "utf8");
      if (!source.includes("game.ui.onIntent")) return;
      expect(source).toContain("const game = defineGame");
      expect(source).toContain("export default game");
    },
  );

  it("should not ship recast in a build that never imports the navigation entry", async () => {
    const root = await makeTempDir("threenative-minimal-bundle-");
    try {
      const result = await createProject(
        { install: false, target: "minimal-bundle", template: "minimal" },
        root,
      );
      const scope = path.join(result.target, "node_modules", "@threenative");
      await mkdir(scope, { recursive: true });
      await symlink(path.resolve("packages/core"), path.join(scope, "core"), "dir");
      await symlink(path.resolve("packages/physics"), path.join(scope, "physics"), "dir");
      // The template vite.config.ts imports watchAssets from @threenative/assets in serve
      // mode; a build that resolves the config needs the package present to reject it.
      await symlink(path.resolve("packages/assets"), path.join(scope, "assets"), "dir");
      await symlink(
        path.resolve("packages/create-threenative"),
        path.join(result.target, "node_modules", "create-threenative"),
        "dir",
      );
      const pnpmPackages = await readdir(path.resolve("node_modules/.pnpm"));
      const vitePackage = pnpmPackages.find((entry) => entry.startsWith("vite@"));
      const threePackage = pnpmPackages.find((entry) => entry.startsWith("three@"));
      if (vitePackage === undefined || threePackage === undefined) {
        throw new Error("Bundle isolation requires the workspace Vite and Three.js packages.");
      }
      await symlink(
        path.resolve("node_modules/.pnpm", vitePackage, "node_modules/vite"),
        path.join(result.target, "node_modules", "vite"),
        "dir",
      );
      await symlink(
        path.resolve("node_modules/.pnpm", threePackage, "node_modules/three"),
        path.join(result.target, "node_modules", "three"),
        "dir",
      );
      try {
        const viteCli = path.resolve(
          "node_modules/.pnpm",
          vitePackage,
          "node_modules/vite/bin/vite.js",
        );
        await run(process.execPath, [viteCli, "build", result.target], { cwd: process.cwd() });
      } catch (error) {
        const output = error as { code?: string | number; stderr?: string; stdout?: string };
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} code=${output.code ?? "unknown"}\n${output.stdout ?? ""}\n${output.stderr ?? ""}`,
        );
      }
      const distRoot = path.join(result.target, "dist");
      const entries = await readdir(distRoot, { recursive: true });
      const files = (
        await Promise.all(
          entries.map(async (entry) => {
            const relativePath = String(entry);
            return (await stat(path.join(distRoot, relativePath))).isFile()
              ? relativePath
              : undefined;
          }),
        )
      ).filter((entry): entry is string => entry !== undefined);
      const artifactNames = files.filter((file) => file.toLowerCase().includes("recast"));
      const contents = await Promise.all(
        files.map(async (file) => {
          const value = await readFile(path.join(result.target, "dist", file));
          return value.toString("utf8");
        }),
      );

      expect(artifactNames).toEqual([]);
      expect(contents.join("\n")).not.toMatch(/recast-navigation|@recast-navigation/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("should parse the no-install and template flags", () => {
    expect(parseArgs(["my-game", "--template", "minimal", "--no-install"])).toEqual({
      install: false,
      target: "my-game",
      template: "minimal",
    });
  });

  it("should reject an occupied or file target and create nested parents", async () => {
    const root = await makeTempDir("threenative-target-collisions-");
    try {
      await mkdir(path.join(root, "occupied"), { recursive: true });
      await writeFile(path.join(root, "occupied", "keep.txt"), "x");
      await expect(createProject({ install: false, target: "occupied" }, root)).rejects.toThrow(
        /already exists and is not empty/u,
      );

      await writeFile(path.join(root, "a-file"), "x");
      await expect(createProject({ install: false, target: "a-file" }, root)).rejects.toThrow(
        /already exists and is not empty/u,
      );

      const result = await createProject({ install: false, target: "nested/deep/game" }, root);
      expect(result.target.endsWith("nested/deep/game")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("should fail closed on a malformed kit manifest with the exact named codes", async () => {
    const templates = path.join(await makeTempDir("threenative-kit-manifest-"), "templates");
    const valid = {
      blurb: "collect pickups",
      genre: "arcade",
      kit: true,
      name: "pickup",
      title: "Pickup Run",
    };
    const cases: ReadonlyArray<[string, string, RegExp]> = [
      ["noparse", "not json", /TN_KIT_MANIFEST_INVALID.*JSON could not be parsed/u],
      ["array", "[]", /root must be an object/u],
      [
        "name-mismatch",
        JSON.stringify({ ...valid, name: "other" }),
        /name 'other' must match directory 'name-mismatch'/u,
      ],
      [
        "not-kit",
        JSON.stringify({ ...valid, name: "not-kit", kit: "yes" }),
        /kit must be a boolean/u,
      ],
      [
        "no-blurb",
        JSON.stringify({ ...valid, name: "no-blurb", blurb: "" }),
        /blurb must be a non-empty string/u,
      ],
      [
        "no-genre",
        JSON.stringify({ ...valid, name: "no-genre", genre: 7 }),
        /genre must be a non-empty string/u,
      ],
      [
        "no-title",
        JSON.stringify({ ...valid, name: "no-title", title: "" }),
        /title must be a non-empty string/u,
      ],
    ];
    try {
      for (const [name, content, expected] of cases) {
        const directory = path.join(templates, name);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "kit.json"), content);
        try {
          expect(() => discoverKitManifests(templates)).toThrow(expected);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      expect(discoverKitManifests(templates)).toEqual([]);
    } finally {
      await rm(templates, { recursive: true, force: true });
    }
  });

  it("should parse flags that precede the target directory", () => {
    expect(parseArgs(["--no-install", "my-game"])).toEqual({
      install: false,
      target: "my-game",
    });
    expect(parseArgs(["--template", "minimal", "--no-install", "my-game"])).toEqual({
      install: false,
      target: "my-game",
      template: "minimal",
    });
  });

  it("should parse equals-form flags", () => {
    expect(parseArgs(["--template=minimal", "my-game"])).toEqual({
      install: true,
      target: "my-game",
      template: "minimal",
    });
    expect(parseArgs(["--no-install", "--cli-package=/tmp/cli.tgz", "my-game"])).toEqual({
      install: false,
      packageSources: { "create-threenative": "/tmp/cli.tgz" },
      target: "my-game",
    });
  });

  it("should fail closed on unknown and dangling flags instead of ignoring them", () => {
    expect(() => parseArgs(["my-game", "--tempalte", "minimal"])).toThrow(
      "Unknown option '--tempalte'. Usage: pnpm create threenative my-game",
    );
    expect(() => parseArgs(["my-game", "--template"])).toThrow(
      "Option '--template' requires a value. Usage: pnpm create threenative my-game",
    );
    expect(() => parseArgs(["my-game", "other-game"])).toThrow(
      "Unexpected extra argument 'other-game'. Usage: pnpm create threenative my-game",
    );
  });

  it("should scaffold the platformer template with no catalog protocols", async () => {
    const root = await makeTempDir("threenative-platformer-");
    try {
      const result = await createProject(
        { install: false, target: "fox-run", template: "platformer" },
        root,
      );
      expect(result.template).toBe("platformer");
      const packageJson = await readFile(path.join(result.target, "package.json"), "utf8");
      expect(packageJson).not.toContain("catalog:");
      for (const relativePath of PLATFORMER_PATHS) {
        await expect(
          readFile(path.join(result.target, relativePath), "utf8"),
        ).resolves.toBeTruthy();
      }
      await expect(
        readFile(path.join(result.target, "src/entities/Fox.ts"), "utf8"),
      ).resolves.toContain("FOX_FEEL");
      await expect(
        readFile(path.join(result.target, "src/scenes/Play.ts"), "utf8"),
      ).resolves.toContain('ctx.entities.add("player"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("should launch all three MCP servers through the core shims", async () => {
    const root = await makeTempDir("threenative-mcp-");
    try {
      const result = await createProject(
        { install: false, target: "my-game", template: "starter" },
        root,
      );
      const raw = await readFile(path.join(result.target, ".mcp.json"), "utf8");
      expect(raw).not.toContain("npx");
      const config = JSON.parse(raw) as {
        mcpServers: Record<string, { args: string[]; command: string }>;
      };
      const assetServer = config.mcpServers["threenative-assets"];
      expect(assetServer?.command).toBe("node");
      expect(assetServer?.args[0]).toBe(`${CORE_SHIM}/assets.mjs`);
      const sculptServer = config.mcpServers["threenative-sculpt"];
      expect(sculptServer?.command).toBe("node");
      expect(sculptServer?.args[0]).toBe(`${CORE_SHIM}/sculpt.mjs`);
      const engineServer = config.mcpServers["threenative-engine"];
      expect(engineServer?.command).toBe("node");
      expect(engineServer?.args[0]).toBe(`${CORE_SHIM}/engine.mjs`);
      const codex = await readFile(path.join(result.target, ".codex", "config.toml"), "utf8");
      expect(codex).toContain("[mcp_servers.threenative-engine]");
      expect(codex).toContain(`args = ["${CORE_SHIM}/engine.mjs"]`);
      const manifest = JSON.parse(
        await readFile(path.join(result.target, "package.json"), "utf8"),
      ) as { devDependencies?: Record<string, string> };
      expect(manifest.devDependencies?.[ASSET_MCP]).toBeUndefined();
      expect(manifest.devDependencies?.[SCULPT_MCP]).toBeUndefined();
      expect(manifest.devDependencies?.[ENGINE_MCP]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Being on disk is not the same as shipping. `.gitignore` carries an unanchored `.mcp.json`
  // rule for the copy an install writes at the repo root, and it swallowed the template copies
  // too: the file generated fine, `git status` stayed silent, and the template shipped without
  // it. Four suites then failed on CI with
  //   Error: Scaffold produced no .mcp.json at '.../puzzle/.mcp.json'
  // for a file that was present on the author's machine the entire time. Reading the working
  // tree cannot catch that. Asking git what it tracks can.
  it("should track every template's agent config, not merely have it on disk", async () => {
    const { stdout } = await run("git", [
      "ls-files",
      "--",
      "packages/create-threenative/templates/*/.mcp.json",
    ]);
    const tracked = new Set(
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
    const missing = ALL_TEMPLATES.filter(
      (template) => !tracked.has(`packages/create-threenative/templates/${template}/.mcp.json`),
    );
    expect(
      missing,
      "these templates' .mcp.json is untracked; git is ignoring it and the scaffold ships without it",
    ).toEqual([]);
  });

  it("should ship the same MCP config and pins in every template", async () => {
    const configs = await Promise.all(
      ALL_TEMPLATES.map((template) => readFile(path.join(TEMPLATE_ROOT, template, ".mcp.json"))),
    );
    const codexConfigs = await Promise.all(
      ALL_TEMPLATES.map((template) =>
        readFile(path.join(TEMPLATE_ROOT, template, ".codex", "config.toml")),
      ),
    );
    const pins = await Promise.all(
      ALL_TEMPLATES.map(async (template) => {
        const manifest = JSON.parse(
          await readFile(path.join(TEMPLATE_ROOT, template, "package.json"), "utf8"),
        ) as { devDependencies?: Record<string, string> };
        return {
          asset: manifest.devDependencies?.[ASSET_MCP],
          engine: manifest.devDependencies?.[ENGINE_MCP],
          sculpt: manifest.devDependencies?.[SCULPT_MCP],
        };
      }),
    );
    expect(new Set(configs.map((config) => config.toString("utf8"))).size).toBe(1);
    expect(new Set(codexConfigs.map((config) => config.toString("utf8"))).size).toBe(1);
    expect(pins.every(({ asset, engine, sculpt }) => !asset && !engine && !sculpt)).toBe(true);
  });

  it("forces the broken sharp 0.34 line off every template's dependency tree", async () => {
    // `@gltf-transform/cli@4.4.2` drags `sharp ~0.34.5`, whose prebuilt does not load on modern
    // glibc: a plain `npm install` of a scaffold then dies trying to build it from source. The
    // same line is covered by GHSA-rgj7-g3m4-5g8c (`sharp <0.35.4`). PRD-445's root override
    // does not reach a consumer's own project, so every template carries the pin for npm and pnpm.
    for (const template of ALL_TEMPLATES) {
      const manifest = JSON.parse(
        await readFile(path.join(TEMPLATE_ROOT, template, "package.json"), "utf8"),
      ) as { overrides?: Record<string, string>; pnpm?: { overrides?: Record<string, string> } };
      expect(manifest.overrides?.sharp, `${template} npm override`).toBe(">=0.35.4");
      expect(manifest.pnpm?.overrides?.sharp, `${template} pnpm override`).toBe(">=0.35.4");
    }
  });

  it("should document only tools the pinned asset MCP actually serves", async () => {
    const surface = JSON.parse(
      await readFile(path.resolve("packages/create-threenative/asset-mcp-tools.json"), "utf8"),
    ) as { recommended: string[]; tools: string[]; version: string };
    const served = new Set(surface.tools);
    const coreManifest = JSON.parse(
      await readFile(path.resolve("packages/core/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(coreManifest.dependencies?.[ASSET_MCP]).toBe(surface.version);
    const namespaces = new Set(surface.tools.map((tool) => tool.split("_")[0]));
    for (const template of ALL_TEMPLATES) {
      const agents = await readFile(path.join(TEMPLATE_ROOT, template, "AGENTS.md"), "utf8");
      const assetSkill = await readFile(
        path.join(
          TEMPLATE_ROOT,
          "..",
          "agent-files",
          ".agents",
          "skills",
          "threenative-assets",
          "SKILL.md",
        ),
        "utf8",
      );
      const authoringText = `${agents}\n${assetSkill}`;
      const mentioned = [...authoringText.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/gu)]
        .map((match) => match[1] as string)
        .filter((name) => namespaces.has(name.split("_")[0] as string));
      expect(
        mentioned.filter((name) => !served.has(name)),
        template,
      ).toEqual([]);
      for (const name of surface.recommended)
        expect(authoringText, `${template}/${name}`).toContain(name);
    }
  });

  it("should throw when .mcp.json is missing from the template", async () => {
    const root = await makeTempDir("threenative-mcp-missing-");
    try {
      await withBrokenTemplateFile("starter/.mcp.json", undefined, async (templates) => {
        await expect(
          createProject(
            { install: false, target: "my-game", template: "starter" },
            root,
            templates,
          ),
        ).rejects.toThrow(/no \.mcp\.json/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Copies every template tree into a temp dir, which is thousands of files; the 5 s default
    // trips on a loaded machine and reports a timeout where there is no defect.
  }, 30_000);

  it("should throw when .mcp.json omits the sculpt server", async () => {
    const root = await makeTempDir("threenative-mcp-sculpt-missing-");
    try {
      const broken = JSON.stringify({
        mcpServers: {
          "threenative-assets": {
            command: "node",
            args: [`${CORE_SHIM}/assets.mjs`],
          },
        },
      });
      await withBrokenTemplateFile("starter/.mcp.json", broken, async (templates) => {
        await expect(
          createProject(
            { install: false, target: "my-game", template: "starter" },
            root,
            templates,
          ),
        ).rejects.toThrow(/missing required MCP server 'threenative-sculpt'/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Copies every template tree into a temp dir, which is thousands of files; the 5 s default
    // trips on a loaded machine and reports a timeout where there is no defect.
  }, 30_000);

  it("should throw when .mcp.json omits the engine server", async () => {
    const root = await makeTempDir("threenative-mcp-engine-missing-");
    try {
      const broken = JSON.stringify({
        mcpServers: {
          "threenative-assets": {
            command: "node",
            args: [`${CORE_SHIM}/assets.mjs`],
          },
          "threenative-sculpt": {
            command: "node",
            args: [`${CORE_SHIM}/sculpt.mjs`],
          },
        },
      });
      await withBrokenTemplateFile("starter/.mcp.json", broken, async (templates) => {
        await expect(
          createProject(
            { install: false, target: "my-game", template: "starter" },
            root,
            templates,
          ),
        ).rejects.toThrow(/missing required MCP server 'threenative-engine'/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("should throw when .mcp.json names a package the project does not depend on", async () => {
    const root = await makeTempDir("threenative-mcp-undeclared-");
    try {
      const broken = JSON.stringify({
        mcpServers: {
          "threenative-assets": {
            command: "node",
            args: [`${CORE_SHIM}/assets.mjs`],
          },
          "threenative-sculpt": {
            command: "node",
            args: ["./node_modules/not-a-dependency/dist/index.js"],
          },
          "threenative-engine": {
            command: "node",
            args: [`${CORE_SHIM}/engine.mjs`],
          },
          "threenative-blender": {
            command: "node",
            args: [`${CORE_SHIM}/blender.mjs`],
          },
        },
      });
      await withBrokenTemplateFile("starter/.mcp.json", broken, async (templates) => {
        await expect(
          createProject(
            { install: false, target: "my-game", template: "starter" },
            root,
            templates,
          ),
        ).rejects.toThrow(/not-a-dependency.*does not depend on/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Copies every template tree into a temp dir, which is thousands of files; the 5 s default
    // trips on a loaded machine and reports a timeout where there is no defect.
  }, 30_000);

  it("should throw when .mcp.json launches an unpinned remote package", async () => {
    const root = await makeTempDir("threenative-mcp-npx-");
    try {
      const broken = JSON.stringify({
        mcpServers: {
          "threenative-assets": {
            command: "node",
            args: [`${CORE_SHIM}/assets.mjs`],
          },
          "threenative-sculpt": { command: "npx", args: ["-y", SCULPT_MCP] },
          "threenative-engine": {
            command: "node",
            args: [`${CORE_SHIM}/engine.mjs`],
          },
          "threenative-blender": {
            command: "node",
            args: [`${CORE_SHIM}/blender.mjs`],
          },
        },
      });
      await withBrokenTemplateFile("starter/.mcp.json", broken, async (templates) => {
        await expect(
          createProject(
            { install: false, target: "my-game", template: "starter" },
            root,
            templates,
          ),
        ).rejects.toThrow(/must launch from '\.\/node_modules\/'/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Copies every template tree into a temp dir, which is thousands of files; the 5 s default
    // trips on a loaded machine and reports a timeout where there is no defect.
  }, 30_000);

  it("should accept a local playtest package for scaffold smoke tests", () => {
    expect(
      parseArgs(["my-game", "--no-install", "--playtest-package", "/tmp/playtest.tgz"]),
    ).toEqual({
      install: false,
      packageSources: { "@threenative/playtest": "/tmp/playtest.tgz" },
      target: "my-game",
    });
  });

  it("should accept a local package added to the workspace without a CLI map edit", () => {
    expect(
      parseArgs(["my-game", "--no-install", "--new-package-package", "/tmp/new-package.tgz"]),
    ).toEqual({
      install: false,
      packageSources: { "@threenative/new-package": "/tmp/new-package.tgz" },
      target: "my-game",
    });
  });

  it("should accept a local engine MCP package for offline scaffold tests", () => {
    expect(
      parseArgs(["my-game", "--no-install", "--engine-mcp-package", "/tmp/engine-mcp.tgz"]),
    ).toEqual({
      install: false,
      packageSources: { "threenative-engine-mcp": "/tmp/engine-mcp.tgz" },
      target: "my-game",
    });
  });

  it("should accept the short local runtime package override", () => {
    expect(parseArgs(["my-game", "--no-install", "--runtime-package", "/tmp/runtime.tgz"])).toEqual(
      {
        install: false,
        packageSources: { "@threenative/runtime-native": "/tmp/runtime.tgz" },
        target: "my-game",
      },
    );
  });
  it("maps scoped workspace packages with colliding names to distinct source flags", () => {
    expect(
      parseArgs([
        "my-game",
        "--no-install",
        "--threenative-cli-package",
        "/tmp/scoped-cli.tgz",
        "--threenative-engine-mcp-package",
        "/tmp/scoped-engine-mcp.tgz",
      ]),
    ).toEqual({
      install: false,
      packageSources: {
        "@threenative/cli": "/tmp/scoped-cli.tgz",
        "@threenative/engine-mcp": "/tmp/scoped-engine-mcp.tgz",
      },
      target: "my-game",
    });
  });

  it("should keep a local native runtime optional", async () => {
    const root = await makeTempDir("threenative-local-runtime-");
    try {
      const result = await createProject(
        {
          install: false,
          packageSources: { "@threenative/runtime-native": "/tmp/runtime.tgz" },
          target: "my-game",
        },
        root,
      );
      const manifest = JSON.parse(await readFile(path.join(result.target, "package.json"), "utf8"));
      expect(manifest.optionalDependencies["@threenative/runtime-native"]).toBe(
        "file:/tmp/runtime.tgz",
      );
      expect(manifest.dependencies["@threenative/runtime-native"]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
