import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser } from "playwright";
import { sampleHudAudit } from "../src/runner/sampling.js";

describe("HUD audit backing colour", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  // The kart HUD: orange text on a 60% dark plate over a sky-blue page. The plate is the nearer
  // layer, so the player sees it over the page; judged the other way round the page colour hid
  // every plate and the audit failed text the plate had made readable.
  test("composites a parent's background under the child's plate, not over it", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await page.setContent(
        `<body style="margin:0;background:rgb(100,160,240)"><div style="background:rgba(0,0,0,0.6)">` +
          `<span style="color:rgb(255,180,90)">8</span></div></body>`,
      );
      const { items } = await sampleHudAudit(page);
      const eight = items.find(({ text }) => text === "8");
      expect(eight).toBeDefined();
      const [r, g, b, a] = eight!.background;
      expect(a).toBeCloseTo(1, 5);
      expect(r).toBeCloseTo(40, 0);
      expect(g).toBeCloseTo(64, 0);
      expect(b).toBeCloseTo(96, 0);
    } finally {
      await page.close();
    }
  });
});
