import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { WEBGPU_BROWSER_ARGS } from "../../playtest/src/runner/browser.js";
import {
  MCP_HOSTS,
  ensureCodexMcpConfig,
  ensureHostMcpConfigs,
  ensureMcpConfig,
  installTarget,
} from "../mcp/install.mjs";
import { MCP_PACKAGES, MCP_SERVERS, mergeMcpServers } from "../mcp/servers.mjs";

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");

function project(
  name = "game",
  dependencies: Record<string, string> = { "@threenative/core": "0.3.0" },
): string {
  const directory = makeTempDirSync("tn-mcp-");
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ dependencies, name }));
  return directory;
}

describe("mergeMcpServers", () => {
  it("declares every ThreeNative server when the project has no config", () => {
    const { changed, config } = mergeMcpServers(undefined);

    expect(changed).toBe(true);
    expect(Object.keys(config.mcpServers ?? {})).toEqual([
      "threenative-assets",
      "threenative-sculpt",
      "threenative-engine",
      "threenative-animation",
      "threenative-devtools",
    ]);
  });

  it("keeps servers it did not write", () => {
    const mine = { command: "node", args: ["./mine.mjs"] };

    const { config } = mergeMcpServers({ mcpServers: { mine } });

    expect(config.mcpServers?.mine).toEqual(mine);
    expect(config.mcpServers?.["threenative-assets"]).toBeDefined();
  });

  it("reports no change once the servers are already declared", () => {
    const first = mergeMcpServers(undefined);

    expect(mergeMcpServers(first.config).changed).toBe(false);
  });

  it("refuses a config whose root is not an object", () => {
    expect(() => mergeMcpServers([])).toThrow(/must be an object/u);
  });

  it("refuses a malformed server table rather than spreading or replacing it", () => {
    expect(() => mergeMcpServers({ mcpServers: null })).toThrow(/mcpServers.*must be an object/u);
    expect(() => mergeMcpServers({ mcpServers: { mine: "not-a-server" } })).toThrow(
      /server 'mine'.*must be an object/u,
    );
  });

  it("preserves a same-name user server and reports the conflict", () => {
    const custom = { command: "custom-node", args: ["./my-engine.mjs"] };
    const result = mergeMcpServers({ mcpServers: { "threenative-engine": custom } }) as ReturnType<
      typeof mergeMcpServers
    > & { conflicts: string[] };

    expect(result.config.mcpServers?.["threenative-engine"]).toEqual(custom);
    expect(result.conflicts).toEqual(["threenative-engine"]);
    expect(result.changed).toBe(true);
  });
});

