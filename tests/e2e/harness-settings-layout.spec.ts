import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const settingsClient = readFileSync(resolve(
  root,
  "target/generated/harness/prepared/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js"
), "utf8");
// Exercise the stylesheet shipped in the prepared Harness, including upstream
// layout changes. No Desktop patch or hand-written replacement supplies CSS.
const stylesheet = settingsClient.match(
  /const css(?:\$\d+)? = ("(?:[^"\\]|\\.)*");\s*const tagId(?:\$\d+)? = "@deepseek-ai\/dsh-client-ui-settings-general\/SettingsRoot\.module\.css"/u
)?.[1];
if (!stylesheet) throw new Error("prepared Harness SettingsRoot stylesheet is missing");
const settingsCss = JSON.parse(stylesheet) as string;

const className = (localName: string): string => {
  const match = settingsCss.match(new RegExp(`\\.([A-Za-z0-9_-]+_${localName})\\{`, "u"));
  if (!match?.[1]) throw new Error(`settings CSS class is missing: ${localName}`);
  return match[1];
};

test("prepared Harness settings forms scroll to their final action", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.setContent(`
    <style>
      ${settingsCss}
      body { margin: 0; }
      .regression-form { height: 1400px; }
    </style>
    <div class="${className("overlay")}">
      <div class="${className("panel")}">
        <nav class="${className("nav")}"></nav>
        <main class="${className("content")}">
          <header class="${className("header")}"></header>
          <section class="${className("options")}" data-testid="settings-scroll-region">
            <div class="regression-form"></div>
            <button type="button" data-testid="last-action">保存</button>
          </section>
        </main>
      </div>
    </div>
  `);

  const scrollRegion = page.getByTestId("settings-scroll-region");

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
