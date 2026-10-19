import { appendFileSync } from "node:fs";
import { defineConfig } from "vite";

// Observe failed fixture requests, without changing their responses or waiving console errors.
export default defineConfig({
  plugins: [
    {
      name: "exposure-fixture-http-errors",
      configurePreviewServer(server) {
        const file = process.env.TN_EXPOSURE_HTTP_LOG;
        if (file === undefined) return;
        server.middlewares.use((request, response, next) => {
          response.once("finish", () => {
            if (response.statusCode >= 400)
              appendFileSync(
                file,
                `${JSON.stringify({ method: request.method, url: request.url, status: response.statusCode })}\n`,
              );
          });
          next();
        });
      },
    },
  ],
});