describe("MCP_SERVERS", () => {
  it("installs every server transitively with core", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // Derived from MCP_PACKAGES, not retyped: the shim and the manifest name one pin, and a
    // literal here is how they came apart — the PRD-383 bump to the asset server moved
    // `package.json` and left this spec asserting the version before it. `servers.mjs` is
    // JavaScript, so its record is typed as possibly-missing; a missing entry is a broken shim,
    // which fails here rather than quietly asserting nothing.
    const { assets, devtools, sculpt } = MCP_PACKAGES;
    if (assets === undefined || devtools === undefined || sculpt === undefined) {
      throw new Error("MCP_PACKAGES must declare the asset, DevTools and sculpt servers.");
    }
    expect(manifest.dependencies).toMatchObject({
      [assets.name]: assets.version,
      [devtools.name]: devtools.version,
      [sculpt.name]: sculpt.version,
    });
    // The animation server has never been published, so a registry dependency on it is an install
    // that cannot resolve: core devDepends on it and carries a built copy instead.
    expect(manifest.dependencies?.["threenative-animation-mcp"]).toBeUndefined();
    expect(manifest.devDependencies?.["threenative-animation-mcp"]).toBe("workspace:*");
  });

  // The five are ordered, not merely present: a host renders the table in declaration order and
  // the golden-path snapshot probes them by index. A server appended in the wrong place is the
  // kind of change that passes every set-shaped assertion and moves what a user sees.
  it("should declare five ThreeNative servers", () => {
    expect(Object.keys(MCP_SERVERS)).toEqual([
      "threenative-assets",
      "threenative-sculpt",
      "threenative-engine",
      "threenative-animation",
      "threenative-devtools",
    ]);
  });

  // A DevTools trace on SwiftShader names software rendering's functions, so the server launches
  // Chrome with the playtest's own WebGPU recipe. A flag changed on one side only is caught here.
  it("launches DevTools Chrome with the playtest WebGPU recipe", () => {
    const chromeArgs = (MCP_PACKAGES.devtools?.args ?? [])
      .filter((argument) => argument.startsWith("--chromeArg="))
      .map((argument) => argument.slice("--chromeArg=".length));

    expect(chromeArgs).toEqual([...WEBGPU_BROWSER_ARGS]);
    expect(MCP_PACKAGES.devtools?.args).toEqual(
      expect.arrayContaining(["--isolated", "--no-usage-statistics", "--no-performance-crux"]),
    );
  });

  // The npx fallback in `launch.mjs` names the package `MCP_PACKAGES` declares, so a shim whose
  // package is undeclared spawns `npx undefined@undefined` on a machine that has not installed it.
  it("declares the package every shim launches", () => {
    for (const server of Object.values(MCP_SERVERS)) {
      const entry = server.args[0] ?? "";
      const key = entry.slice(entry.lastIndexOf("/") + 1).replace(/\.mjs$/u, "");
      const declared = MCP_PACKAGES[key];
      // `engine` resolves inside core itself when the bundle exists; every shim still names a
      // package for the npx path.
      expect(declared, key).toBeDefined();
      expect(declared?.name.length, key).toBeGreaterThan(0);
      expect(declared?.version.length, key).toBeGreaterThan(0);
    }
  });

  /**
   * Both remaining bundles must be **tracked**, not merely generated.
   *
   * `launch.mjs` falls back to `npx <pkg>@<version>` when a server package is not installed, so a
   * core tarball missing a bundle turns a local, offline server start into a registry fetch. For
   * `threenative-engine-mcp`, which is published, that still works over the network inside a
   * 30-second probe budget —
   *
   *   TN_GOLDEN_PATH_FAILED: template 'starter' at layer 'mcp'.
   *   threenative-engine initialize timed out after 30000ms.
   *
   * which is a required check failing on runner luck. Neither file lives under `dist/`, so CI's
   * build cache cannot restore it and core's bundling step is not guaranteed to run at all; only
   * `git` guarantees a checkout has them.
   */
  it("tracks both bundled MCP servers, so a checkout carries them", () => {
    const tracked = execFileSync("git", ["ls-files", "packages/core/mcp"], {
      cwd: path.resolve("."),
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line.length > 0);
    for (const bundle of ["mcp/animation-server.mjs", "mcp/engine-server.mjs"]) {
      expect(
        tracked,
        `packages/core/${bundle} is untracked; a checkout that skips core's build ships without it and the shim falls back to npx`,
      ).toContain(`packages/core/${bundle}`);
    }
  });

  // AC-1 of PRD-760: a generated project's `.mcp.json` starts `threenative-animation`, and a stdio
  // `tools/list` answers with the tools this commit implements. Spawned rather than imported: the
  // shim is the thing a host runs, and a shim that imports a server without starting it looks fine
  // to every assertion that never speaks to it.
  it("starts the bundled animation server and answers tools/list", async () => {
    const shim = path.join(packageRoot, "mcp", "animation.mjs");
    expect(existsSync(shim), `${shim} is missing`).toBe(true);
    const child = spawn(process.execPath, [shim], { stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map<number, (value: { result?: { tools?: { name: string }[] } }) => void>();
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as {
          id?: number;
          result?: { tools?: { name: string }[] };
        };
        if (message.id !== undefined) pending.get(message.id)?.(message);
      }
    });
    let nextId = 1;
    const send = (method: string, params: Record<string, unknown> = {}) => {
      const id = nextId++;
      return new Promise<{ result?: { tools?: { name: string }[] } }>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("animation tools/list timed out; the shim started no server"));
        }, 30_000);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
      });
    };
    try {
      await send("initialize", {
        capabilities: {},
        clientInfo: { name: "spec", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const listed = await send("tools/list");
      expect(listed.result?.tools?.map((tool) => tool.name).sort()).toEqual([
        "animation_attach",
        "animation_inspect",
        "animation_modify",
        "animation_open_view",
        "animation_verify",
      ]);
    } finally {
      child.kill();
    }
  });

  // A renamed or moved shim would leave `.mcp.json` pointing at nothing, and the host reports that
  // as a server that failed to start rather than as a packaging mistake.
  it("names a shim this package actually ships", () => {
    for (const server of Object.values(MCP_SERVERS)) {
      const entry = server.args[0] ?? "";
      const shim = entry.replace("./node_modules/@threenative/core/", "");
      expect(shim).not.toBe("");
      expect(existsSync(path.join(packageRoot, shim))).toBe(true);
    }
  });
});

