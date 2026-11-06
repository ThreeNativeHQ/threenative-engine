import { TerrainEvaluator, bakeMesh, makeExport, validateDocument } from "../index.js";
import type { ExportKind, IExportArchive, ITerrainDocument, ITerrainState } from "../index.js";

export interface IWorkerRequest {
  id: number;
  type: "export" | "evaluate";
  recipe: ITerrainDocument;
  resolution: number;
  kind?: ExportKind;
}
export type EditorWorkerReply =
  | { id: number; type: "progress"; progress: { index: number; total: number; id: string } }
  | { id: number; type: "error"; error: string }
  | { id: number; type: "evaluated"; state: ITerrainState; normal: Float32Array; ms: number }
  | { id: number; type: "exported"; output: IExportArchive };
interface IEditorWorkerScope {
  onmessage: ((event: MessageEvent<IWorkerRequest>) => Promise<void>) | null;
  postMessage(message: EditorWorkerReply, transfer?: Transferable[]): void;
}
const worker = globalThis as typeof globalThis & IEditorWorkerScope;
const evaluator = new TerrainEvaluator({ cacheMB: 48 });
worker.onmessage = async ({ data }) => {
  const { id, type, recipe, resolution, kind } = data;
  try {
    validateDocument(recipe);
    const start = performance.now();
    const state = evaluator.evaluate(recipe, {
      resolution,
      onProgress: (p) => worker.postMessage({ id, type: "progress", progress: p }),
    });
    if (type === "export") {
      if (!kind) throw new Error("Missing export kind");
      const output = await makeExport(state, recipe, kind);
      if (!(output.bytes.buffer instanceof ArrayBuffer))
        throw Error("Export buffer is not transferable");
      worker.postMessage({ id, type: "exported", output }, [output.bytes.buffer]);
    } else {
      const normal = bakeMesh(state).normals;
      const transfer = [state.height, normal, state.splat].map(({ buffer }) => {
        if (!(buffer instanceof ArrayBuffer)) throw Error("Terrain buffer is not transferable");
        return buffer;
      });
      worker.postMessage(
        { id, type: "evaluated", state, normal, ms: performance.now() - start },
        transfer,
      );
    }
  } catch (error) {
    worker.postMessage({
      id,
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
