import { expect, test } from "@playwright/test";

const releaseNotes = [
  "# DeepSeek Desktop 社区版", "", "这是内置 **Harness** 的桌面发行版。", "",
  "## 直接下载 / Direct downloads", "",
  "| 平台 | 安装包 |", "| --- | --- |", "| macOS | [DMG](https://example.com/app.dmg) |",
  "| Windows | EXE |", "| Linux | AppImage / DEB |", "",
  "## 更新内容", "", "- 修复更新摘要渲染", "- 保留 **会话状态** 和 `Harness` 配置", "",
  "> 安装前请确认来源。", "", "```text", `checksum ${"a".repeat(160)}`, "```", "",
  ...Array.from({ length: 15 }, (_, i) => `${i + 1}. 更新说明 ${i + 1}：完整显示长内容。`), "",
  "[完整说明](https://example.com/notes)", "",
  '<img src="https://tracker.example/pixel" onerror="window.injected=true">', "",
  "![tracking](https://tracker.example/image.png)", "", "摘要结束"
].join("\n");

const feedNotes = `<div class="markdown-body"><h1>DeepSeek Desktop 社区版</h1>
  <p>这是内置 <strong>Harness</strong> 的桌面发行版。</p>
  <h2>直接下载 / Direct downloads</h2>
  <table><thead><tr><th>平台</th><th>安装包</th></tr></thead><tbody>
  <tr><td>macOS</td><td><a href="https://example.com/app.dmg">DMG</a></td></tr></tbody></table>
  <h2>更新内容</h2><ul>${Array.from({ length: 40 }, (_, i) => `<li>更新说明 ${i + 1}</li>`).join("")}</ul>
  <a href="https://example.com/notes">完整说明</a>
  <img src="https://tracker.example/pixel" onerror="window.injected=true">
  <iframe src="https://tracker.example/frame"></iframe><script>window.injected=true</script>
  <p>摘要结束</p></div>`;

for (const variant of [
  { name: "desktop", viewport: { width: 1280, height: 900 }, colorScheme: "light" as const, format: "markdown" },
  { name: "small-dark", viewport: { width: 760, height: 560 }, colorScheme: "dark" as const, format: "markdown" },
  { name: "atom-small", viewport: { width: 760, height: 560 }, colorScheme: "light" as const, format: "html" }
]) {
  test(`release notes render and scroll in the ${variant.name} popup`, async ({ page }, testInfo) => {
    await page.setViewportSize(variant.viewport);
    await page.emulateMedia({ colorScheme: variant.colorScheme });
    const opened: string[] = [];
    const remoteRequests: string[] = [];
    page.on("request", request => { if (request.url().includes("tracker.example")) remoteRequests.push(request.url()); });
    await page.exposeFunction("openUpdateLink", (url: string) => { opened.push(url); });
    await page.addInitScript(({ notes, format }) => {
      const settings = {
        schemaVersion: 7, locale: "zh-CN", onboardingCompleted: true,
        updateChannel: "community", updateEnabled: false, harnessUpdateChannel: "stable",
        harnessUpdateMode: "notify", harnessUpdateRepository: null, harnessPinnedVersion: null,
        desktopUpdateLastCheckAt: null, desktopUpdateIgnoredVersion: null, recoveryReason: null
      };
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          invoke: async (command: string, args?: { url: string }) => {
            switch (command) {
              case "settings_get": return settings;
              case "harness_status": return { phase: "ready", url: null, restartCount: 0, diagnosticId: null, errorCode: null };
              case "desktop_about": return {
                desktopVersion: "1.0.0", harnessVersion: "1.0.0", harnessCommit: "a".repeat(40),
                nodeVersion: "24.20.0", authors: "Community", repository: "https://github.com/example/desktop",
                channel: "community", signedRelease: false
              };
              case "harness_update_status": return {
                enabled: true, phase: "idle", currentVersion: "1.0.0", currentCommit: "a".repeat(40),
                currentSource: "bundled", availableVersion: null, pendingVersion: null,
                channel: "stable", mode: "notify", pinnedVersion: null, downloadedBytes: 0, totalBytes: null, message: "idle"
              };
              case "update_check": return {
                enabled: false, channel: "community", currentVersion: "1.0.0", availableVersion: "1.1.0",
                releaseTag: "v1.1.0", publishedAt: "2026-09-04T07:30:00Z", releaseNotes: notes,
                releaseNotesFormat: format,
                prerelease: true, message: "update-available"
              };
              case "desktop_update_open_link":
                return (window as unknown as { openUpdateLink: (url: string) => Promise<void> }).openUpdateLink(args!.url);
              case "plugin:event|listen": return 1;
              case "harness_open": return;
              default: throw new Error(`Unexpected mock command: ${command}`);
            }
          }
        }
      });
    }, { notes: variant.format === "html" ? feedNotes : releaseNotes, format: variant.format });
    await page.goto("/");
    const dialog = page.getByRole("alertdialog");
    const notes = dialog.getByRole("region", { name: "更新摘要" });
    await expect(notes.getByRole("heading", { name: "DeepSeek Desktop 社区版" })).toBeVisible();
    await expect(notes.locator("strong").first()).toHaveText("Harness");
    await expect(notes.getByRole("table")).toHaveCount(1);
    await expect(notes.locator("img,script,iframe")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("release-notes.png") });

    await notes.getByRole("link", { name: "DMG" }).click();
    await expect.poll(() => opened).toEqual(["https://example.com/app.dmg"]);
    const details = notes.getByRole("link", { name: "完整说明" });
    await details.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => opened).toEqual(["https://example.com/app.dmg", "https://example.com/notes"]);
    await notes.evaluate(element => element.scrollTo({ top: element.scrollHeight }));
    await expect(notes.getByText("摘要结束", { exact: true })).toBeInViewport();
    expect(await notes.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await notes.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const later = dialog.getByRole("button", { name: "稍后提醒" });
    await later.scrollIntoViewIfNeeded();
    await expect(later).toBeInViewport();
    await later.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("menubar")).toBeVisible();
    expect(remoteRequests).toEqual([]);
    expect(page.url()).toMatch(/:\d+\/$/u);
  });
}
