import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No `@tailwindcss/vite`: the stylesheet the native engine resolves is exactly `src/ui/plain.css`.
export default defineConfig({ plugins: [react()] });
