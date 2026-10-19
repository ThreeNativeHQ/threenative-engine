import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The one build for both targets.
 *
 * `src/ui/main.tsx` is the entry the native build compiles with this config to obtain the stylesheet
 * the native CSS engine resolves; `index.html` is the browser reference. Both reach the same
 * `src/ui/Inventory.tsx` and the same `src/ui/hud.css`, so the CSS those two produce is one artifact.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
