# Finding assets — the full MCP tool loop

Companion to the short `Finding assets` section in this project's `AGENTS.md`. Reach for the
asset tools when the asset is conventional; build anything specific to this game yourself in
`src/render/`. A fetched asset has to match what the game needs, not merely exist.

Installing `@threenative/core` writes the `.mcp.json` that launches `threenative-asset-mcp`, so
your host lists its tools alongside your own. Your host reads that file from the directory it was
launched in: start the session in this project, not in a parent of it. It advertises 44; these 8
are the loop you will use for nearly everything:

For a humanoid that needs a skeleton or more motion, use the complete
[`rigging-characters.md`](rigging-characters.md) recipe. Inspect with `asset_inspect_rig`,
preserve or fit a rig with `asset_auto_rig`, select and bake donor clips with
`asset_retarget_animations`, and confirm the result with `asset_preview_animation` on a nonblank
contact sheet. AETHER / 02 is the pinned sample; its 18-bone rig has no fingers or toes, and the
tools report those absent roles instead of inventing them.

For a bespoke animated creature, use the complete [`creating-creatures.md`](creating-creatures.md)
recipe. It keeps the editable spec and claims under `.threenative/creatures/`, compiles the GLB
into the configured `assets/` source, and requires independent preview review before game
delivery. The five creature tools are `creature_status`, `creature_guide`, `creature_compile`,
`creature_preview` and `creature_check`; call `creature_status` first because compile can work
without optional preview dependencies while a complete preview/check loop may not.

1. `asset_search_sources` — start here, never at a provider. It returns every catalogued
   source with its license summary, attribution requirement, browse URL, and whether an agent
   can complete a download from it. **That output is the authority on what is reachable** —
   not your memory of some other project.
2. `polyhaven_search_assets` (CC0 models, textures, HDRIs), `ambientcg_search_assets` (CC0
   materials and textures), or `audio_search_assets` (Kenney, Sonniss).
3. `polyhaven_list_files` / `ambientcg_list_files` — the license, official URL, byte size and
   md5 of every resolution and format. **Read this before downloading, not after**, and pick a
   sane one: Poly Haven lists 16k PNGs over 1 GB beside 8k JPEGs at 28 MB. A game does not
   need the 16k.
4. `asset_download_file` for textures and models, `audio_download_asset` for audio. Both take
   `acceptLicense: true` — you are asserting you read step 3. **They ignore any path you pass
   and write to the directories `.mcp.json` sets** (`public/assets/<provider>/<sha>/` and
   `public/audio/<source>/<pack>/`); without that config they would write to `~/Downloads` and
   never reach the game.
5. Append the file, its source, its license and its URL to `CREDITS.md` **before the turn
   ends**. Poly Haven requires a visible Poly Haven credit when its API is used, ambientCG is
   CC0 per asset page, and audio and bundle licenses are per pack.

**A Poly Haven *model* takes one extra step, and no tool does it for you.** Poly Haven publishes
models as a `.gltf` beside a `.bin` and loose texture files and **never as a `.glb`**, so the file
list is the whole model: call `polyhaven_list_files` with the `assetId`, a `resolution` such as
`1k`, and `includeDependencies: true`, then `asset_download_file` once per entry — the `.gltf` and
every URL the tool reported as a dependency — with `provider: "polyhaven"`, the `url` and `fileName`
the listing gave, and `acceptLicense: true`. Keep the downloaded names exactly as the listing
spelled them: the glTF's relative URIs resolve against them, so a renamed texture loads as a
missing file rather than as an error. Serve that directory from `public/` and load it with
`ctx.assets.model()`.

No tool packs those files into one self-contained GLB. If you want one, convert the downloaded
`.gltf` in Blender or with `gltf-transform` in a build step, and report the triangle count and
per-texture dimensions yourself — `create-threenative inspect` does not read a Poly Haven listing,
so those two numbers come from the conversion. Textures and HDRIs stay on `asset_download_file`.