describe("installTarget", () => {
  it("uses the directory the install was run from", () => {
    const directory = project();

    expect(installTarget({ INIT_CWD: directory })).toBe(directory);
  });

  it("skips an install nested under node_modules", () => {
    const directory = project();
    const nested = path.join(directory, "node_modules", "other");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "package.json"), JSON.stringify({ name: "other" }));

    expect(installTarget({ INIT_CWD: nested })).toBeUndefined();
  });

  it("skips core's own workspace install", () => {
    expect(installTarget({ INIT_CWD: project("@threenative/core") })).toBeUndefined();
  });

  it("skips a workspace root that does not depend on core", () => {
    expect(installTarget({ INIT_CWD: project("threenative", {}) })).toBeUndefined();
  });

  it("skips a directory that is not a project", () => {
    expect(installTarget({ INIT_CWD: makeTempDirSync("tn-bare-") })).toBeUndefined();
  });

  it("skips a package manifest whose JSON root is not an object", () => {
    const directory = makeTempDirSync("tn-invalid-manifest-");
    writeFileSync(path.join(directory, "package.json"), "null");

    expect(installTarget({ INIT_CWD: directory })).toBeUndefined();
  });
});

describe("ensureMcpConfig", () => {
  it("creates the config, then leaves a matching one alone", () => {
    const directory = project();

    expect(ensureMcpConfig(directory)).toBe("created");
    const written = JSON.parse(readFileSync(path.join(directory, ".mcp.json"), "utf8"));
    expect(written.mcpServers["threenative-assets"].env.ASSET_DOWNLOAD_DIR).toBe("./public/assets");
    expect(ensureMcpConfig(directory)).toBe("unchanged");
  });

  it("never overwrites a config it cannot parse", () => {
    const directory = project();
    const configPath = path.join(directory, ".mcp.json");
    writeFileSync(configPath, "{ not json");

    expect(ensureMcpConfig(directory)).toBe("unreadable");
    expect(readFileSync(configPath, "utf8")).toBe("{ not json");
  });

  it("does not replace a same-name user server during reinstall", () => {
    const directory = project();
    const configPath = path.join(directory, ".mcp.json");
    const custom = { command: "custom-node", args: ["./my-engine.mjs"] };
    writeFileSync(configPath, JSON.stringify({ mcpServers: { "threenative-engine": custom } }));

    expect(ensureMcpConfig(directory)).toBe("conflict");
    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers["threenative-engine"]).toEqual(custom);
    expect(written.mcpServers["threenative-assets"]).toBeDefined();
  });

  it("reports a malformed server table without replacing it", () => {
    const directory = project();
    const configPath = path.join(directory, ".mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: null }));

    expect(ensureMcpConfig(directory)).toBe("unreadable");
    expect(readFileSync(configPath, "utf8")).toContain('"mcpServers":null');
  });
});

