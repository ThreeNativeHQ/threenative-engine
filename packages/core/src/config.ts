export type ThreeNativeOrientation = "landscape" | "portrait" | "sensor";

/** Which renderer draws a game's `src/ui/`. @see IThreeNativeConfig.ui */
export type ThreeNativeUiRenderer = "native" | "native-css" | "web";

/** What the native host does with the render loop while the app is off-screen. */
export type ThreeNativeBackgroundMode = "continue" | "pause";

export interface IThreeNativeIconVariants {
  readonly android?: {
    readonly foreground?: string;
    readonly background?: string;
    readonly monochrome?: string;
  };
  readonly ios?: {
    readonly dark?: string;
    readonly tinted?: string;
  };
  readonly web?: {
    readonly favicon?: string;
    readonly maskable?: string;
    readonly monochrome?: string;
    readonly appleTouch?: string;
  };
}

export interface IThreeNativeBootSplash {
  readonly backgroundColor?: string;
  readonly image?: string;
}

/** What a clip is for, stated as a bound on where its energy sits, in the inspector's bands. */
export interface IThreeNativeAudioSpectrum {
  readonly band: "air" | "high" | "low" | "mid" | "sub";
  /** Most of the clip's energy that may sit in the band. */
  readonly maxPercent?: number;
  /** Least of the clip's energy that must sit in the band. */
  readonly minPercent?: number;
}

/** Loop conditioning for a clip that repeats forever; its seam is cross-faded, then asserted. */
export interface IThreeNativeAudioLoop {
  /** Equal-power cross-fade in milliseconds. `0` keeps the clip's own length and still asserts. */
  readonly crossFadeMs?: number;
  /** How far the splice may move to find a quiet seam, in milliseconds. */
  readonly spliceToleranceMs?: number;
}

/**
 * Per-glob audio declarations. Which clips loop, which are positional, and what a clip is for are
 * facts only the game knows, so they are declared and never inferred from a filename.
 */
export interface IThreeNativeAudioOverride {
  /** `"none"` ships these bytes as committed; measurement and a declared loop's assertion run. */
  readonly conditioning?: "none";
  /** First matching override wins; matched against the logical path, e.g. `"audio/bed.ogg"`. */
  readonly glob: string;
  readonly loop?: boolean | IThreeNativeAudioLoop;
  readonly normalise?: "ceiling" | "peak";
  /** Peak ceiling in dBFS, between -60 and 0. */
  readonly peakDb?: number;
  /** The clip plays from a place in the world, so it is downmixed to mono. */
  readonly positional?: boolean;
  /** Vorbis VBR quality, -1 to 10. */
  readonly quality?: number;
  /** The largest wrap-to-neighbourhood step ratio a declared loop may ship with, 1 to 5. */
  readonly seamMaxRatio?: number;
  readonly spectrum?: IThreeNativeAudioSpectrum;
}

/**
 * Audio conditioning options for the asset compile step; `"none"` ships clips verbatim.
 *
 * `"ceiling"` normalisation only ever attenuates, keeping the game's relative mix; `"peak"` also
 * lifts a quiet clip to the ceiling.
 */
export interface IThreeNativeAudioConfig {
  readonly normalise?: "ceiling" | "peak";
  readonly overrides?: readonly IThreeNativeAudioOverride[];
  readonly peakDb?: number;
  readonly quality?: number;
  readonly seamMaxRatio?: number;
}

/** Texture compression options for the asset compile step; `"none"` ships sources verbatim. */
export interface IThreeNativeTexturesConfig {
  /** Automatic compression floor; omitted fields default to SSIM 0.95 and mean ΔE00 3. */
  readonly floor?: { readonly ssim?: number; readonly meanDeltaE00?: number };
  /** Scalar or glTF slot map (e.g. baseColorTexture/normalTexture). Integer at least 4; caps the longest edge, preserving aspect and 4x4 alignment; never upscales. */
  readonly maxSize?: number | Readonly<Record<string, number>>;
  readonly overrides?: readonly {
    readonly codec: "etc1s" | "none" | "uastc";
    readonly glob: string;
    readonly quality?: number;
  }[];
  /** ETC1S encoder quality 1–255. Ignored for UASTC. */
  readonly quality?: number;
}