**Never state a license you did not read off a tool result.** If `polyhaven_list_files` or
`ambientcg_search_assets` did not tell you, you do not know it.

## What arrives is usually a ZIP, not a texture

ambientCG and Kenney ship archives: unpack one, keep only the maps you actually use (`_Color`,
`_NormalGL`, `_Roughness` — not the `.blend`, `.usdc` or displacement), and put those beside
your code under `public/`. A 1K JPEG set is right for a game; the 8K set of the same material
is 200 MB.

## Two argument shapes that bite

Both learned the hard way: `ambientcg_search_assets` takes lowercase `type` values (`material`,
`hdri`, `3d-model`), and the audio catalog is **pack-level** — `audio_search_assets` matches
pack names, so `query: "pickup coin"` returns nothing while `kind: "sfx"` returns the packs
that exist. Pick a pack, download it, unzip it, and choose a file yourself.

## Fab: searching, and importing an Unreal asset you own

Most Fab listings ship Unreal-only — 272 `.uasset` files and no `.glb` anywhere — so Fab is two
steps, not one: find the listing, then convert it.

**1. Search free first.** `fab_search_assets` talks to Fab's public API anonymously; no account is
involved. Its default `priceMode: "free"` is the right default and should stay your first query —
a free asset is one anybody who clones this project can fetch too.

```jsonc
// fab_search_assets
{
  "query": "cave rocks",
  "formats": ["unreal-engine"],  // "gltf", "fbx", "obj", "unity" ... omit for every format
  "priceMode": "any",            // SEE BELOW — the default is "free"
  "sort": "relevance",           // or rating, newest, price_asc, recently_updated
  "limit": 24
}
```

**Then look at what the account already owns.** A paid listing sitting in the library costs
nothing further to use, and it will never appear in a free search — `priceMode: "free"` returns a
different result set than `"any"` does. `fab_list_owned` answers that directly, without guessing
at search terms:

```jsonc
// fab_list_owned
{ "unrealOnly": true, "query": "vegetation" }   // both optional; unrealOnly drops engine installs
                                                // and plugins the importer cannot take
// -> [{ listingId, title, url, categories, engineVersions, hasUnrealArtifact }]
```

Reach for `priceMode: "any"` in `fab_search_assets` only when you mean to look at paid listings
the account does *not* own yet — buying is not something these tools can do for you.

Each item carries a `title` and an `id` — that `id` is the listing UID the next two tools take.
`fab_list_filters` returns the usable `formats`, `categories` and `tags` slugs; guessing them
silently narrows the search instead of erroring.

**2. Check the licence.** Search results carry **no licence** — Fab's search endpoint omits it, so
every item comes back with an empty `licenses` array. `fab_get_asset` is where the slugs live:

```jsonc
{ "listingIdOrUrl": "75f42402-40bb-4a1b-b557-18e2c9604273" }
// -> licenses: [{ slug: "personal" }, { slug: "professional" }], freeLicenseSlugs: [...]
```

**3. Import.** `fab_import_asset` verifies the entitlement itself, downloads through the FabCLI
session, converts every static mesh, and writes source GLBs into your `assets/`:

```jsonc
// fab_import_asset
{
  "listingIdOrUrl": "https://www.fab.com/listings/<uid>",
  "outputDir": "assets/fab/soul-cave",
  "packages": ["SM_S_Soul_Statue"],   // omit to convert every static mesh — packs run to gigabytes
  "maxTextureSize": 2048,             // omit to keep Unreal's own resolution
  "acceptFabEula": true
}
```

Then load the returned path the ordinary way:
`ctx.assets.model("fab/soul-cave/.../SM_S_Soul_Statue.glb")`. The normal asset compiler picks the
GLBs up from `assets/` with no extra configuration.

