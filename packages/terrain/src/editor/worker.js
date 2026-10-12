import { TerrainEvaluator, makeExport, validateDocument } from "../index.js";
const evaluator = new TerrainEvaluator({ cacheMB: 48 });
self.onmessage = async ({ data }) => {
  const { id, type, recipe, resolution, kind } = data;
  try {
    validateDocument(recipe);
    const start = performance.now();
    const state = evaluator.evaluate(recipe, {
      resolution,
      onProgress: (p) => self.postMessage({ id, type: "progress", progress: p }),
    });
    if (type === "export") {
      const output = await makeExport(state, recipe, kind);
      self.postMessage({ id, type: "exported", output }, [output.bytes.buffer]);
    } else self.postMessage({ id, type: "evaluated", state, ms: performance.now() - start });
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