/** Model optimization sub-pass switches; absent means every pass runs. */
export interface IThreeNativeModelPassesConfig {
  readonly dedup?: boolean;
  readonly meshopt?: boolean;
  readonly prune?: boolean;
  readonly quantize?: boolean;
  readonly reorder?: boolean;
}

/** Model optimization options for the asset compile step; `"none"` ships sources verbatim. */
export interface IThreeNativeModelsConfig {
  /**
   * Lossless scene-graph compaction: flatten empty transform chains, join sibling primitives
   * that share a material, and batch a mesh several nodes reuse as `EXT_mesh_gpu_instancing`.
   *
   * On by default; `false` ships the scene graph as authored. A node matching `protectedPattern`,
   * named in `protectedNames`, targeted by an animation or a skin joint is never merged or
   * instanced, so an exact-name lookup or a bone-driven node survives.
   */
  readonly compact?:
    | boolean
    | {
        readonly flatten?: boolean;
        readonly instance?: boolean | { readonly min?: number };
        readonly join?: boolean;
        readonly protectedNames?: readonly string[];
        readonly protectedPattern?: string;
      };
  /** Standard glTF TEXCOORD_1 atlas generation for offline static-light assets. */
  readonly lightmap?: {
    readonly atlasSize: number;
    readonly padding: number;
  };
  readonly passes?: IThreeNativeModelPassesConfig;
  readonly quantize?: {
    readonly normalBits?: number;
    readonly positionBits?: number;
    readonly uvBits?: number;
  };
  /**
   * Write each distinct embedded image once under `shared/images/` and reference it from every
   * model that carries it. A marketplace pack whose eight pines all embed the same bark map then
   * ships and encodes it once. Default true; false embeds and re-encodes duplicate images in
   * each model. The served GLB references files beside it.
   */
  readonly sharedImages?: boolean;
  /**
   * Embedded-texture compression for images carried inside a `.glb`.
   *
   * On by default in the compile step; `"none"` ships every embedded image exactly as
   * authored. `maxSize` caps the longest edge, preserving aspect and snapping to whole 4x4
   * blocks, and never upscales.
   */
  readonly textures?:
    | "none"
    | {
        readonly floor?: { readonly ssim?: number; readonly meanDeltaE00?: number };
        /** Scalar or glTF slot map; unlisted slots retain the 2048 default. Shared images use the largest cap. */
        readonly maxSize?: number | Readonly<Record<string, number>>;
        readonly quality?: number;
        readonly overrides?: readonly {
          readonly slot: string;
          readonly codec: "etc1s" | "none" | "uastc";
        }[];
      };
  /**
   * Mesh simplification. Absent means none at all, which is the default.
   *
   * `ratio` is the fraction of triangles to keep. `error` is a quality guard rather than a
   * target — the largest a vertex may move as a fraction of the mesh's extent — so a loose
   * ratio with a tight error stops short, and the compile step reports the ratio it actually
   * achieved next to the one that was asked for.
   */
  readonly simplify?: {
    readonly ratio: number;
    readonly error?: number;
  };
  /**
   * Cluster-DAG bake for virtual geometry, or `"none"` to ship every primitive as authored.
   *
   * Absent means on with defaults: any primitive of 65,536 triangles or more bakes to a cluster
   * DAG the loader turns into a `ClusteredMesh`, and everything below that line compiles
   * byte-identically. The payload costs roughly 3-4x the primitive's compiled bytes, which is
   * what `"none"` and `minSourceTriangles` are for.
   */
  readonly virtual?:
    | "none"
    | {
        /** Clusters folded together per group, default 4. */
        readonly groupSize?: number;
        /** Upper bound on a cluster's triangles, default 128. */
        readonly maxTriangles?: number;
        /** Lower bound on a cluster's triangles, default 96. */
        readonly minTriangles?: number;
        /** Primitives below this many triangles are left alone, default 65,536. */
        readonly minSourceTriangles?: number;
        /** Fraction of a group's triangles kept per level, default 0.5. */
        readonly simplifyRatio?: number;
      };
}

