# Blender for ThreeNative level authoring: verdict

**Status: deferred future plan (2026-09-08).** No implementation or benchmark is scheduled. The user's impression is that the output is decent and, most importantly, easily editable. A future experiment should pair Blender with the assets MCP for terrain/scene generation and test whether regeneration preserves manual edits. This is a workflow hypothesis, not a measured result. The experiment below remains a proposal to revisit when this work is prioritized.

**Recommendation: use Blender selectively for environment authoring; keep gameplay in ThreeNative; do not fork Blender MCP now.** Test the workflow through ThreeNative's existing Blender bridge first. The valuable addition is a reliable path from an authored environment to a playable level, not another way to execute Python in Blender.

Research date: 2026-09-07. Repository inspected at `e8ee4770faa27bfc3cd065a0e90b65463ddac73a`. This is a source and documentation investigation, not a measured authoring benchmark. No Blender scene, engine implementation, or external repository was changed for this report.

## 1. What we already have

ThreeNative already has considerably more Blender support than the question assumes:

| Existing mechanism | Evidence | Implication |
| --- | --- | --- |
| An owned headless Blender MCP with status, inspection, conversion, recipes and arbitrary Python execution | the server's tool definitions (since removed with the MCP server) | Agents can already author through `bpy`; a new MCP transport is unnecessary for a first experiment. |
| Conversion of `.blend`, `.fbx`, `.obj` and `.dae` into GLB during asset compilation | [Import pass](../../packages/assets/src/passes/blender-import.ts) | Blender-authored environments can enter the existing build pipeline. Conversion requires an installed Blender. |
| Blender scripts for decimation, UV unwrapping, AO baking and animation retargeting | the recipe files that now live in `packages/blender-bridge/gpl/recipes/` | Reuse the bridge and its failure reporting before adding infrastructure. |
| Standard Three.js model loading plus compiled-model optimization | [Runtime loader](../../packages/core/src/assets.ts), [model pass](../../packages/assets/src/passes/model.ts) | A GLB can be a hierarchy of environment objects, not just an individual prop. Loading it does not automatically define gameplay. |
| Static collision generation and navigation baking from Three.js geometry | [Static colliders](../../packages/physics/src/static-colliders.ts), [navigation regions](../../packages/physics/src/navigation/NavigationRegion3D.ts) | Imported environments can use existing mechanisms rather than introduce a separate physics or navigation implementation. |

The server is bundled into core through the `threenative-blender` core shim (since removed). Its README currently lists only the status tool; the executable defines five tools. That documentation undersells what already exists.

The current starter also authors its world directly in [ordinary Three.js source](../../packages/create-threenative/templates/starter/src/render/arena.ts). We are comparing two authoring inputs to the same runtime, not replacing ThreeNative with Blender.

## 2. Where Blender is the better tool

For a deliberately composed interior, village, cave or landmark, I expect Blender to improve spatial composition and geometry quality: meshes, pivots, UVs, repeated architectural pieces and relative placement can be inspected together. It is particularly attractive when the alternative is hundreds of unrelated coordinates and primitive meshes in TypeScript.

That is a hypothesis about this project's agent workflow. A mature human modelling interface does not automatically make an agent faster. The agent will still write code, often Python instead of TypeScript, and must manage scene state, export settings and a second feedback loop.

| Task | Preferred authoring route | Why |
| --- | --- | --- |
| Composed buildings, terrain features and environmental detail | Blender, exported as assets | Geometry editing and spatial inspection are central to the task. |
| Modular props and repeated scenery | Blender for the kit; game code or Blender for placement, benchmarked | Reusable art and procedural placement are separate decisions. |
| Random maps, generated arenas and layouts driven by rules | TypeScript | Seeds, constraints and regeneration already belong to executable game logic. |
| Doors, enemies, triggers, quests and movement rules | TypeScript, optionally using authored anchors | A transform says where a door is; code says how it opens and what it blocks. |
| Camera feel, lighting, shaders and final visual judgement | Game-owned render source and actual runtime captures | Blender's preview cannot prove the shipped game's appearance or performance. |

