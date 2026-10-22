import { EditorSession, type IRecoveredEditorOptions } from "./app/session.js";
export function mountRecoveredEditor(options: IRecoveredEditorOptions) {
  return new EditorSession(options).api;
}
