import {
  type IMcpPackage,
  type IMcpServerEntry,
  MCP_PACKAGES,
  MCP_SERVERS,
} from "../../core/mcp/servers.mjs";

/**
 * The scaffolder's view of `@threenative/core`'s one server table.
 *
 * The CLI is bundled, so this import is inlined at build time and the published `create-threenative`
 * carries no runtime dependency on core. Every list of "the MCP servers a project has" in this
 * package derives from here: the scaffold validator (`index.ts`) and `threenative doctor`
 * (`doctor.ts`) each used to retype the same three servers, and a fourth server added to core
 * would have left both of them quietly describing a project that no longer exists.
 */

export { ensureHostMcpConfigs } from "../../core/mcp/install.mjs";
export { MCP_PACKAGES, MCP_SERVERS };
export type { IMcpPackage, IMcpServerEntry };

/** The shim a server launches, for example `./node_modules/@threenative/core/mcp/assets.mjs`. */
export function serverEntryPath(server: IMcpServerEntry): string {
  const entry = server.args[0];
  if (entry === undefined) {
    throw new Error("TN_MCP_TABLE: an MCP server entry declares no shim to launch.");
  }
  return entry;
}

/** The `MCP_PACKAGES` key a server's shim belongs to — `assets.mjs` is `MCP_PACKAGES.assets`. */
export function serverPackageKey(server: IMcpServerEntry): string {
  const entry = serverEntryPath(server);
  const file = entry.slice(entry.lastIndexOf("/") + 1);
  return file.endsWith(".mjs") ? file.slice(0, -".mjs".length) : file;
}