/** Quality policy for automatic discrete LOD; it picks the projected pixel-error budget. */
export type ThreeNativeLodPreset = "aggressive" | "balanced" | "quality";

/** What the `minTriangles` pre-filter is measured against. */
export type ThreeNativeLodMinTrianglesScope = "primitive" | "asset";

/** Generation knobs shared by every preset. All are ceilings or filters, not promises. */
export interface IThreeNativeLodGenerationConfig {
  /**
   * Increasing geometric-error targets in normalized mesh-extent units; 1–16 positive finite
   * numbers that strictly increase. Default `[0.002, 0.006, 0.02, 0.06]`. Each is simplified from
   * LOD0 independently and a target that cannot reduce is dropped.
   */
  readonly errorTargets?: readonly number[];
  /** Levels in the chain **including LOD0**; integer 1–8, default 4. `1` emits nothing derived. */
  readonly maxLevels?: number;
  /**
   * Fraction of its predecessor's triangles a derived level must save to be kept; finite in
   * `[0, 1)`, default `0.2`. This is the benefit gate — a mesh that cannot reach it is skipped
   * with `insufficient-reduction`, which is a normal outcome, not an error.
   */
  readonly minSaving?: number;
  /**
   * Cheap pre-filter floor in triangles; positive integer, default `128`. It only avoids
   * clearly-pointless work (the simplifier's fixed per-call cost); `minSaving` is the real gate.
   */
  readonly minTriangles?: number;
  /**
   * What `minTriangles` is measured against; `"primitive"` or `"asset"`, default `"asset"`. The
   * asset scope measures the whole model, so a model split into many small primitives is still
   * eligible on its total.
   */
  readonly minTrianglesScope?: ThreeNativeLodMinTrianglesScope;
  /**
   * Opt-in far rung that joins a mesh's same-material primitives into one draw per material group.
   * Default `false`: with no option the cook is byte-identical to today. A join never crosses a
   * material, never touches a skinned, morph-target or animated node, and never leaves the mesh's
   * own node, so authored LOD0, node identity, per-node visibility, picking and transforms are
   * untouched; the joined geometry is an additional far rung beside LOD0.
   */
  readonly join?: boolean;
}

/** Screen-space selection knobs. */
export interface IThreeNativeLodRuntimeConfig {
  /** Projected geometric-error budget in raster pixels; positive finite. Default by preset. */
  readonly maxPixelError?: number;
  /** Fraction in `[0, 0.5)`, default 0.15, that stabilizes coarsening at a boundary. */
  readonly hysteresis?: number;
}

/** A partial override for one asset; nested objects overlay, they never replace. */
export interface IThreeNativeLodOverride {
  readonly enabled?: boolean;
  readonly generation?: IThreeNativeLodGenerationConfig;
  readonly preset?: ThreeNativeLodPreset;
  readonly runtime?: IThreeNativeLodRuntimeConfig;
}

/**
 * Automatic discrete LOD policy. `{}` resolves to enabled/balanced and any explicit block turns
 * generation on; `false` and `{ enabled: false }` are equivalent absolute kill switches that no
 * per-asset override can re-enable. Overrides are keyed by canonical project-relative source asset
 * (`/` separators).
 *
 * Omission currently bakes nothing: the default-on front door opens only after the qualification
 * phase passes. Until then `assets.lod: {}` is the opt-in that resolves to enabled/balanced.
 */
export interface IThreeNativeLodConfig {
  readonly enabled?: boolean;
  readonly generation?: IThreeNativeLodGenerationConfig;
  readonly overrides?: Readonly<Record<string, boolean | IThreeNativeLodOverride>>;
  readonly preset?: ThreeNativeLodPreset;
  readonly runtime?: IThreeNativeLodRuntimeConfig;
}

