import { mountTerrainEditor } from "@threenative/terrain/editor";
import { createEditorView } from "./render/editorView.js";
import { terrainPalette } from "./render/palette.js";

let view: Awaited<ReturnType<typeof createEditorView>>;
void mountTerrainEditor({
  createView: async (host, controller) => {
    view = await createEditorView(host, controller);
    return view;
  },
  materialColours: terrainPalette,
  onEvaluated: ({ revision, ms }) => view.noteRevision(revision, ms),
}).catch((error) => {
  const status = document.createElement("pre");
  status.textContent = `Terrain editor startup failed: ${error instanceof Error ? error.message : String(error)}`;
  document.body.append(status);
});