Do not move a simple blockout into Blender merely to recreate the same boxes through `bpy`. The extra step needs to buy better composition, faster revision or less authoring friction.

## 3. The export boundary is the actual work

**Metadata is not enabled in the converter.** Its GLB export sets modifiers, animation, skinning and Y-up options, but does not set `export_extras=True`. The upstream exporter defines custom-property export as disabled by default. Therefore an approach that labels objects with gameplay properties cannot assume those labels reach the game. This is a source-level finding; no round-trip test was run. See [our converter](../../packages/blender-bridge/gpl/convert.py) and [the exporter definition](https://raw.githubusercontent.com/KhronosGroup/glTF-Blender-IO/main/addons/io_scene_gltf2/__init__.py).

**An empty marker is not ordinary disposable geometry.** The model pass calls `prune` without specifying marker preservation. glTF Transform explicitly supports removing empty nodes. Spawn points and attachment anchors must be checked after the compiled GLB is loaded, not merely after export. Enabling custom properties alone would not prove preservation. See [the model pass](../../packages/assets/src/passes/model.ts) and [prune documentation](https://gltf-transform.dev/modules/functions/functions/prune).

**Physical meaning needs a deliberate mapping.** `buildStaticColliders` already creates fixed triangle-mesh bodies, including instance transforms, with a game-owned filter. It also defaults to excluding meshes whose minimum height is at least 4.5 metres. An upper storey needs that reachability policy examined. A moving door needs a separate body and lifecycle; a decorative leaf should not become a collider simply because it is a mesh. The inspected navigation collector also does not visibly expand per-instance transforms, so an instanced scene needs a navigation-specific test. These are integration constraints, not reasons to rewrite those systems. See [collision generation](../../packages/physics/src/static-colliders.ts) and [navigation geometry collection](../../packages/physics/src/navigation/NavigationRegion3D.ts).

**A shared mesh is not proof of cheap rendering.** The converter does not request GPU instancing. Blender's exporter exposes it as a separate, disabled-by-default option with restrictions. ThreeNative has `ClusteredBatch` in [its capability manifest](../../packages/core/capabilities.json), but a Blender export is not evidence that this mechanism was used. Measure draw calls, memory, load time and frame time in the compiled game before choosing an instancing strategy. See [export options](https://raw.githubusercontent.com/KhronosGroup/glTF-Blender-IO/main/addons/io_scene_gltf2/__init__.py).

**Revisions need one owner.** Treat the `.blend` file as the editable source for an authored environment and the GLB as derived output. Keep the generation script and seed when an agent creates the scene procedurally, but designate whether subsequent edits happen in the script or the `.blend`. Do not independently edit the same placements in both Blender and TypeScript. Prefer environment chunks with stable anchors over one enormous level file. Pack or explicitly track texture and linked-library dependencies: the current import pass stages the source file in a temporary directory, so relative dependencies need a real build test.

## 4. Should we fork Blender MCP?

I interpreted “the Blender MCP” as [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp), the public project corresponding to the Blender-style tools exposed in this session. This is distinct from ThreeNative's headless server.

Upstream already provides scene inspection, viewport screenshots and Python execution through an addon connection. Those capabilities can support interactive authoring without a ThreeNative fork. The missing integration concerns export and runtime interpretation, which remain missing whichever server executes the Python. See [upstream documentation](https://github.com/ahujasid/blender-mcp) and [server implementation](https://raw.githubusercontent.com/ahujasid/blender-mcp/main/src/blender_mcp/server.py).

| Option | Verdict | Reason |
| --- | --- | --- |
| Existing headless ThreeNative bridge plus a game-owned authoring script | **First choice** | Already packaged; suitable for reproducible batches and clean build environments. |
| Unmodified upstream Blender MCP for live inspection and edits | Optional experiment | Adds persistent viewport feedback; requires managing a live Blender/addon session. |
| Small upstream contribution or separate export addon | Consider after the experiment | Appropriate if a specific shared gap appears. |
| Maintain a fork of the upstream MCP | **No, today** | Adds transport, addon compatibility and release maintenance without resolving the key export questions. |

The inspected upstream server also contains prompt, code and screenshot telemetry paths governed by consent checks. Evaluate the pinned version's settings before using private game assets. That is a concrete integration difference from the owned headless bridge, not a reason by itself to fork. The repository carries an MIT license; reuse should still preserve notices and the project's existing separation for Blender-side Python. See [server code](https://raw.githubusercontent.com/ahujasid/blender-mcp/main/src/blender_mcp/server.py), [upstream license](https://raw.githubusercontent.com/ahujasid/blender-mcp/main/LICENSE) and [our package boundary](../../packages/blender-bridge/README.md).

A fork becomes defensible only after a measured workflow win and a necessary transport/addon change that cannot be delivered through the existing Python tool, a small addon or an upstream contribution. No such requirement emerged from this investigation.

## 5. Recommended integration boundary

The binding rule is simple: **the game remains TypeScript; the framework does not acquire an editor or a serialized gameplay format.** Blender is an external asset-authoring tool. GLB is the existing interchange format. See [the charter](../architecture/CHARTER.md).

Start with one environment GLB and ordinary game code binding a few required anchors. Names can be sufficient for a tiny pilot if uniqueness and presence are asserted; durable identifiers in standard glTF extras are a later option once preservation is proved. Metadata may locate an object; keep executable behaviour and gameplay relationships in TypeScript. Avoid turning extras into a hidden scene language interpreted by a generic factory registry.

Reusable export and validation mechanics belong with the existing Blender/assets bridge. Physics mechanisms belong in physics. Visual choices belong in generated game render source and authored assets. Document any promoted convention in template instructions. This preserves the charter without inventing a new authoring product inside this repository.

## 6. Experiment that can change the verdict

Estimated effort: **2–4 engineering days**, assuming Blender and the existing runtime test lanes are usable. This is a planning estimate, not a measured duration. The experiment is proposed, not implemented by this report.

1. **Use one fixed brief and asset kit.** Build a small two-storey courtyard with stairs, repeated props, a spawn anchor and an opening door. Compare direct TypeScript assembly with Blender assembly through the existing bridge. Give both arms the same agent/model budget and gameplay requirements.
2. **Exercise the full compiled pipeline.** Check a one-metre reference, world transforms, required anchors, material appearance, upstairs collision and door behaviour after loading. Test missing or duplicate anchors as failures. Rebuild from a clean checkout with no open Blender session.
3. **Measure revisions as well as initial creation.** Move the entrance, widen the stairs and change the upper floor's height. Record agent tokens, elapsed minutes, interventions, export/build time and failures. Repeat with fresh agents if the first comparison favours Blender; one attractive result is insufficient evidence for a default.
4. **Judge the shipped game.** Use the same runtime cameras and blind human grading for composition and playability. Run behaviour scenarios on web and native desktop; measure frame time, draw calls and memory on the same hardware. Add an emulator lane before claiming mobile support. Existing GLTF conformance fixtures are a starting point, not proof for this new level.
5. **Apply a predeclared adoption rule.** Proposed bar: at least 25% less median agent time or token cost with equal quality, or a clear blind visual win at comparable cost; zero lost required anchors; passing gameplay scenarios; and no more than 5% frame-time regression above measurement noise. These are experiment thresholds, not existing engine budgets. If Blender loses, keep it for individual assets. If it wins, promote the smallest proven workflow and reassess whether any MCP change is still necessary.

No authoring-speed, visual-quality or platform-parity result is claimed here. The recommendation is confident about reusing the existing bridge and avoiding a premature fork; choosing Blender as the default level authoring route remains conditional on the experiment.

When this work is resumed: choose one existing small level as the comparison brief; that decision should take under two minutes.
