import { defineConfig } from "vite";
export default defineConfig({
  build:
    process.env.TN_BENCH_TARGET === "native"
      ? {}
      : {
          rolldownOptions: {
            input: ["index.html", "crowd.html", "high.html", "baseline.html", "lifecycle.html"],
          },
        },
});
