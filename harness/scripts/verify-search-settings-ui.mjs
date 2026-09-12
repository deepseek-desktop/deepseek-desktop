import { chromium, expect } from "@playwright/test";
import { join } from "node:path";

export async function verifySearchSettings(url, cookies, outputDirectory) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1120, height: 720 } });
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, url: url.origin })));
    const statusUrl = new URL("/api/desktop.web-search", url).href;
    const request = { headers: { origin: url.origin } };
    const unauthenticated = await browser.newContext();
    try {
      expect((await unauthenticated.request.get(statusUrl, request)).status()).toBe(401);
      expect((await context.request.get(statusUrl, { headers: { origin: "https://untrusted.test" } })).status()).toBe(403);
    } finally { await unauthenticated.close(); }
    const page = await context.newPage();
    const errors = [];
    const activationResponses = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
      if (new URL(response.url()).pathname !== "/api/desktop.web-search") return;
      const result = await response.json().catch(() => ({}));
      activationResponses.push({ status: response.status(), phase: result.phase, error: result.error });
    });
    await page.goto(url.href);
    const pluginBoot = await page.evaluate(() => ({
      mode: window.__ModuleLoader__?.mode,
      entry: window.__DSH_BOOT__?.entries?.find(entry => entry.id === "@deepseek-ai/dsh-web-search-follow-model"),
    }));
    expect(pluginBoot.entry?.external).toContain("react");
    expect(pluginBoot.entry?.inject).toContain("@deepseek-ai/dsh-client-ui-settings-plugins");
    await expect.poll(() => page.evaluate(() => window.__ModuleLoader__?.mode)).toBe("live");
    async function expandSearchSettings() {
      const details = page.locator(".desktop-search-card details");
      if (!await details.evaluate(element => element.open)) await details.locator("summary").click();
      await expect(details).toHaveJSProperty("open", true);
    }
    async function openSettings() {
      const onboarding = page.getByRole("button", { name: /^(继续|繼續|Continue)$/u });
      await onboarding.waitFor({ state: "visible", timeout: 5000 }).catch(error => {
        if (error.name !== "TimeoutError") throw error;
      });
      if (await onboarding.isVisible()) {
        await onboarding.click();
      }
      const later = page.getByRole("button", { name: /^(稍后配置|稍後設定|Configure later)$/u });
      await later.waitFor({ state: "visible", timeout: 5000 }).catch(error => {
        if (error.name !== "TimeoutError") throw error;
      });
      if (await later.isVisible()) await later.click();
      await page.getByText(/^(设置|設定|Settings)$/u).first().click();
      await page.getByText(/^(插件|外掛|Plugins)$/u).first().click();
      await expandSearchSettings();
    }
    try {
      await openSettings();
      await page.getByText(/^(插件列表|Plugin list)$/u).click();
      const search = page.getByPlaceholder(/^(搜索插件|Search plugins)$/u);
      await expect(search).toBeVisible();
      for (const name of ["@deepseek-ai/dsh-web-search-follow-model", "deepseek-desktop-credentials-vault"]) {
        await search.fill(name);
        const entry = page.locator(`[data-plugin-module="${name}"]`).first();
        await expect(entry).toBeVisible();
        await expect(entry.getByRole("img", { name: /^(运行中|Running)$/u })).toBeVisible();
      }
      await page.screenshot({ path: join(outputDirectory, "official-plugin-list.png") });
      await page.getByText(/^(插件配置|Plugin configuration)$/u).click();
      await expandSearchSettings();
      const card = page.locator(".desktop-search-card");
      await expect(card).toHaveCount(1);
      const expectActive = () => expect(card.getByRole("status")).toHaveText(/^(已生效|Active)$/u, { timeout: 10_000 });
      await expectActive();
      const mode = card.locator("select");
      await expect(mode).toHaveValue("follow-model");
      await expect(card.locator("input")).toHaveCount(0);
      await mode.selectOption("independent");
      const provider = card.locator("#plugin-config-web-search-provider");
      await expect(provider).toBeVisible();
      await expect(provider).toHaveValue("deepseek-official");
      await provider.fill("fixture-independent");
      await card.getByRole("button", { name: /^(保存|儲存|Save)$/u }).click();
      await expect(card.locator("button[type=submit]")).toBeDisabled();
      await expect(card.locator("summary")).not.toContainText(/未保存|未儲存|Unsaved/u);
      await expectActive();
      await page.reload();
      await openSettings();
      await expect(mode).toHaveValue("independent");
      await expect(provider).toHaveValue("fixture-independent");
      await expectActive();
      await mode.selectOption("disabled");
      await card.getByRole("button", { name: /^(保存|儲存|Save)$/u }).click();
      await expect(card.locator("button[type=submit]")).toBeDisabled();
      await expect(card.locator("summary")).not.toContainText(/未保存|未儲存|Unsaved/u);
      await expectActive();
      await page.reload();
      await openSettings();
      await expect(mode).toHaveValue("disabled");
      await card.getByRole("button", { name: /^(恢复默认|恢復預設|Restore defaults)$/u }).click();
      await expect(mode).toHaveValue("follow-model");
      await card.getByRole("button", { name: /^(保存|儲存|Save)$/u }).click();
      await expect(card.locator("button[type=submit]")).toBeDisabled();
      await expectActive();
      await page.setViewportSize({ width: 760, height: 560 });
      await card.locator("button[type=submit]").scrollIntoViewIfNeeded();
      await expect(card.locator("button[type=submit]")).toBeInViewport();
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: join(outputDirectory, "search-settings.png") });
      expect(errors).toEqual([]);
      console.log("Harness plugin inventory and search settings: active Desktop plugins, follow-model default, durable save/reset and small-window layout passed");
    } catch (error) {
      await page.screenshot({ path: join(outputDirectory, "search-settings-failure.png") });
      throw new Error(`${error.message}\nSearch activation responses: ${JSON.stringify(activationResponses)}`);
    }
  } finally {
    await browser.close();
  }
}
