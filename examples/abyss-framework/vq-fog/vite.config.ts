import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "dist", emptyOutDir: true },
  plugins: [
    {
      name: "fog-fixture-http-diagnostics",
      configurePreviewServer(server) {
        const log = process.env.VQ_FOG_HTTP_LOG;
        if (log === undefined) return;
        mkdirSync(path.dirname(log), { recursive: true });
        server.middlewares.use((request, response, next) => {
          response.on("finish", () => {
            if (response.statusCode >= 400)
              appendFileSync(
                log,
                `${JSON.stringify({ url: request.url, status: response.statusCode })}\n`,
              );
          });
          next();
        });
      },
    },
  ],
});
