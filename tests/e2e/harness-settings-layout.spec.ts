import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const toolchain = JSON.parse(readFileSync(resolve(root, "harness/toolchain-lock.json"), "utf8")) as {
  desktopPatches: Array<{
    id: string;
    operation?: string;
    replacements?: Array<{ before: string; after: string }>;
  }>;
};

const settingsPatch = toolchain.desktopPatches.find(patch => patch.id === "settings-scroll-container");
if (!settingsPatch?.replacements) throw new Error("settings layout replacements are missing from the toolchain lock");
const settingsCss = [
  ".settings-overlay{justify-content:center;align-items:center;display:flex;position:fixed;inset:0}",
  ".settings-panel{width:800px;max-width:calc(100vw - 48px);height:min(800px,calc(100vh - 48px));display:flex;overflow:hidden}",
  ".settings-nav{flex:none;width:188px}",
  ".settings-header{box-sizing:border-box;flex:none;height:54px}",
  ...settingsPatch.replacements.map(replacement => `.fixture${replacement.after}`)
].join("");

const className = (localName: string): string => {
  const match = settingsCss.match(new RegExp(`\\.([A-Za-z0-9_-]+_${localName})\\{`, "u"));
  if (!match?.[1]) throw new Error(`settings CSS class is missing: ${localName}`);
  return match[1];
};

test("long Harness settings forms remain scrollable to their final action on Windows-sized viewports", async ({ page }) => {
  expect(settingsPatch.operation).toBe("replace-text");
  expect(settingsPatch.replacements).toHaveLength(2);

  await page.setViewportSize({ width: 1000, height: 700 });
  await page.setContent(`
    <style>
      ${settingsCss}
      body { margin: 0; }
      .regression-form { height: 1400px; }
    </style>
    <div class="settings-overlay">
      <div class="settings-panel">
        <nav class="settings-nav"></nav>
        <main class="${className("content")}">
          <header class="settings-header"></header>
          <section class="${className("options")}" data-testid="settings-scroll-region">
            <div class="regression-form"></div>
            <button type="button" data-testid="last-action">保存</button>
          </section>
        </main>
      </div>
    </div>
  `);

  const content = page.locator(`.${className("content")}`);
  const scrollRegion = page.getByTestId("settings-scroll-region");
  await expect(content).toHaveCSS("min-height", "0px");
  await expect(content).toHaveCSS("overflow", "hidden");
  await expect(scrollRegion).toHaveCSS("height", /\d+(?:\.\d+)?px/u);

  const dimensions = await scrollRegion.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(dimensions.clientHeight).toBeGreaterThan(0);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  await scrollRegion.hover();
  await page.mouse.wheel(0, dimensions.scrollHeight);
  await expect.poll(() => scrollRegion.evaluate(element => element.scrollTop)).toBe(
    dimensions.scrollHeight - dimensions.clientHeight
  );

  const bottomIsVisible = await page.getByTestId("last-action").evaluate(element => {
    const action = element.getBoundingClientRect();
    const scroller = element.parentElement?.getBoundingClientRect();
    return scroller !== undefined && action.top >= scroller.top && action.bottom <= scroller.bottom;
  });
  expect(bottomIsVisible).toBe(true);
});
