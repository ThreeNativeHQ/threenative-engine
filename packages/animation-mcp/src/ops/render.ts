import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { attachInto } from "./attach.js";
import type { ClipEdit } from "./clip-edit.js";
import type { AnimationLog, AnimationOp } from "./log.js";
import { applyEdits, readDocument, writeDocument } from "./modify.js";

export interface RenderResult {
  readonly clips: readonly string[];
  readonly edits: number;
  readonly file: string;
  readonly modified: readonly string[];
}

/** The edits the log asks for, per clip, in the order they were recorded. */
export function editsByClip(ops: readonly AnimationOp[]): Map<string, ClipEdit[]> {
  const edits = new Map<string, ClipEdit[]>();
  for (const op of ops) {
    if (op.op !== "modify") continue;
    edits.set(op.clip, [...(edits.get(op.clip) ?? []), op.edit]);
  }
  return edits;
}

/**
 * Renders what the log describes from the source GLB: the attachment, then every clip edit, in the
 * order a human and an agent wrote them. Nothing here reads the previous output, so two runs of one
 * log on one source are the same bytes — which is the property AC-4 is really asking for.
 */
export async function renderLog(log: AnimationLog, outputFile: string): Promise<RenderResult> {
  const document = await readDocument(log.host);
  const attached = log.ops.some((op) => op.op === "attach")
    ? await attachInto(document, log)
    : undefined;
  const edits = editsByClip(log.ops);
  for (const [clip, clipEdits] of edits) applyEdits(document, clip, clipEdits);
  const writer = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await writer.write(outputFile, document);
  return {
    clips: attached?.clips ?? [],
    edits: [...edits.values()].reduce((total, list) => total + list.length, 0),
    file: outputFile,
    modified: [...edits.keys()],
  };
}
