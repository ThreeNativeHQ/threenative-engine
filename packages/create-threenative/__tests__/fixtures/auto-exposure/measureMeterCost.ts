import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import {
  PERFORMANCE_BROWSER_ARGS,
  WEBGPU_BROWSER_ARGS,
} from "../../../../playtest/dist/runner/index.js";
import { meanMeterBaselinePlugin } from "./mutations.js";

/**
 * PRD-571 AC-2. Builds the shipped histogram meter and the pre-change mean meter into two copies
 * of the exposure fixture, runs each at 1080p on the real adapter, and keeps the engine's own
 * `TN_FRAME_BUDGET` windows (GPU ms per resolved frame). Feed each log to
 * `playtest perf --file <log> --allow-virtual-display --text`; the arms alternate so a drifting
 * clock shows as a spread between rounds, not as a bias. `--enable-webgpu-developer-features`
 * turns off Dawn's timestamp quantization so a 0.1 ms difference is readable.
 */
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, "../../../../..");
// Playwright is a playtest dependency, not this package's.
interface IPage {
  evaluate<T>(run: () => Promise<T>): Promise<T>;
  goto(url: string): Promise<unknown>;
  on(event: "console", listener: (message: { text(): string }) => void): void;
  waitForTimeout(ms: number): Promise<void>;
}
interface IBrowser {
  close(): Promise<void>;
  newPage(options: { viewport: { height: number; width: number } }): Promise<IPage>;
}
const { chromium } = createRequire(join(root, "packages/playtest/package.json"))("playwright") as {
  chromium: { launch(options: { args: string[]; headless: boolean }): Promise<IBrowser> };
};
const out = join(root, "artifacts/prd571-cost");
await mkdir(out, { recursive: true });
const arms = [
  { name: "histogram", plugins: [] },
  { name: "mean", plugins: [meanMeterBaselinePlugin()] },
] as const;
const sites = new Map<string, string>();
for (const arm of arms) {
  const site = join(out, "sites", arm.name);
  await build({
    configFile: false,
    root: fixture,
    plugins: [...arm.plugins],
    build: { outDir: site, emptyOutDir: true },
  });
  sites.set(arm.name, site);
}
const rounds = Number(process.env.TN_COST_ROUNDS ?? 3);
const seconds = Number(process.env.TN_COST_SECONDS ?? 75);
for (let round = 0; round < rounds; round++) {
  for (const arm of arms) {
    const server = await preview({
      configFile: false,
      root: fixture,
      build: { outDir: sites.get(arm.name) as string },
      preview: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) throw new Error("Preview server has no URL.");
    const browser = await chromium.launch({
      headless: false,
      args: [
        ...WEBGPU_BROWSER_ARGS,
        ...PERFORMANCE_BROWSER_ARGS,
        "--enable-webgpu-developer-features",
      ],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const lines: string[] = [];
      page.on("console", (message) => {
        const text = message.text();
        if (text.startsWith("TN_FRAME_BUDGET")) lines.push(text);
      });
      await page.goto(`${url}?bright=1`);
      await page.waitForTimeout(seconds * 1000);
      const adapter = await page.evaluate(async () => {
        const info = (await navigator.gpu.requestAdapter())?.info;
        return info === undefined
          ? null
          : `${info.vendor}/${info.architecture}/${info.device}/${info.description}`;
      });
      const file = join(out, `${arm.name}-${round}.log`);
      await writeFile(file, `${lines.join("\n")}\n`);
      console.info(
        `${arm.name} round ${round}: ${lines.length} windows, adapter ${adapter}, ${file}`,
      );
    } finally {
      await browser.close();
      await server.close();
    }
  }
}
