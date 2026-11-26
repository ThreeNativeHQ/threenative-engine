// The one contract every Asset Library consumer plugs into (PRD-915): a source lists elements and
// answers its own routes on the dev server; an optional browser client builds or dresses them.
// Types only, so both the Node plugin and the prebuilt browser shell import it at no cost.
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";

/** One control in the addon panel; `only` limits it to those element ids. Unset = the default. */
export interface IAssetControl {
  readonly key: string;
  readonly label: string;
  readonly type: "range" | "select" | "toggle" | "text" | "color" | "vec3";
  readonly group?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  readonly labels?: readonly string[];
  readonly default?: number | string | boolean | readonly number[];
  readonly only?: readonly string[];
}

/** One story in the tree. `source` is the id of the source that listed it. */
export interface IAssetElement {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly source: string;
  /** Visual style ids. The first identifies the collection in the tree. */
  readonly styleTags: readonly string[];
  /** Setting ids, such as medieval or sci-fi. An asset can fit several settings. */
  readonly settingTags?: readonly string[];
  readonly biomes?: readonly string[];
  readonly category?: string;
  readonly latin?: string;
  /** The source call that makes it, shown in Docs. */
  readonly bake?: string;
  readonly variants?: number;
  readonly variantNames?: readonly string[];
  /** A whole scene or sky: an overview opens it alone instead of lining it up. */
  readonly backdrop?: boolean;
  /** A project-relative file, for file-backed elements (models, textures, audio, stories). */
  readonly path?: string;
}

/** How the shell treats a kind: its tree name, its pack name, and which shared controls it gets. */
export interface IAssetKind {
  readonly name?: string;
  readonly pack?: string;
  /** Shows the LOD 0/1/2 control (a baked kind with levels). */
  readonly lod?: boolean;
  /** Shows the seed control. Default true for bake and runtime kinds. */
  readonly seed?: boolean;
  /** Built in the browser by the source's client, not baked by the server. */
  readonly runtime?: boolean;
  /** Remote asset catalog loaded lazily one row at a time rather than bulk-fetched on Overview. */
  readonly lazy?: boolean;
}

export interface IAssetBiome {
  readonly id: string;
  readonly name: string;
  readonly rock?: string;
}

export interface IAssetCatalog {
  readonly elements: readonly IAssetElement[];
  readonly biomes?: readonly IAssetBiome[];
  /** Collection id -> heading; an element's first style tag is its collection. */
  readonly styles: Readonly<Record<string, string>>;
  /** Setting id -> filter and Docs label. */
  readonly settings?: Readonly<Record<string, string>>;
  readonly controls?: Readonly<Record<string, readonly IAssetControl[]>>;
  readonly kinds?: Readonly<Record<string, IAssetKind>>;
}

/** The slice of Vite's dev server a source may hook (watch files, reload the page). */
export interface IAssetLibraryServer {
  readonly config: { readonly root: string };
  readonly watcher: {
    add(file: string | readonly string[]): unknown;
    on(event: "all", listener: (event: string, file: string) => void): unknown;
  };
  readonly ws: { send(payload: { type: "full-reload" }): void };
}

/** A server-side source of stories. */
export interface IAssetLibrarySource {
  readonly id: string;
  catalog(): Promise<IAssetCatalog> | IAssetCatalog;
  /**
   * Answers `<mount>api/<id>/<route>`. Resolve false to pass the request on. `route` has no
   * leading slash (`bake`, `file/rock/a.glb`).
   */
  handle?(
    route: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> | boolean;
  /** An absolute path or package specifier of a browser module whose default export is an {@link IAssetLibraryClient}. */
  readonly client?: string;
  configureServer?(server: IAssetLibraryServer): void;
}

/** What a baked or built element reports to Stats and Docs. */
export interface IAssetReport {
  readonly triangles: number;
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] };
  readonly ms: number;
  readonly call?: string;
  readonly lod?: number;
  readonly path?: string;
  readonly materialSlots?: readonly string[];
}

/** A server bake: the report plus the GLB url and any extra rows the source attaches. */
export interface IAssetBake extends IAssetReport {
  readonly url: string;
  readonly path: string;
  readonly error?: string;
  readonly [extra: string]: unknown;
}

export interface IAssetLoaded {
  readonly model: Object3D;
  readonly report: IAssetReport;
  readonly animated?: boolean;
  /** A fixed camera (a whole scene story): eye and target. */
  readonly view?: {
    readonly pos: readonly [number, number, number];
    readonly target: readonly [number, number, number];
  };
}

/** The shell's scene, handed to a source client. */
export interface IAssetViewContext {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly ground: Mesh;
  readonly grid: Object3D;
  readonly content: Object3D;
  readonly backgroundColor: Color;
  readonly roomEnvironment: Texture;
  /** Sun elevation and azimuth in degrees; `frame()` places the sun from them. */
  readonly sky: { elevation: number; azimuth: number };
  readonly state: { readonly seed?: number; readonly wire: boolean; readonly lod: number };
  readonly touched: ReadonlyMap<string, string>;
  readonly route: {
    readonly kind: string;
    readonly id?: string;
    readonly category?: string;
    readonly tiled?: string;
  };
  readonly catalog: IAssetCatalog;
  /** The background the user picked: a flat color name, or `sky` (the source's own). */
  readonly background: string;
  invalidate(): void;
  sunShadow(size: number, radius: number): void;
  say(text: string, error?: boolean): void;
  /** Whether a toolbar toggle (`grid`) is on. */
  toggled(id: string): boolean;
}

/** A source's browser half. Every hook is optional; the shell has a default for each. */
export interface IAssetLibraryClient {
  /** Builds a runtime-kind element in the browser. */
  create?(element: IAssetElement, ctx: IAssetViewContext): IAssetLoaded | Promise<IAssetLoaded>;
  /** Dresses a baked GLB scene (its own materials, a wind patch). Resolves whether it animates. */
  dress?(model: Object3D, baked: IAssetBake, ctx: IAssetViewContext): Promise<boolean> | boolean;
  /** Lights the story about to show; `loaded` is set once the element is built. */
  light?(element: IAssetElement | undefined, ctx: IAssetViewContext, loaded?: IAssetLoaded): void;
  /** Applies the user's background pick after the shell's own colors. */
  background?(ctx: IAssetViewContext): void;
  /** Advances an animated story; `dt` in seconds. */
  tick?(dt: number, ctx: IAssetViewContext): void;
  /** Renders the frame itself (a post stack). Returns true when it did. */
  render?(dt: number, ctx: IAssetViewContext): boolean;
  resize?(width: number, height: number): void;
  /** The pointer over the story: the hit point, or undefined off the model. */
  pointer?(hit: Vector3 | undefined, ctx: IAssetViewContext): void;
  /** Whether a material is shared across stories and must not be disposed. */
  shared?(material: unknown): boolean;
}

/** A browser-side story module: `src/**\/*.story.ts` default-exports one (see `defineAssetStory`). */
export interface IAssetStory<P extends Record<string, unknown> = Record<string, unknown>> {
  readonly title: string;
  readonly category?: string;
  readonly controls?: readonly IAssetControl[];
  create(props: P): Object3D | Promise<Object3D>;
  update?(dt: number, props: P): void;
  dispose?(): void;
}
