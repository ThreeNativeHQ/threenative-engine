// Community procedural sharing (PRD-918): a developer who opted in on this machine can share the
// procedural bakes they saved (`assets/procedural/**.glb`) with every Asset Library user. Only a
// self-contained binary glTF 2.0 under 25 MB qualifies; downloads, levels and LOD siblings never do.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { modelFamily } from "./scrub-trace.js";
import { readPrefs } from "./telemetry-prefs.js";

export const PROCEDURAL_ENDPOINT = "https://threenative.com/api/telemetry/procedurals";
export const MAX_GLB_BYTES = 25 * 1024 * 1024;

/** Why `relative` (a project path) can never be shared, or undefined when its location qualifies. */
export function procedurallyExcluded(relative: string): string | undefined {
  const file = relative.replaceAll("\\", "/");
  if (file.includes("..") || path.isAbsolute(file)) return "outside the project";
  if (!file.startsWith("assets/procedural/"))
    return "not a saved procedural bake (assets/procedural/)";
  if (/(^|\/)(downloads|levels)\//u.test(file)) return "third-party download or level";
  if (/-lod\d+\.glb$/u.test(file)) return "a generated LOD sibling";
  if (!file.endsWith(".glb")) return "not a .glb";
  return undefined;
}

/** Checks a GLB is binary glTF 2.0, self-contained and within size. Throws naming the first fault. */
export function validateGlb(bytes: Uint8Array): { readonly json: Record<string, unknown> } {
  if (bytes.byteLength > MAX_GLB_BYTES) throw new Error("over 25 MB");
  if (bytes.byteLength < 20) throw new Error("not a GLB (too short)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB (bad magic)");
  if (view.getUint32(4, true) !== 2) throw new Error("not glTF 2.0");
  if (view.getUint32(8, true) !== bytes.byteLength)
    throw new Error("GLB length header does not match the file");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > bytes.byteLength)
    throw new Error("GLB has no JSON chunk");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("GLB JSON chunk does not parse");
  }
  for (const key of ["buffers", "images"] as const) {
    const list = json[key];
    if (!Array.isArray(list)) continue;
    for (const item of list as { uri?: unknown }[])
      if (typeof item.uri === "string")
        throw new Error(`${key} reference an external or inline URI; not self-contained`);
  }
  return { json };
}

export interface IProceduralShare {
  readonly path: string;
  /** Who asked: a person pressing Share, or an agent saving a bake (then `model` is required). */
  readonly source: "manual" | "agent";
  readonly model?: string;
  readonly prompt?: string;
  readonly tags?: readonly string[];
}

/**
 * Shares one saved bake. Sends nothing unless `shareProcedurals` is on in this machine's consent
 * file; an agent-triggered share also needs an allowlisted model.
 */
export async function shareProcedural(
  root: string,
  share: IProceduralShare,
  options: { readonly fetch?: typeof fetch; readonly endpoint?: string } = {},
): Promise<{ readonly sha256: string; readonly status: number }> {
  if (!(await readPrefs()).shareProcedurals)
    throw new Error("Share procedurals is off on this machine.");
  const excluded = procedurallyExcluded(share.path);
  if (excluded) throw new Error(`${share.path}: ${excluded}`);
  const family = share.source === "agent" ? modelFamily(share.model) : undefined;
  if (share.source === "agent" && !family)
    throw new Error(
      `an agent share needs an opus/astra/neon/fable model, got ${share.model ?? "none"}`,
    );
  const file = path.resolve(root, share.path);
  if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("outside the project");
  if ((await stat(file)).size > MAX_GLB_BYTES) throw new Error(`${share.path}: over 25 MB`);
  const bytes = await readFile(file);
  validateGlb(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const preview = file.replace(/\.glb$/u, ".png");
  const form = new FormData();
  form.set("glb", new Blob([bytes], { type: "model/gltf-binary" }), path.basename(file));
  const png = await readFile(preview).catch(() => undefined);
  if (png) form.set("preview", new Blob([png], { type: "image/png" }), path.basename(preview));
  form.set(
    "meta",
    JSON.stringify({
      name: path.basename(file, ".glb"),
      sha256,
      source: share.source,
      ...(family ? { modelFamily: family } : {}),
      ...(share.prompt ? { prompt: share.prompt.slice(0, 2000) } : {}),
      tags: (share.tags ?? []).slice(0, 12).map((tag) => String(tag).slice(0, 40)),
    }),
  );
  const response = await (options.fetch ?? fetch)(options.endpoint ?? PROCEDURAL_ENDPOINT, {
    method: "POST",
    body: form,
  });
  if (!response.ok && response.status !== 409)
    throw new Error(`share failed: HTTP ${response.status}`);
  return { sha256, status: response.status };
}
