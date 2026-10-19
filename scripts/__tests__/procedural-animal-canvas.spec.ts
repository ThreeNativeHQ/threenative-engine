import { readFileSync } from "node:fs";
import { type Browser, chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Inert authored HTML only: no game modules, GPU contexts, captures or renderer.
describe("procedural animal canvas layout", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu", "--disable-software-rasterizer"],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  it.each(["index.html", "crowd.html", "high.html", "baseline.html"])(
    "%s retains its CSS viewport when the drawing buffer shrinks",
    async (name) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      try {
        const html = readFileSync(
          new URL(`../../examples/procedural-animals/${name}`, import.meta.url),
          "utf8",
        ).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
        await page.setContent(html);
        await page.evaluate(() => document.body.append(document.createElement("canvas")));
        for (const viewport of [
          { width: 1280, height: 720 },
          { width: 1024, height: 768 },
        ]) {
          await page.setViewportSize(viewport);
          for (const size of [
            { width: 1280, height: 720 },
            { width: 640, height: 360 },
            { width: 3, height: 3 },
          ]) {
            const measured = await page.evaluate((buffer) => {
              const canvas = document.querySelector("canvas");
              if (!canvas) throw new Error("Canvas missing from layout fixture");
              canvas.width = buffer.width;
              canvas.height = buffer.height;
              const rect = canvas.getBoundingClientRect();
              return {
                width: rect.width,
                height: rect.height,
                drawingWidth: canvas.width,
                drawingHeight: canvas.height,
              };
            }, size);
            expect(measured).toEqual({
              ...viewport,
              drawingWidth: size.width,
              drawingHeight: size.height,
            });
          }
        }
      } finally {
        await page.close();
      }
    },
  );
});
