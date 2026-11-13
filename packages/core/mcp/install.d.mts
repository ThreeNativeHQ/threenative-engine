// Types for `install.mjs`, the same contract `servers.d.mts` provides for `servers.mjs`. That file
// is plain JavaScript by design — `@threenative/core`'s postinstall runs it before anything is
// built — so it can never be a `.ts`. Without this declaration every consumer reached for
// `@ts-expect-error` and then retyped the host table locally.

/** One project-scoped host config the installer writes. */
export interface IMcpHost {
  readonly file: string;
  readonly format: string;
  readonly id: string;
  readonly label: string;
  readonly seed?: Readonly<Record<string, unknown>>;
}

/** What a single config write did, or why it was left alone. */
export type McpConfigOutcome =
  | "conflict"
  | "created"
  | "unchanged"
  | "unreadable"
  | "unwritable"
  | "updated";

export declare const MCP_HOSTS: readonly IMcpHost[];
export declare function installTarget(
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
): string | undefined;
export declare function ensureJsonMcpConfig(
  target: string,
  file: string,
  format: string,
  seed?: Readonly<Record<string, unknown>>,
): McpConfigOutcome;
export declare function ensureMcpConfig(target: string): McpConfigOutcome;
export declare function ensureCodexMcpConfig(target: string): McpConfigOutcome;
export declare function ensureHostMcpConfigs(target: string): Map<string, McpConfigOutcome>;
