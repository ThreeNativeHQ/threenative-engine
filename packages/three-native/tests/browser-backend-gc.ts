// PRD-540: an engine object's browser wrapper keeps its JS state while another engine object holds
// it, and a subtree nothing reaches is still collected, on the real Wasm ABI module with a real
// collector. Run: tsx --expose-gc tests/browser-backend-gc.ts <tn-native-engine-abi-module.js>
// (ctest native_engine_wasm_browser_gc). Prints TN_BROWSER_GC_OK, or exits 1 naming each failure.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  type IRegistryDump,
  type TnAbiModule,
  createWasmRuntime,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import type { ICatalog } from "../src/catalog.js";

const modulePath = process.argv[2];
if (modulePath === undefined) throw new Error("usage: browser-backend-gc.ts <abi module .js>");
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("TN_BROWSER_GC_NO_COLLECTOR: run with --expose-gc");
const read = (file: string) =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "api", file), "utf8"));
const createTnAbi = createRequire(import.meta.url)(
  path.resolve(modulePath),
) as () => Promise<TnAbiModule>;
const runtime = createWasmRuntime(await createTnAbi());
const { classes, collect } = defineBrowserClasses(
  read("native-registry.json") as IRegistryDump,
  runtime,
  read("catalog.json") as ICatalog,
);

type Node3D = Record<string, unknown> & {
  userData: Record<string, unknown>;
  children: Node3D[];
  add(...objects: object[]): void;
};
const failures: string[] = [];
const check = (ok: boolean, name: string) => {
  if (!ok) failures.push(name);
};
// A full collection, then the FinalizationRegistry callbacks it queued.
const collectAll = async () => {
  for (let i = 0; i < 4; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const Group = classes.Group as new () => Node3D;
const Object3D = classes.Object3D as new () => Node3D;
class Enemy extends Object3D {
  hp = 3;
}

const scene = new Group();
let weakChild: WeakRef<Node3D>;
let weakDetached: WeakRef<Node3D>;
// Built in a function so no local keeps a wrapper alive: only the scene graph does.
(() => {
  const child = new Object3D();
  child.userData.name = "kept";
  (child as { expando?: string }).expando = "game state";
  scene.add(child, new Enemy());
  weakChild = new WeakRef(child);
  const detached = new Group();
  detached.add(new Object3D());
  weakDetached = new WeakRef(detached);
})();
collect(); // a safe point: the renderer runs one before every frame
await collectAll();

const [child, enemy] = scene.children as [Node3D, Node3D];
check(
  weakChild.deref() !== undefined && weakChild.deref() === child,
  "an attached wrapper survives collection",
);
check(child.userData.name === "kept", "userData of an attached object survives");
check(
  (child as { expando?: string }).expando === "game state",
  "an expando of an attached object survives",
);
check(
  enemy instanceof Enemy && (enemy as unknown as Enemy).hp === 3,
  "a JS subclass instance survives as itself",
);
check(weakDetached.deref() === undefined, "a detached subtree nothing reaches is collected");

if (failures.length > 0) {
  console.error(`TN_BROWSER_GC_FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("TN_BROWSER_GC_OK");
