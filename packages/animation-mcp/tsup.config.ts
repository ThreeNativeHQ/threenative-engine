import { defineConfig } from "tsup";

export default defineConfig([
  {
    banner: { js: "#!/usr/bin/env node" },
    clean: true,
    dts: true,
    entry: { index: "src/index.ts" },
    format: ["esm"],
    // Core carries the built server as a committed copy, so the copy must resolve on its own:
    // a bare `import "@modelcontextprotocol/server"` inside `packages/core/mcp/` fails with
    // ERR_MODULE_NOT_FOUND, which is a server that starts and dies before `initialize`.
    minify: true,
    noExternal: [/.*/u],
    outDir: "dist",
    platform: "node",
    sourcemap: false,
    splitting: false,
    target: "node20",
    treeshake: true,
  },
  {
    // The view server is its own entry so `animation_open_view` can start it in-process without
    // pulling the stdio entry's argv handling along.
    banner: { js: "#!/usr/bin/env node" },
    clean: false,
    dts: true,
    entry: { server: "src/server.ts" },
    format: ["esm"],
    // Core carries the built server as a committed copy, so the copy must resolve on its own:
    // a bare `import "@modelcontextprotocol/server"` inside `packages/core/mcp/` fails with
    // ERR_MODULE_NOT_FOUND, which is a server that starts and dies before `initialize`.
    noExternal: [/.*/u],
    outDir: "dist",
    platform: "node",
    sourcemap: false,
    splitting: false,
    target: "node20",
    treeshake: true,
  },
  {
    clean: false,
    entry: { app: "src/client/main.tsx" },
    format: ["esm"],
    noExternal: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "three"],
    outDir: "dist/client",
    platform: "browser",
    splitting: false,
    target: "es2022",
  },
]);
