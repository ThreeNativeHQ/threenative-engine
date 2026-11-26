/**
 * PRD-915: the shared Asset Library in a real browser. `?sheet=turntable` renders a labelled,
 * non-blank contact sheet and sets `__TN_ASSET_LIBRARY_READY__`; `?embed=1` hides the chrome and
 * answers a host's `postMessage`; the game page's `Game | Asset Library` switcher costs nothing
 * until it is picked and never appears under automation, in an iframe or with `?noDevShell=1`.
 */
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium } from "playwright";
import { type ViteDevServer, createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createAssetLibraryPlugin } from "../src/asset-library.js";

const STARTER = path.resolve("packages/create-threenative/templates/starter");

let server: ViteDevServer;
let browser: Browser;
let base = "";
let root = "";
const MODEL = `#/model/${encodeURIComponent("assets/props/crate.glb")}`;

beforeAll(async () => {
  root = await makeTempDir("tn-asset-library-browser-");
  await mkdir(path.join(root, "assets/props"), { recursive: true });
  await copyFile(
    path.join(STARTER, "assets/native-proof.glb"),
    path.join(root, "assets/props/crate.glb"),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "asset-library-browser", type: "module" }),
  );
  await writeFile(
    path.join(root, "index.html"),
    "<!doctype html><html><head></head><body><canvas></canvas></body></html>",
  );
  await writeFile(
    path.join(root, "host.html"),
    `<!doctype html><html><head></head><body><script>
window.got = [];
addEventListener("message", (e) => window.got.push(e.data));
</script><iframe id="library" src="/__assets/?embed=1" style="width:800px;height:600px"></iframe></body></html>`,
  );
  server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { port: 0, host: "127.0.0.1" },
    plugins: [createAssetLibraryPlugin()],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("dev server has no port");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  // A `beforeAll` directory is outside any test, so `makeTempDir` only removes it at process exit,
  // which a Vitest worker may never reach: the suite's temp guard then counts it as a leak.
  if (root) await rm(root, { recursive: true, force: true });
});

