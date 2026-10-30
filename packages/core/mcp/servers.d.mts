// Types for `servers.mjs`. That file is plain JavaScript by design — `@threenative/core`'s
// postinstall runs it before anything is built — so it can never be a `.ts`. Without this
// declaration every consumer reached for `@ts-expect-error` and then cast the result back into a
// shape of its own, which is three private copies of one contract.

export interface IMcpServerEntry {
  readonly args: readonly string[];
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface IMcpPackage {
  /** Fixed command-line arguments the shim passes to the server, in every host. */
  readonly args?: readonly string[];
  readonly name: string;
  readonly version: string;
}

/** One host's whole config with this format's server table merged in. The table's key is the
 * host's own (`mcpServers`, `servers`, `mcp`, `context_servers`), so a caller reading a key it did
 * not ask for gets `undefined` rather than a silently empty object. */
export interface IMcpConfigFormat {
  readonly changed: boolean;
  readonly config: Record<string, Record<string, Record<string, unknown>> | undefined>;
}

export interface ICodexMcpServer {
  readonly body: string;
  readonly name: string;
}

export declare const MCP_SERVERS: Readonly<Record<string, IMcpServerEntry>>;
export declare const MCP_PACKAGES: Readonly<Record<string, IMcpPackage>>;
export declare const SERVER_FORMAT_NAMES: readonly string[];
export declare const CODEX_MCP_SERVERS: readonly ICodexMcpServer[];
export declare function mergeMcpServers(existing: unknown, format?: string): IMcpConfigFormat;
