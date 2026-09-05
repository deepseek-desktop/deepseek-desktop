import { chromium, expect } from "@playwright/test";
import { join } from "node:path";

export async function verifySearchSettings(url, cookies, outputDirectory) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1120, height: 720 } });
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, url: url.origin })));
    const statusUrl = new URL("/desktop-web-search/status", url).href;
    const request = { headers: { origin: url.origin }, data: { type: "client-request", rpcId: "search-auth-smoke", method: "status", payload: {} } };
    const unauthenticated = await browser.newContext();
    try {
      expect((await unauthenticated.request.post(statusUrl, request)).status()).toBe(401);
      expect((await context.request.post(statusUrl, { ...request, headers: { origin: "https://untrusted.test" } })).status()).toBe(403);
    } finally { await unauthenticated.close(); }
    const page = await context.newPage();
    const errors = [];
    const activationResponses = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
      if (!new URL(response.url()).pathname.startsWith("/desktop-web-search/")) return;
      const result = (await response.json().catch(() => ({}))).result;
      activationResponses.push({ status: response.status(), ok: result?.ok, phase: result?.value?.phase, error: result?.error?.code });
    });
    await page.goto(url.href);
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
      await page.locator(".desktop-search-card summary").click();
    }
    try {
      await openSettings();
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
      console.log("Harness search settings: independent client, follow-model default, durable save/reset and small-window layout passed");
    } catch (error) {
      await page.screenshot({ path: join(outputDirectory, "search-settings-failure.png") });
      throw new Error(`${error.message}\nSearch activation responses: ${JSON.stringify(activationResponses)}`);
    }
  } finally {
    await browser.close();
  }
}