/** One measured byte ceiling on a produced artifact, and what crossing it does. */
export interface IThreeNativeArtifactBudgetLimit {
  /** Bytes, exclusive: a build measuring exactly the limit is inside it. */
  readonly limit: number;
  /** `"error"` refuses the build and keeps the previous artifact; `"warn"` prints and publishes. */
  readonly severity: "error" | "warn";
}

/**
 * Runtime ceilings a profile wants every playtest of the artifact it builds to hold.
 *
 * The fields are the playtest harness's own `assert.performance` fields, one name for one meaning:
 * a budget declared here is merged into each scenario's performance assertion, so a budget and a
 * scenario bound the same number instead of two vocabularies for one measurement. Spelled out
 * rather than imported — the harness runs against plain Three.js with no dependency on this
 * package, and core must not invert that. A closed key list validated in both places is the price;
 * `create-threenative/__tests__/build-report.spec.ts` fails if the two lists drift.
 */
export interface IThreeNativePerformanceBudget {
  /** Per-pass draw-call ceilings, keyed by pass kind: main, shadow, reflection, nested. */
  readonly maxPassDrawCalls?: Readonly<Partial<Record<ThreeNativeRenderPassKind, number>>>;
  /** Per-pass triangle ceilings, keyed by pass kind: main, shadow, reflection, nested. */
  readonly maxPassTriangles?: Readonly<Partial<Record<ThreeNativeRenderPassKind, number>>>;
  /** Per-phase millisecond ceilings at nearest-rank p95: hostGap, update, render, overlay, residual. */
  readonly maxPhaseMsP95?: Readonly<Partial<Record<ThreeNativeFramePhase, number>>>;
  /** Maximum renderer draw-call count across every pass combined. */
  readonly maxDrawCalls?: number;
  /** Maximum nearest-rank 95th-percentile frame time in milliseconds. */
  readonly maxFrameMsP95?: number;
  /** Maximum renderer triangle count across every pass combined. */
  readonly maxTriangles?: number;
  /** Frame-budget floor: the median presented frame must sustain at least this many frames a second. */
  readonly minFps?: number;
}

/** The engine's frame-budget phases, as a budget spells them. */
export type ThreeNativeFramePhase = "hostGap" | "overlay" | "render" | "residual" | "update";

/** The render-pass kinds a per-pass budget bounds. */
export type ThreeNativeRenderPassKind = "main" | "shadow" | "reflection" | "nested";