describe("asset library in a browser", () => {
  it("combines visual style, setting, category and search without duplicating results", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    try {
      await page.route("**/api/catalog", async (route) => {
        const response = await route.fetch();
        const catalog = await response.json();
        await route.fulfill({
          response,
          json: {
            ...catalog,
            styles: { ...catalog.styles, realistic: "Realistic", stylized: "Stylized" },
            settings: { medieval: "Medieval", modern: "Modern" },
            elements: [
              ...catalog.elements,
              {
                id: "oak-table",
                name: "Oak table",
                kind: "model",
                source: "project",
                styleTags: ["realistic"],
                settingTags: ["medieval", "modern"],
                category: "Dining",
              },
              {
                id: "pine-table",
                name: "Pine table",
                kind: "model",
                source: "project",
                styleTags: ["stylized"],
                settingTags: ["medieval"],
                category: "Dining",
              },
              {
                id: "oak-bed",
                name: "Oak bed",
                kind: "model",
                source: "project",
                styleTags: ["realistic"],
                settingTags: ["medieval"],
                category: "Beds",
              },
            ],
          },
        });
      });
      await page.goto(`${base}/__assets/`);
      await page.getByRole("button", { name: "Realistic", exact: true }).click();
      await page.getByRole("button", { name: "Filter assets", exact: true }).click();
      const setting = page.getByLabel("Setting filter");
      const category = page.getByLabel("Category filter");
      await setting.selectOption("medieval");
      await category.selectOption("Dining");
      const assets = page.getByRole("navigation", { name: "Assets" });
      expect(await assets.getByText("Oak table", { exact: true }).count()).toBe(1);
      expect(await assets.getByText(/Pine table|Oak bed|crate\.glb/u).count()).toBe(0);
      const search = page.getByRole("searchbox", { name: "Find assets" });
      await search.fill("medieval oak");
      expect(await assets.getByText("Oak table", { exact: true }).count()).toBe(1);
      await search.fill("pine");
      expect(await assets.getByText("No matching assets", { exact: true }).count()).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("renders a labelled, non-blank turntable sheet and then sets the READY flag", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(`${base}/__assets/?sheet=turntable${MODEL}`);
    await page.waitForFunction(
      () => Reflect.get(globalThis, "__TN_ASSET_LIBRARY_READY__") === true,
      undefined,
      {
        timeout: 60_000,
      },
    );
    const sheet = await page.evaluate(async () => {
      const url = Reflect.get(globalThis, "__TN_ASSET_LIBRARY_SHEET__") as string;
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, image.width, image.height);
      const colours = new Set<number>();
      for (let i = 0; i < data.length; i += 4 * 97)
        colours.add(((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0));
      return {
        width: image.width,
        height: image.height,
        colours: colours.size,
        shown: !!document.querySelector("#sheet-view"),
      };
    });
    expect(sheet.shown).toBe(true);
    expect(sheet.width).toBeGreaterThan(400);
    expect(sheet.colours).toBeGreaterThan(50);
    await page.close();
  }, 90_000);

  it("embeds without chrome and answers a host's select message", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/host.html`);
    const frame = page.frameLocator("#library");
    await expect.poll(() => frame.locator("html[data-embed]").count(), { timeout: 30_000 }).toBe(1);
    expect(await frame.locator("#sidebar").isVisible()).toBe(false);
    await page.evaluate((hash) => {
      (document.getElementById("library") as HTMLIFrameElement).contentWindow?.postMessage(
        { type: "tn-asset-library:select", hash },
        "*",
      );
    }, MODEL);
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (Reflect.get(window, "got") as { type: string; hash: string }[]).map(
              (m) => `${m.type} ${m.hash}`,
            ),
          ),
        { timeout: 60_000 },
      )
      .toContain(`tn-asset-library:ready ${MODEL}`);
    await page.close();
  }, 90_000);

  it("loads nothing for the Dev Dashboard until its tab is picked", async () => {
    const context = await browser.newContext();
    // A person's browser: the switcher stands down under automation, so this case lifts the flag.
    await context.addInitScript(() =>
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }),
    );
    const page = await context.newPage();
    const library: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/__assets/") || url.includes("/__dashboard/")) library.push(url);
    });
    await page.goto(`${base}/`);
    await page.waitForSelector("#tn-dev-shell");
    await page.waitForTimeout(1000);
    expect(library).toEqual([]);
    expect(await page.locator("iframe").count()).toBe(0);
    // Collapsed to a DEV pill in a corner until pointed at, so it stays out of the game's view.
    expect(await page.locator('#tn-dev-shell [data-view="dashboard"]').isVisible()).toBe(false);
    // The passive TN_* ring (PRD-923): one entry per kept marker, nothing for other lines, capped.
    const ring = await page.evaluate(() => {
      const kept = () => (window as unknown as { __tnDevMarkers: unknown[] }).__tnDevMarkers.length;
      for (let i = 0; i < 700; i += 1) console.debug(`TN_HOT_CALL:${i}`);
      const total = kept();
      (window as unknown as { __tnDevMarkers: unknown[] }).__tnDevMarkers.length = 0;
      console.debug("TN_SCENE_WARNING:test");
      console.log("plain line");
      console.debug("TN_UNLISTED_MARKER");
      return { one: kept(), total };
    });
    expect(ring).toEqual({ one: 1, total: 600 });
    const pill = await page.locator("#tn-dev-shell").boundingBox();
    expect(pill && pill.y > 600 && pill.x > 1000).toBe(true);
    await page.hover("#tn-dev-shell");
    await page.click('#tn-dev-shell [data-view="dashboard"]');
    await expect.poll(() => library.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(await page.locator("#tn-dev-dashboard-frame").isVisible()).toBe(true);
    // The side menu opens Performance & Health, which shows the markers the game page kept.
    const frame = page.frameLocator("#tn-dev-dashboard-frame");
    // The rail marks its first section once the Dashboard script has wired it.
    await frame.locator('#rail [aria-current="page"]').waitFor({ timeout: 30_000 });
    await frame.locator('#rail [data-section="performance"]').click();
    await frame.locator("text=TN_SCENE_WARNING").first().waitFor({ timeout: 30_000 });
    await frame.locator('#rail [data-section="settings"]').click();
    await frame.locator("#settings-tab-config").waitFor({ timeout: 30_000 });
    await page.click('#tn-dev-shell [data-view="game"]');
    expect(await page.locator("#tn-dev-dashboard-frame").isVisible()).toBe(false);
    await page.mouse.move(0, 0);
    expect(await page.locator('#tn-dev-shell [data-view="game"]').isVisible()).toBe(false);
    await context.close();
  }, 60_000);

  it("never shows the switcher under automation or with ?noDevShell=1", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    await page.waitForLoadState("load");
    expect(await page.locator("#tn-dev-shell").count()).toBe(0);
    const context = await browser.newContext();
    await context.addInitScript(() =>
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }),
    );
    const person = await context.newPage();
    await person.goto(`${base}/?noDevShell=1`);
    await person.waitForLoadState("load");
    expect(await person.locator("#tn-dev-shell").count()).toBe(0);
    await page.close();
    await context.close();
  }, 60_000);
});