describe("ensureCodexMcpConfig", () => {
  it("creates Codex project config with all servers, then leaves it alone", () => {
    const directory = project();

    expect(ensureCodexMcpConfig(directory)).toBe("created");
    const configPath = path.join(directory, ".codex", "config.toml");
    const written = readFileSync(configPath, "utf8");
    expect(written).toContain("[mcp_servers.threenative-assets]");
    expect(written).toContain("[mcp_servers.threenative-sculpt]");
    expect(written).toContain("[mcp_servers.threenative-engine]");
    expect(written).toContain("./node_modules/@threenative/core/mcp/engine.mjs");
    expect(ensureCodexMcpConfig(directory)).toBe("unchanged");
    expect(readFileSync(configPath, "utf8")).toBe(written);
  });

  it("preserves user settings and an existing server while appending missing servers", () => {
    const directory = project();
    const codexDirectory = path.join(directory, ".codex");
    mkdirSync(codexDirectory);
    const configPath = path.join(codexDirectory, "config.toml");
    const existing =
      'model = "user-choice"\n\n[mcp_servers.threenative-engine]\ncommand = "custom"\n';
    writeFileSync(configPath, existing);

    expect(ensureCodexMcpConfig(directory)).toBe("updated");
    const written = readFileSync(configPath, "utf8");
    expect(written.startsWith(existing)).toBe(true);
    expect(written.match(/\[mcp_servers\.threenative-engine\]/gu)).toHaveLength(1);
    expect(written).toContain("[mcp_servers.threenative-assets]");
    expect(written).toContain("[mcp_servers.threenative-sculpt]");
  });
});