export interface IThreeNativeConfig {
  /**
   * The engine that draws the game on web and desktop. Defaults to the owned C++ engine (`"native"`):
   * the Wasm engine on web, the V8 engine player on desktop. `"legacy"` is the named override: it keeps
   * upstream Three.js on web and the legacy host on desktop. Android and iOS still run the legacy host.
   */
  readonly engine?: "legacy" | "native";
  readonly app?: {
    readonly id?: string;
    readonly name?: string;
    readonly version?: string;
    readonly build?: number;
    readonly icon?: string;
    readonly icons?: IThreeNativeIconVariants;
  };
  readonly display?: {
    readonly orientation?: ThreeNativeOrientation;
    readonly fullscreen?: boolean;
    readonly keepScreenOn?: boolean;
    /**
     * Maximum native presentation rate in frames per second. Left out, it follows the display's own
     * refresh rate capped at 120 on desktop and web, and stays 60 on mobile where the ceiling is
     * power and heat; the resolved value and its source are reported on every `TN_FRAME_BUDGET`
     * line as `targetFps` and `targetSource`. A number set here wins outright, and `0` removes the
     * software ceiling. Android also submits this value as the surface's preferred frame rate,
     * which the display policy may decline because of hardware, power, or thermal state. Android
     * uses non-blocking presentation above 60 fps so a missed high-refresh interval does not fall
     * to an integer refresh-rate divisor.
     */
    readonly maxFps?: number;
    /**
     * What the native host does when the player leaves the app — presses the power button,
     * switches away, minimizes the window. `"pause"` (the default) stops running frames and
     * suspends audio until the app comes back; `"continue"` keeps rendering off-screen, which a
     * server-shaped or split-screen game may genuinely want. On Android the operating system
     * stops the app whatever this says, so `"continue"` takes effect on desktop only.
     *
     * Turning the pause off does not turn the reporting off: `TN_LIFECYCLE` markers are emitted
     * either way and name the mode that executed.
     */
    readonly backgroundMode?: ThreeNativeBackgroundMode;
  };
  readonly window?: {
    readonly title?: string;
    readonly width?: number;
    readonly height?: number;
    /** Start maximized on desktop when `display.fullscreen` is false. */
    readonly maximized?: boolean;
    readonly resizable?: boolean;
  };
  /**
   * Named cook profiles: one authored asset tree, one compiler, a different representation per
   * artifact. `--profile` on `threenative build` wins over `defaults[target]`; with neither, the
   * `assets` block is used exactly as declared. An overlay changes resource-processing options
   * only — the source root, the output root, worker concurrency and exclusions stay in `assets`.
   */
  readonly buildProfiles?: {
    readonly defaults?: {
      readonly android?: string;
      readonly desktop?: string;
      readonly ios?: string;
      readonly web?: string;
    };
    readonly profiles: Readonly<
      Record<
        string,
        {
          /**
           * Byte ceilings on what this profile actually produced, measured after packaging and
           * checked before the artifact is published. `artifactBytes` is the artifact itself (a
           * file, or the recursive sum of a directory, `.app` bundle or outDir);
           * `packagedAssetBytes` is the sum of the asset files that survived the packaging
           * selector. `"error"` refuses the build and leaves the previous artifact in place;
           * `"warn"` prints and publishes.
           */
          readonly artifactBudget?: {
            readonly artifactBytes?: IThreeNativeArtifactBudgetLimit;
            readonly packagedAssetBytes?: IThreeNativeArtifactBudgetLimit;
          };
          /**
           * Runtime ceilings this profile's artifact must hold, published into the
           * `<artifact>.build-report.json` a build writes beside it and merged by
           * `threenative-playtest --build-report` into every scenario's `assert.performance`. The
           * build measures none of it — it cannot; the numbers exist only once a runtime drew
           * frames — so a budget never refuses a build and never passes one either.
           */
          readonly performanceBudget?: IThreeNativePerformanceBudget;
          readonly assets?: Pick<
            NonNullable<IThreeNativeConfig["assets"]>,
            "audio" | "budget" | "lod" | "models" | "targets" | "textures"
          >;
        }
      >
    >;
  };
  readonly assets?: {
    /**
     * Audio conditioning options, or `"none"` to ship every clip exactly as committed. Absent
     * means conditioning runs with defaults. `"none"` still measures and still reports.
     */
    readonly audio?: "none" | IThreeNativeAudioConfig;
    /**
     * Byte ceilings: uncooked defaults to 64,000,000; total defaults to "none". Mobile
     * targets without decoders are exempt from uncooked. A number sets uncooked; "none"
     * disables both gates. Measurements still print when a gate is disabled.
     */
    readonly budget?:
      | number
      | "none"
      | {
          readonly uncooked?: number | "none";
          readonly total?: number | "none";
        };
    /** Source-relative globs omitted from builds; excluded bytes are still reported. */
    readonly exclude?: readonly string[];
    /**
     * How many cook workers a bake may run at once; absent means the driver's default,
     * min(4, cores - 1). Not part of any cache key, so changing it re-cooks nothing.
     */
    readonly concurrency?: number;
    /**
     * Automatic discrete LOD. `assets.lod: {}` opts in with the balanced default; `false` or
     * `{ enabled: false }` is the absolute kill switch, and per-asset overrides key off canonical
     * source asset paths. Omission currently bakes nothing — the default-on front door opens only
     * after the qualification phase passes. See {@link IThreeNativeLodConfig}.
     */
    readonly lod?: boolean | IThreeNativeLodConfig;
    readonly models?: "none" | IThreeNativeModelsConfig;
    /**
     * Also emit the native cooked package (`<output>/native/assets.tnpk`, TNPK v1) beside the
     * existing outputs, for a native-engine build that loads its assets without a JS `GLTFLoader`.
     * Absent or `false` leaves the output set unchanged.
     */
    readonly nativePackage?: boolean;
    readonly output?: string;
    readonly source?: string;
    readonly targets?: {
      readonly maxMaterials?: number;
      readonly maxTriangles?: number;
      readonly maxTextureDimension?: number;
    };
    /** Texture compression options, or `"none"` to ship every texture exactly as committed. */
    readonly textures?: "none" | IThreeNativeTexturesConfig;
  };
  readonly bootSplash?: IThreeNativeBootSplash;
  readonly nativeEntry?: string;
  readonly renderer?: {
    readonly preferWebGPU?: boolean;
    /**
     * Portable drawing-buffer scale. CSS and UI layout dimensions are unchanged.
     *
     * `"auto"` — the default a template ships — lets the engine hold the `display.maxFps` budget
     * without the game hand-authoring a resolution constant. A number in `(0, 1]` pins it and
     * turns the loop off. Either way the active scale is reported in every `TN_FRAME_BUDGET`
     * window: turning the convention off does not turn its measurement off.
     */
    readonly resolutionScale?: number | "auto";
    /** Portable multisampling. Sampling and resolution are one pixel budget, not two. */
    readonly antialias?: boolean;
    /**
     * Portable alpha antialiasing: resolve alpha-tested cutout silhouettes — foliage, fences,
     * hair — through the multisample coverage mask rather than a binary `discard`. On by default,
     * costing no target and no pass; it buys the cutouts the samples `antialias` already pays
     * for. Set false for a deliberately hard-edged look. It does nothing on a single-sampled
     * surface, and says so in `TN_ALPHA_ANTIALIASING` rather than reporting itself applied.
     */
    readonly alphaAntialiasing?: boolean;
    /**
     * Whether the engine may render an internal mirror of the scene to collapse repeated draws,
     * and how often that mirror proves a batched material still matches its group's shared draw.
     *
     * On by default, which is the shipping behaviour and is what an unset option means. The mirror
     * is opportunistic and correctness-preserving, but it pays a reconciliation cost per frame, so
     * a game that has measured it as a loss — a scene whose draw count falls without its frame time
     * following — can decline it with `false`. An opted-out game builds no mirror and runs no
     * eligibility scan, so the opt-out costs nothing rather than declining each frame; the authored
     * scene is what renders. The `TN_RENDER_PROJECTION` marker still reports it, with its own
     * reason code rather than one of the measured declines.
     *
     * An object instead of `false` names the material check:
     *
     * - `materialChecks: "spread"` — **the default.** A bounded slice of the batched materials is
     *   proved per frame instead of all of them, so a frame of 4,096 colour-only materials costs
     *   512 checks rather than 4,096. A material that gains a roughness, a map or a define still
     *   leaves its group and is drawn exactly; it is caught up to `materialCheckStaleFrames` frames
     *   later, and `TN_RENDER_PROJECTION` reports that bound. A base-colour edit never waits: the
     *   per-instance colour is O(1) per member and always exact.
     * - `materialChecks: "everyFrame"` — the named alternative, and the check exactly as it shipped
     *   before the sweep existed: every material proved every frame, at about 1.1 µs a material. Use
     *   it when a game would rather pay the per-frame cost than accept the bound.
     *
     * Any other value throws at startup rather than falling back to a default nobody asked for.
     *
     * `"js"` names the mirror on a host that would not build one. The native engine player batches
     * the authored scene in its own renderer and reports `hostProjected`, so core builds no mirror and
     * reads no object across the boundary. `"js"` forces the mirror there anyway (for a comparison, or
     * a game that depends on it), and the report states `path: "js"` and `pathOverridden: true`. On
     * three the mirror is the only path, so `"js"` changes nothing.
     */
    readonly projection?:
      | boolean
      | "js"
      | {
          readonly materialChecks?: "spread" | "everyFrame";
        };
    /**
     * Projected diameter, in raster pixels, below which the engine does not submit an object to
     * the render camera. On by default at a conservative **0.5 px**: an object under half a pixel
     * cannot light a whole pixel of the frame, so only unresolvable geometry is removed. Set a
     * larger number for a tuned cut — a shipped game's ladder chose 2 px — or `false` to leave
     * every object drawn. The measurement still runs with `false`; `TN_PROJECTION` reports how many
     * objects were considered and skipped. Exempt a single object with `alwaysRender` from
     * `@threenative/core`; the player's camera-attached objects and shadow casters are already kept.
     */
    readonly minimumProjectedPixels?: number | false;
    /**
     * How much of the scene graph the engine walks for world matrices each frame.
     *
     * `"visible"` — the default — does not recurse into a hidden subtree. three's own
     * `updateMatrixWorld` walks every child whatever its `visible` flag, multiplying a world matrix
     * for a full-detail body whose merged stand-in is showing, a hidden LOD level, a parked model —
     * none of which can draw. The engine composes every visible node exactly as three does, and
     * remembers a hidden node it skipped so the first frame that subtree shows again its whole
     * chain is refreshed before anything reads it. A game that reads a **hidden** object's
     * `matrixWorld` directly must not rely on the walk having reached it: use `getWorldPosition`
     * (which updates the chain) or call `updateWorldMatrix(true, false)` first.
     *
     * `"all"` visits every node, exactly as three's own walk does — for a game that reads hidden
     * world matrices without going through `getWorld*` and cannot say so per object. Both modes
     * report the number of nodes walked in the `TN_PROJECTION` window, so the cost of the walk the
     * default removed is measurable rather than asserted.
     */
    readonly matrixWorld?: "visible" | "all";
    /**
     * Android-only rendering overrides selected by the engine.
     *
     * `antialias` belongs here beside `resolutionScale` because they spend the same budget: a
     * tile-based mobile GPU resolves MSAA in tile memory and prices it quite differently from a
     * desktop one, so a platform that scales resolution down must be able to buy sampling back
     * on that same platform rather than accepting whatever the portable value happened to be.
     */
    readonly android?: {
      readonly resolutionScale?: number | "auto";
      readonly antialias?: boolean;
      /**
       * `alphaAntialiasing` belongs here for the reason `antialias` does, one step on: a phone
       * that bought sampling back must be able to spend it on cutouts, and one that gave sampling
       * up has nothing to spend.
       */
      readonly alphaAntialiasing?: boolean;
    };
  };
  readonly ui?: {
    /**
     * Which renderer draws `src/ui/`. Defaults to `"web"`.
     *
     * `"web"` runs the same React DOM, Tailwind, CSS, SVG and fonts on every target, through
     * that platform's own browser-class renderer composited over the game surface. What is
     * guaranteed is source parity — one `src/ui/` — not browser-binary parity, which no design
     * using the platforms' own engines can offer once iOS is in the set.
     *
     * `"native"` maps React to `CanvasLayer` quads with no web view, no CSS and no second
     * process. Choose it for a UI that is part of the rendered frame, or a target with no web
     * view, or zero extra processes — and own the appearance difference, which is the trade
     * being made rather than something to discover in a screenshot.
     *
     * `"native-css"` runs the same React tree in the game's own JS realm — no web view, no second
     * process — with a native CSS engine painting it and the stylesheet coming from the same Vite +
     * Tailwind build the web renderer uses. Desktop only, experimental, and opt-in.
     *
     * Which surface `"web"` lands on is the platform's business and never a game's: no config,
     * type or document names the engine underneath.
     */
    readonly renderer?: ThreeNativeUiRenderer;
  };
}
