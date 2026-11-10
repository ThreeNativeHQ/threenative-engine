/**
 * three's loader base classes in JavaScript (three's own modules, MIT), for the browser back end:
 * `Loader`, `FileLoader`, `LoadingManager` and `Cache` only fetch and track requests, so they draw
 * nothing and need no engine call. An upstream loader that extends them (KTX2Loader, PRD-867) runs
 * over the engine's textures unchanged.
 */
import { Cache } from "three/src/loaders/Cache.js";
import { FileLoader } from "three/src/loaders/FileLoader.js";
import { Loader } from "three/src/loaders/Loader.js";
import { DefaultLoadingManager, LoadingManager } from "three/src/loaders/LoadingManager.js";

export const LOADERS = { Cache, DefaultLoadingManager, FileLoader, Loader, LoadingManager };
