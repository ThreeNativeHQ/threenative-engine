// Shared by both CPU workload families. The runner that owns these files is deliberately not a
// fallback: a missing or relative source fails closed so a capture never silently measures the
// runner's own modules instead of the requested checkout.
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The absolute checkout the CPU wrapper asked this worker to measure. */
export function selectedSourceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const source = env.TN_CPU_BENCH_SOURCE;
  if (source === undefined || source.length === 0) {
    throw new Error(
      "TN_CPU_BENCH_SOURCE is not set; the CPU wrapper must name the absolute checkout to measure",
    );
  }
  if (!path.isAbsolute(source)) {
    throw new Error(`TN_CPU_BENCH_SOURCE must be an absolute path, received '${source}'`);
  }
  return source;
}

/** Import one module from the selected checkout by absolute path, never the runner's copy. */
export async function importSelectedSource<T>(
  relativePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const file = path.join(selectedSourceRoot(env), relativePath);
  return (await import(pathToFileURL(file).href)) as T;
}
