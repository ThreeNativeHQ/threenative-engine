// Perry has no page: a web game's relative URL names a file under its `public/` directory
// (TN_ASSET_ROOT overrides it), as a static server would. A URL with a scheme stays a URL.
const assetRoot = (process.env.TN_ASSET_ROOT ?? "public").replace(/\/+$/, "");
export function assetPath(url: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return undefined;
  const path = decodeURIComponent(url.replace(/[?#].*$/, "")).replace(/^(\.?\/)+/, "");
  if (path.split("/").includes(".."))
    throw new Error(`TN_PERRY_ASSET_PATH: ${url} leaves the root`);
  return `${assetRoot}/${path}`;
}
