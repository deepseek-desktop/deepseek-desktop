import { chromium, webkit, expect } from "@playwright/test";
import { join } from "node:path";

export async function verifySearchSettings(url, cookies, outputDirectory, seededProvider) {
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
      const dialog = page.getByRole("dialog", { name: /^(设置|設定|Settings)$/u });
      await expect(dialog).toBeVisible();
      return dialog;
    }
    async function openSearchSettings() {
      const dialog = await openSettings();
      await dialog.getByText(/^(插件|Plugins)$/u, { exact: true }).click();
      await dialog.getByText(/^(插件配置|Plugin configuration)$/u, { exact: true }).click();
      await expandSearchSettings();
      return dialog;
    }
    try {
      const settingsDialog = await openSettings();
      await settingsDialog.getByText(/^(插件|Plugins)$/u, { exact: true }).click();
      await settingsDialog.getByText(/^(插件列表|Plugin list)$/u, { exact: true }).click();
      const search = settingsDialog.getByPlaceholder(/^(搜索插件|Search plugins)$/u);
      await expect(search).toBeVisible();
      for (const name of ["@deepseek-ai/dsh-web-search-follow-model", "deepseek-desktop-credentials-vault"]) {
        await search.fill(name);
        const entry = page.locator(`[data-plugin-module="${name}"]`).first();
        await expect(entry).toBeVisible();
        await expect(entry.getByRole("button", { name: /(?:已启用|已啟用|Enabled)$/u })).toBeVisible();
      }
      await page.screenshot({ path: join(outputDirectory, "official-plugin-list.png") });
      await settingsDialog.getByRole("button", { name: /^(关闭|Close)$/u }).click();
      await expect(settingsDialog).toBeHidden();
      await openSearchSettings();
      const card = page.locator(".desktop-search-card");
      await expect(card).toHaveCount(1);
      const expectActive = () => expect(card.getByRole("status")).toHaveText(/^(已生效|Active)$/u, { timeout: 10_000 });
      await expectActive();
      const mode = card.locator("#plugin-config-web-search-mode");
      await expect(mode).toHaveValue("follow-model");
      // Routing is the card's only control: the mode names the search source outright, so
      // there is no free-text Provider id and no separate upstream-plugin toggle to keep
      // in sync with it.
      await expect(card.locator("select")).toHaveCount(1);
      await expect(card.locator("input")).toHaveCount(0);
      await expect(card.locator("#plugin-config-web-search-hint")).toHaveCount(0);
      await mode.selectOption("web-search");
      await expect(card.locator("#plugin-config-web-search-hint")).toBeVisible();
      await card.getByRole("button", { name: /^(保存|儲存|Save)$/u }).click();
      await expect(card.locator("button[type=submit]")).toBeDisabled();
      await expect(card.locator("summary")).not.toContainText(/未保存|未儲存|Unsaved/u);
      // Selecting web search has to bring the upstream plugin into the profile; if it did
      // not, activation reports failure here instead of claiming to be active.
      await expectActive();
      await page.reload();
      await openSearchSettings();
      await expect(mode).toHaveValue("web-search");
      await expectActive();
      await mode.selectOption("disabled");
      await card.getByRole("button", { name: /^(保存|儲存|Save)$/u }).click();
      await expect(card.locator("button[type=submit]")).toBeDisabled();
      await expect(card.locator("summary")).not.toContainText(/未保存|未儲存|Unsaved/u);
      await expectActive();
      await page.reload();
      await openSearchSettings();
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

      if (seededProvider !== undefined) {
        await page.setViewportSize({ width: 1120, height: 720 });
        // A reload drops back to the chat surface; while the dialog is open just switch tabs.
        const openModels = async () => {
          const dialog = page.getByRole("dialog", { name: /^(设置|設定|Settings)$/u });
          if (!await dialog.isVisible()) await openSettings();
          await dialog.getByText(/^(模型|Models)$/u).click();
        };
        await openModels();
        // The row's edit control carries an aria-label naming the provider, which is also the
        // only stable way to single out that provider's card among the hashed class names.
        const editButton = page.getByRole("button", { name: new RegExp(`(编辑|編輯|Edit)\\s+${seededProvider}$`, "u") });
        const card = page.locator("li").filter({ has: editButton });
        const timeout = page.locator(`#provider-stream-idle-timeout-${seededProvider}`);
        const submit = () => card.getByRole("button", { name: /^(保存|儲存|Apply)$/u });
        const openEditor = async () => {
          await editButton.click();
          // API protocol and the model catalog live behind this disclosure in the edit form,
          // and the timeout field sits with them.
          const customized = card.locator("details").first();
          if (!await customized.evaluate(element => element.open)) await customized.locator("summary").click();
          await expect(timeout).toBeVisible();
        };

        await openEditor();
        // One field, inside the provider's own form rather than a card of its own.
        await expect(timeout).toHaveCount(1);
        // The resolved profile materializes the upstream default, so an untouched provider
        // shows the official value without the patch hard-coding it.
        await expect(timeout).toHaveValue("300000");

        // An unusable value blocks the form instead of quietly dropping the override.
        await timeout.fill("0");
        await expect(submit()).toBeDisabled();

        await timeout.fill("1800000");
        await expect(submit()).toBeEnabled();
        await submit().click();
        await page.reload();
        await openModels();
        await openEditor();
        await expect(timeout).toHaveValue("1800000");
        await page.screenshot({ path: join(outputDirectory, "provider-stream-idle-timeout.png") });

        // Clearing the field removes the override and returns the provider to the upstream
        // default. Read it back after a reload: like every other curated field, the section
        // mirror still holds the previous resolved value until it refreshes.
        await timeout.fill("");
        await submit().click();
        await page.reload();
        await openModels();
        await openEditor();
        await expect(timeout).toHaveValue("300000");

        // The create form carries the same field, so a new provider can set it up front.
        await card.getByRole("button", { name: /^(取消|Cancel)$/u }).click();
        await page.getByRole("button", { name: /(自定义提供方|自訂提供方|custom provider)/u }).click();
        await expect(page.locator("#provider-stream-idle-timeout-new")).toBeVisible();
        console.log("Provider stream idle timeout: upstream default shown, invalid value blocks submit, saved with the form, survives reload, cleared back to default, present when creating");
      }
      expect(errors).toEqual([]);
      console.log("Harness plugin inventory and search settings: active Desktop plugins, follow-model default, durable save/reset and small-window layout passed");
    } catch (error) {
      await page.screenshot({ path: join(outputDirectory, "search-settings-failure.png") });
      throw new Error(`${error.message}\nSearch activation responses: ${JSON.stringify(activationResponses)}`);
    }
  } finally {
    await browser.close();
  }
  if (process.platform === "darwin" && seededProvider !== undefined) {
    const browser = await webkit.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addCookies([...cookies].map(([name, value]) => ({ name, value, url: url.origin })));
      const page = await context.newPage();
      await page.goto(url.href);
      for (const name of [/^(继续|Continue)$/u, /^(稍后配置|Configure later)$/u]) {
        const button = page.getByRole("button", { name });
        await button.waitFor({ state: "visible", timeout: 3000 }).catch(error => {
          if (error.name !== "TimeoutError") throw error;
        });
        if (await button.isVisible()) await button.click();
      }
      await page.getByRole("button", { name: /^(新建会话|New session)$/u }).first().click();
      await page.getByRole("button", { name: /^(选择工作区|Choose workspace)$/u }).click();
      const picker = page.getByRole("dialog", { name: /^(选择工作区目录|Select Workspace Directory)$/u });
      await picker.getByRole("button", { name: /^(编辑路径|Edit path)$/u }).click();
      const path = picker.getByRole("textbox", { name: /^(编辑路径|Edit path)$/u });
      await path.fill(outputDirectory);
      await path.press("Enter");
      await picker.getByRole("button", { name: /^(打开|Open)$/u, exact: true }).click();
      await expect(picker).toBeHidden();
      const trigger = page.getByRole("button", { name: /^(选择模型|Select model)/u });
      // Focus starts in the composer, as it does before a real user clicks the menu.
      await page.locator('[contenteditable="true"][role="textbox"]').first().focus();
      await trigger.click();
      const menu = page.getByRole("menu", { name: /^(模型与推理等级|Model and reasoning effort)$/u });
      await menu.getByRole("menuitem", { name: /^(模型|Model)/u }).click();
      await menu.getByRole("menuitemradio", { name: "smoke-model", exact: true }).click();
      await expect(menu).toBeHidden();
      await expect(trigger).toContainText("smoke-model");
      await page.locator('[contenteditable="true"][role="textbox"]').first().focus();
      await trigger.click();
      await menu.getByRole("menuitem", { name: /^(推理等级|Effort)/u }).click();
      await menu.getByRole("menuitemradio", { name: "Low", exact: true }).click();
      await expect(menu).toBeHidden();
      await expect(trigger).toContainText("Low");
      await page.screenshot({ path: join(outputDirectory, "webkit-model-selection.png") });
      console.log("WebKit model menu: model and reasoning selection succeed from focused composer");
    } finally {
      await browser.close();
    }
  }
}
