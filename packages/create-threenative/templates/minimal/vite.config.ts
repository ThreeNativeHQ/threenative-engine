import { threenative } from "create-threenative";
import { defineConfig } from "vite";

// `threenative()` is every plugin the kits share; add the game's own after it.
export default defineConfig({
  plugins: [threenative()],
});