describe("ensureHostMcpConfigs", () => {
  it("wires every host this project can auto-configure", () => {
    const directory = project();

    const outcomes = ensureHostMcpConfigs(directory);

    expect([...outcomes.keys()].sort()).toEqual(
      ["claude-code", "codex", "cursor", "gemini-cli", "opencode", "vscode", "zed"].sort(),
    );
    for (const [host, outcome] of outcomes) expect(outcome, host).toBe("created");
    for (const host of MCP_HOSTS) {
      expect(existsSync(path.join(directory, host.file)), host.id).toBe(true);
    }
    expect(ensureHostMcpConfigs(directory).get("cursor")).toBe("unchanged");
  });

  it("writes each host the shape that host actually reads", () => {
    const directory = project();
    ensureHostMcpConfigs(directory);
    const read = (file: string): unknown =>
      JSON.parse(readFileSync(path.join(directory, file), "utf8")) as unknown;

    const cursor = read(".cursor/mcp.json") as { mcpServers: Record<string, { args: string[] }> };
    expect(cursor.mcpServers["threenative-assets"]?.args[0]).toBe(
      "./node_modules/@threenative/core/mcp/assets.mjs",
    );

    const code = read(".vscode/mcp.json") as {
      servers: Record<string, { args: string[]; type: string }>;
    };
    expect(code.servers["threenative-engine"]?.type).toBe("stdio");
    expect(code.servers["threenative-engine"]?.args[0]).toBe(
      "./node_modules/@threenative/core/mcp/engine.mjs",
    );

    const gemini = read(".gemini/settings.json") as { mcpServers: Record<string, unknown> };
    expect(Object.keys(gemini.mcpServers)).toHaveLength(Object.keys(MCP_SERVERS).length);

    const opencode = read("opencode.json") as {
      mcp: Record<
        string,
        { command: string[]; enabled: boolean; environment?: object; type: string }
      >;
    };
    expect(opencode.mcp["threenative-assets"]?.type).toBe("local");
    expect(opencode.mcp["threenative-assets"]?.command).toEqual([
      "node",
      "./node_modules/@threenative/core/mcp/assets.mjs",
    ]);
    expect(opencode.mcp["threenative-assets"]?.environment).toMatchObject({
      ASSET_DOWNLOAD_DIR: "./public/assets",
    });

    const zed = read(".zed/settings.json") as {
      context_servers: Record<string, { command: string; source: string }>;
    };
    expect(zed.context_servers["threenative-sculpt"]?.source).toBe("custom");
    expect(zed.context_servers["threenative-sculpt"]?.command).toBe("node");
  });

  it("keeps unrelated settings a host config already holds", () => {
    const directory = project();
    mkdirSync(path.join(directory, ".gemini"), { recursive: true });
    writeFileSync(
      path.join(directory, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { mine: { command: "node" } }, theme: "Dracula" }),
    );

    expect(ensureHostMcpConfigs(directory).get("gemini-cli")).toBe("updated");
    const written = JSON.parse(
      readFileSync(path.join(directory, ".gemini", "settings.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown>; theme: string };
    expect(written.theme).toBe("Dracula");
    expect(written.mcpServers.mine).toEqual({ command: "node" });
    expect(written.mcpServers["threenative-engine"]).toBeDefined();
  });

  it("never overwrites a host config it cannot parse", () => {
    const directory = project();
    mkdirSync(path.join(directory, ".cursor"), { recursive: true });
    const configPath = path.join(directory, ".cursor", "mcp.json");
    writeFileSync(configPath, "{ not json");

    expect(ensureHostMcpConfigs(directory).get("cursor")).toBe("unreadable");
    expect(readFileSync(configPath, "utf8")).toBe("{ not json");
  });

  // The Codex block was three hand-written TOML strings beside the same three servers declared in
  // `MCP_SERVERS`. Two lists of the same thing drift, and the drift is silent.
  it("derives the Codex block from the same server table as the JSON hosts", () => {
    const directory = project();

    ensureHostMcpConfigs(directory);

    const codex = readFileSync(path.join(directory, ".codex", "config.toml"), "utf8");
    for (const [name, server] of Object.entries(MCP_SERVERS)) {
      expect(codex).toContain(`[mcp_servers.${name}]`);
      expect(codex).toContain(`args = ["${server.args[0]}"]`);
    }
  });
});

describe("the sculpt server the engine ships", () => {
  it("is pinned to one version in the manifest and in the launch shim", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    const sculpt = MCP_PACKAGES.sculpt;
    if (sculpt === undefined) throw new Error("MCP_PACKAGES.sculpt is missing.");

    expect(manifest.dependencies[sculpt.name]).toBe(sculpt.version);
  });

  it("serves the 0.2 rig and animation gates through the shipped launch shim", async () => {
    const child = spawn(process.execPath, [path.join(packageRoot, "mcp", "sculpt.mjs")], {
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines: string[] = [];
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      lines.push(...parts.filter(Boolean));
    });
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const reply = async (id: number) => {
      for (let waited = 0; waited < 20_000; waited += 50) {
        const found = lines.map((line) => JSON.parse(line)).find((m) => m.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no reply to request ${id}`);
    };

    try {
      send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "mcp-install-spec", version: "0" },
          protocolVersion: "2025-06-18",
        },
      });
      await reply(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ id: 2, jsonrpc: "2.0", method: "tools/list" });
      const listed = (await reply(2)) as { result: { tools: { name: string }[] } };

      expect(listed.result.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "sculpt_action_design",
          "sculpt_clip_measure",
          "sculpt_mesh_parity",
          "sculpt_rig_gate",
          "sculpt_rig_reference",
          "sculpt_rig_spec_gate",
          "sculpt_skin_condition",
        ]),
      );
    } finally {
      child.kill();
    }
  }, 30_000);

  // Authoring-layer regression guard (PRD-750 row 1): a session started outside the game never
  // loads .mcp.json, and the scaffold tells it to call the shim by absolute path instead.
  it("answers one engine call through the shim from outside the project, and fails closed", () => {
    const outside = makeTempDirSync("engine-cli-cwd");
    const shim = path.join(packageRoot, "mcp", "engine.mjs");
    const env = { ...process.env, THREENATIVE_ENGINE_MCP_LOG: "off" };
    const call = (...args: string[]) =>
      spawnSync(process.execPath, [shim, ...args], {
        cwd: outside,
        encoding: "utf8",
        env,
        input: "",
        timeout: 20_000,
      });
    const found = call(
      "engine_search_capabilities",
      '{"situation":"make me a game like super mario 64"}',
    );
    expect(found.status, found.stderr).toBe(0);
    expect(JSON.parse(found.stdout).starterKits?.[0]?.name).toBe("collectathon");
    const unknown = call("engine_no_such_tool", "{}");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/engine_no_such_tool/u);
  }, 30_000);
});
