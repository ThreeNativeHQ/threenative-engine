import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { chromium } from "@playwright/test";
import { here } from "./shared.mjs";

const webDir = join(here, "out-parity", "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".png": "image/png" };
const server = createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
  const file = join(webDir, path === "/" ? "parity.html" : path);
  try { response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); response.end(readFileSync(file)); }
  catch { response.writeHead(404).end("nope"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.goto(`${base}/parity.html?panel=26`);
await page.evaluate(async () => { await document.fonts.ready; });
const read = () => page.evaluate(() =>
  [...document.querySelectorAll(".probe")].map((el) => {
    const cs = getComputedStyle(el);
    return [el.className.split(" ").slice(1).join(" "), cs.maskImage.slice(0, 60), cs.maskComposite];
  }),
);
for (const [cls, mask, comp] of await read()) console.log(String(cls).padEnd(26), "|", mask.padEnd(60), "|", comp);
await browser.close();
await new Promise((r) => server.close(r));