**Cook the pack with the default settings. `models: "none"` and `textures: "none"` in
`threenative.config.ts` are not a fix, and a reason to reach for them is a bug report, not a
workaround.** A converted Fab pack is ordinary input to that cook, and the cook is where an
expensive import stops being expensive: embedded PNG and WebP maps are transcoded to KTX2 and
capped, mesh attributes are quantized and Meshopt-compressed, and a `MASK` (alpha-cutout)
primitive is handed a discrete LOD chain, so the LOD0 triangle count in the GLB is not the
triangle count the scene pays for. One measured tree: `SM_EuropeanHornbeam_Forest_01.glb` cooks
126,934,280 → 26,428,684 B, its six embedded PNGs → KTX2 (45.4 MB → 16.4 MB), and its
755,677-triangle foliage primitive down to a 5.1% far rung. Turning a pass off ships every source
byte verbatim instead, counts all of them against `assets.budget.uncooked`, and is precisely what
makes `threenative build` fail with `TN_ASSETS_BUDGET_EXCEEDED` — read `dist.build-report.json`
before you conclude a pack is too big. An extension the cook owns no pass for (`.dna`,
`.strands.bin`, a vendor data file) is copied through and still resolves through the same manifest
entry, so nothing needs `public/` to serve it. Ignore what the cook writes beside the manifest —
`public/basis/`, `public/shared/` and `public/bake.receipt.json` are outputs too, and a
content-addressed name is not the only output name.

What the import will and will not do:

- **A pack of uncooked editor assets cannot be converted at all**, and this is the common case for
  marketplace packs, which ship as Unreal *source* projects. Cooking is what writes the renderable
  vertex and index buffers into the file; an uncooked package keeps only the editable source mesh
  and lets the editor derive the rest, so there is no geometry for UE Viewer to read. The import
  detects this and fails `UNREAL_SOURCE_UNCOOKED` naming the evidence it found —
  `/Script/UnrealEd`, `AssetImportData`, `SourceModels`. **Believe it and stop.** No engine
  version, `packages` filter or flag changes the answer, and the download is gigabytes each time
  you try. The only route to those meshes is opening the pack in Unreal Editor and exporting FBX
  or glTF yourself. Prefer a listing that ships a non-Unreal format, and treat one that does not as
  a likely dead end before you spend the bandwidth.
- **A free listing still has to be in the library first.** `fab_import_asset` refuses with
  `FABCLI_NOT_OWNED` until the listing is claimed, and it never claims — by design. Run
  `fabcli claim <uid>`, which needs the interactive `fabcli auth login` session rather
  than the API token `fabcli auth status` reports as authenticated. Note also that `fab_get_asset`
  reports a free CC-BY offer as `isFree: false` with an empty `freeLicenseSlugs`; the listing
  appearing in `fab_search_assets` with `priceMode: "free"` at `startingPrice.amount: 0` is the
  reliable signal, so check the search before concluding a listing costs money.
- **Only assets you already own**, and only under **Fab Standard (Personal or Professional) or
  CC-BY**. Unreal-Engine-only and legacy entitlements are refused, and a licence it cannot read is
  refused too. The MCP never logs in, claims, or purchases. If FabCLI needs a session, the agent
  must proactively run `fabcli auth login` and complete it through Claude browser or Codex's
  `chrome:control-chrome`, reusing the user's active signed-in browser session. Never inspect,
  copy, print, or persist cookies or tokens; interact with the login page instead.
  Searching and `fab_get_asset` stay anonymous, so the licence check never depends on the
  authenticated path it is guarding.
- **If the WebView login fails, use the manual paste flow.** On Wayland the WebView dies with Gdk
  "Error 71 (Protocol error)", and `GDK_BACKEND=x11` still may not let the user sign in.
  `fabcli auth login --manual` refuses a non-TTY stdin, so run it under a pty fed by a FIFO:
  `mkfifo f; (sleep 1200 > f &); (script -qfec "fabcli auth login --manual" /dev/null < f > log &)`.
  The user opens Epic's redirect endpoint
  (`https://www.epicgames.com/id/api/redirect?clientId=<fabcli's client id>&responseType=code`;
  `strings "$(command -v fabcli)" | grep epicgames.com/id/login` prints the full login URL) in
  their own signed-in browser. It returns JSON with an `authorizationCode`; the user pastes that
  value to the agent (or, when asked, the agent reads it from the page through browser control),
  and the agent writes it with `printf '%s\n' "$CODE" > f` without echoing it. The pty echoes the
  code into `log`, so keep that file private and delete it once `fabcli auth status` reports
  `authenticated: true`. The separate Fab web session can still read `session_present: false`;
  `fab_import_asset` resolves ownership through the library and works regardless. Never run
  `pkill -f <pattern>` in the same shell command that names the pattern: it matches its own
  command line and kills the shell.
- **Two external tools install themselves on first use** (FabCLI and UE Viewer). Set
  `THREENATIVE_TOOLCHAIN_AUTOINSTALL=0` to require you install them instead. Linux and Windows only.
- **`packages` is not optional in practice.** A marketplace pack converts to many gigabytes of
  GLBs; name the handful of meshes your scene uses. Run it once without `packages` against a
  scratch directory if you need to see what a pack contains, then re-run with the names.
- **Read `import-report.json` before trusting the result.** It reports `materials: "complete"` or
  `"degraded"`, counts textured against total sections, and names every mesh it skipped and every
  texture it could not map. Unreal shader graphs have no glTF equivalent, so some sections arrive
  with a neutral grey and say so. `.umap` levels, Blueprints, Niagara and foliage placement are
  reported as unsupported, never silently dropped.
- `asset_import_unreal` takes a local `sourceDir` instead of a listing, for a pack you already
  downloaded by any means.

`fab_download_free_asset` is the unrelated older path: it downloads a directly-available free
`glb`/`fbx`/`obj`/`unity` file with no account at all. Use it when the listing already ships a
format you can load, and the importer only when it does not.

## From a downloaded `.fbx` to a running character

An `.fbx`, `.blend`, `.obj` or `.dae` is not a file the runtime can load. Put it in your assets
directory anyway and the build converts it:

1. Download it — `fab_download_free_asset`, `asset_import_unreal`, `asset_download_bundle_entry`,
   or by hand.
2. Write it into `assets/`, beside your `.glb` files. Nothing else to configure.
3. Build. `compileAssets` classifies it as a model, converts it to GLB through Blender, then
   optimizes it exactly like an authored GLB — skeleton, animation clips, materials and embedded
   textures survive.
4. Load it the ordinary way: `ctx.assets.model("hero")`.

**Blender must be installed**, and the framework never installs it for you. With no Blender the
build fails and names the install command for your platform — it does not copy the unusable file
through and report success. Ask the user before installing anything; it is roughly 350 MB.

The `threenative-blender` MCP server answers the rest:

- `blender_status` — can this machine convert at all? Never fails; with no Blender it returns
  `available: false` and the install command. Call it first.
- `blender_inspect` — what is in this file? Mesh, triangle, vertex and bone counts, material
  names, clip names, image names. Use it before committing a download.
- `blender_convert` — write a GLB somewhere other than the build's output. Zero meshes out is a
  failure, never an empty GLB.
- `blender_recipes` — the shipped bpy recipes (`decimate`, `unwrap`, `bake_ao`, `retarget`) and
  their **full source text**. Read one and adapt it; do not write bpy cold.
- `blender_run_python` — run a bpy script of your own. It is not a sandbox and does not claim to
  be; it gives you a resolved Blender and the same fail-closed handling, not extra privilege.

## The narrower tools

The directory spells out the conditions on each. The Fab tools are covered above; the server
never purchases anything on any path. `smithsonian_search_assets` returns museum scans at scan resolution, which this project has no
pipeline to decimate — that geometry is the wrong shape for a game. When in doubt check
`asset_search_sources` first; its `caution` and license fields are the current truth for the
pinned version, and they change between versions.

Load what you downloaded the ordinary way — `ctx.assets.model("crate.glb")`,
`ctx.assets.texture(...)`, `ctx.assets.audio(...)` — and write your own material and lighting
around it in `src/render/`. The framework ships no asset and picks none for you.
