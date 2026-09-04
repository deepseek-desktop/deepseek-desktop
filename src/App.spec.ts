import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import { appConfig } from "./app-config";
import type { DesktopSettings, HarnessStatus, HarnessUpdateStatus } from "./contracts";
import { checkForUpdates, checkHarnessUpdate, downloadHarnessUpdate, exportDiagnostics, exportLogs, ignoreDesktopUpdate, openDesktopMenu, openDesktopRelease, openRepository, openWorkbench, saveSettings, startHarness } from "./desktop";
import { i18n } from "./i18n";

const settings: DesktopSettings = {
  schemaVersion: 7,
  locale: "zh-CN",
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false,
  harnessUpdateChannel: "stable",
  harnessUpdateMode: "automatic",
  harnessUpdateRepository: null,
  harnessPinnedVersion: null,
  desktopUpdateLastCheckAt: null,
  desktopUpdateIgnoredVersion: null,
  recoveryReason: null
};
const harness: HarnessStatus = {
  phase: "idle",
  url: null,
  restartCount: 0,
  diagnosticId: null,
  errorCode: null
};

const listeners = vi.hoisted(() => ({
  harnessUpdate: undefined as ((status: HarnessUpdateStatus) => void) | undefined,
  locale: undefined as ((locale: "zh-CN" | "zh-TW" | "en-US") => void) | undefined,
  settingsView: undefined as ((view: "harness" | "diagnostics" | "update" | "desktop-update" | "about") => void) | undefined,
  surface: undefined as ((surface: "settings" | "workbench") => void) | undefined
}));

vi.mock("./desktop", () => ({
  checkForUpdates: vi.fn(async () => ({
    enabled: false, channel: "community", currentVersion: "1.0.0", availableVersion: null,
    releaseTag: null, publishedAt: null, releaseNotes: null, prerelease: false, message: "up-to-date"
  })),
  checkHarnessUpdate: vi.fn(async () => ({
    enabled: true, phase: "available", currentVersion: "1.0.0", currentCommit: "a".repeat(40), currentSource: "bundled",
    availableVersion: "1.1.0", pendingVersion: null, channel: "stable", mode: "automatic", pinnedVersion: null,
    downloadedBytes: 0, totalBytes: 1024, message: "available"
  })),
  exportDiagnostics: vi.fn(async () => ""),
  exportLogs: vi.fn(async () => ""),
  getAbout: vi.fn(async () => ({
    desktopVersion: appConfig.version,
    harnessVersion: "0.1.2-alpha.1",
    harnessCommit: "cd5ef8148158c3a752a658978873241fdf8e2bbc",
    nodeVersion: "24.20.0",
    authors: appConfig.authors.join(", "),
    repository: appConfig.repository,
    channel: "community",
    signedRelease: false
  })),
  getHarnessStatus: vi.fn(async () => ({ ...harness })),
  getHarnessUpdateStatus: vi.fn(async () => ({
    enabled: true, phase: "idle", currentVersion: "1.0.0", currentCommit: "a".repeat(40), currentSource: "bundled",
    availableVersion: null, pendingVersion: null, channel: "stable", mode: "automatic", pinnedVersion: null,
    downloadedBytes: 0, totalBytes: null, message: "idle"
  })),
  getSettings: vi.fn(async () => ({ ...settings })),
  onHarnessStatus: vi.fn(async () => () => undefined),
  onHarnessUpdateStatus: vi.fn(async (handler) => {
    listeners.harnessUpdate = handler;
    return () => undefined;
  }),
  onDesktopLocale: vi.fn(async (handler) => {
    listeners.locale = handler;
    return () => undefined;
  }),
  onDesktopSettingsView: vi.fn(async (handler) => {
    listeners.settingsView = handler;
    return () => undefined;
  }),
  onDesktopSurface: vi.fn(async (handler) => {
    listeners.surface = handler;
    return () => undefined;
  }),
  ignoreDesktopUpdate: vi.fn(async version => ({ ...settings, desktopUpdateIgnoredVersion: version })),
  openDesktopMenu: vi.fn(),
  openDesktopRelease: vi.fn(),
  openDesktopUpdateLink: vi.fn(),
  openRepository: vi.fn(),
  openWorkbench: vi.fn(),
  saveSettings: vi.fn(async value => value),
  downloadHarnessUpdate: vi.fn(async () => ({
    enabled: true, phase: "staged", currentVersion: "1.0.0", currentCommit: "a".repeat(40), currentSource: "bundled",
    availableVersion: "1.1.0", pendingVersion: "1.1.0", channel: "stable", mode: "automatic", pinnedVersion: null,
    downloadedBytes: 1024, totalBytes: 1024, message: "restart-to-apply"
  })),
  restoreBundledHarness: vi.fn(async () => ({
    enabled: true, phase: "rolled-back", currentVersion: "1.0.0", currentCommit: "a".repeat(40), currentSource: "bundled",
    availableVersion: null, pendingVersion: null, channel: "stable", mode: "automatic", pinnedVersion: null,
    downloadedBytes: 0, totalBytes: null, message: "bundled-restored"
  })),
  startHarness: vi.fn(),
  stopHarness: vi.fn(async () => ({ ...harness }))
}));

enableAutoUnmount(afterEach);

describe(`${appConfig.productName} shell`, () => {
  beforeEach(() => {
    Object.assign(settings, {
      schemaVersion: 7,
      locale: "zh-CN",
      onboardingCompleted: false,
      updateChannel: "community",
      updateEnabled: false,
      harnessUpdateChannel: "stable",
      harnessUpdateMode: "automatic",
      harnessUpdateRepository: null,
      harnessPinnedVersion: null,
      desktopUpdateLastCheckAt: null,
      desktopUpdateIgnoredVersion: null,
      recoveryReason: null
    });
    Object.assign(harness, {
      phase: "idle",
      url: null,
      restartCount: 0,
      diagnosticId: null,
      errorCode: null
    });
    vi.clearAllMocks();
    listeners.settingsView = undefined;
    listeners.surface = undefined;
    listeners.locale = undefined;
    listeners.harnessUpdate = undefined;
    delete (window as Window & { __DEEPSEEK_DESKTOP_MENU_ONLY__?: boolean }).__DEEPSEEK_DESKTOP_MENU_ONLY__;
    vi.mocked(checkForUpdates).mockResolvedValue({
      enabled: false,
      channel: "community",
      currentVersion: "1.0.0",
      availableVersion: null,
      releaseTag: null,
      publishedAt: null,
      releaseNotes: null,
      prerelease: false,
      message: "up-to-date"
    });
    vi.mocked(startHarness).mockResolvedValue({
      ...harness,
      phase: "ready",
      url: "http://127.0.0.1:49152"
    });
    i18n.global.locale.value = "zh-CN";
  });

  it("starts the Harness automatically and switches visible navigation to English", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startHarness).toHaveBeenCalledOnce();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("Harness 已就绪");
    expect(wrapper.text()).not.toContain("开始使用");

    await wrapper.get("select").setValue("en-US");
    await flushPromises();
    expect(wrapper.text()).toContain("Harness ready");
    expect(wrapper.text()).toContain("Harness");
    expect(wrapper.text()).toContain("Diagnostics");
    expect(wrapper.get('[role="menubar"]').text()).toContain("FileEditViewWindowHelp");
  });

  it.each([
    ["zh-CN", "Harness 仓库连接超时，请检查网络或代理后重试。当前版本未受影响。"],
    ["zh-TW", "Harness 倉庫連線逾時，請檢查網路或代理後重試。目前版本未受影響。"],
    ["en-US", "The Harness repository connection timed out. Check your network or proxy and retry. The current version was not changed."]
  ] as const)("explains a repository timeout in %s without restarting Harness", async (locale, message) => {
    settings.locale = locale;
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    listeners.settingsView?.("update");
    listeners.harnessUpdate?.({
      enabled: true, phase: "failed", currentVersion: "1.0.0", currentCommit: "a".repeat(40), currentSource: "bundled",
      availableVersion: null, pendingVersion: null, channel: "stable", mode: "notify", pinnedVersion: null,
      downloadedBytes: 0, totalBytes: null, message: "repository-timeout"
    });
    await flushPromises();
    expect(wrapper.text()).toContain(message);
    expect(startHarness).toHaveBeenCalledOnce();
  });

  it("keeps one keyboard-accessible menu bar in the Desktop Shell", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const wrapper = mount(App, { attachTo: host, global: { plugins: [i18n] } });
    await flushPromises();

    const menuBar = wrapper.get('[role="menubar"]');
    const menuButtons = menuBar.findAll('[role="menuitem"]');
    expect(menuButtons.map(button => button.text())).toEqual(["文件", "编辑", "视图", "窗口", "帮助"]);

    await menuButtons[0].trigger("keydown", { key: "ArrowRight" });
    expect(document.activeElement).toBe(menuButtons[1].element);
    await menuButtons[1].trigger("keydown", { key: "Enter" });
    expect(openDesktopMenu).toHaveBeenCalledWith("edit", expect.any(Number));
    wrapper.unmount();
    host.remove();
  });

  it("does not reopen a native menu while its popup is still active", async () => {
    let finishOpening: (() => void) | undefined;
    vi.mocked(openDesktopMenu).mockImplementationOnce(() => new Promise<void>(resolve => {
      finishOpening = resolve;
    }));
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    const fileMenu = wrapper.get('[role="menuitem"]');
    await fileMenu.trigger("click");
    await fileMenu.trigger("click");

    expect(openDesktopMenu).toHaveBeenCalledTimes(1);
    finishOpening?.();
    await flushPromises();
  });

  it("keeps the dedicated workbench menu synchronized with the saved locale", async () => {
    settings.locale = "zh-TW";
    (window as Window & { __DEEPSEEK_DESKTOP_MENU_ONLY__?: boolean }).__DEEPSEEK_DESKTOP_MENU_ONLY__ = true;
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startHarness).not.toHaveBeenCalled();
    expect(wrapper.get('[role="menubar"]').text()).toBe("檔案編輯顯示方式視窗輔助說明");

    listeners.locale?.("en-US");
    await flushPromises();
    expect(wrapper.get('[role="menubar"]').text()).toBe("FileEditViewWindowHelp");
    wrapper.unmount();
    delete (window as Window & { __DEEPSEEK_DESKTOP_MENU_ONLY__?: boolean }).__DEEPSEEK_DESKTOP_MENU_ONLY__;
  });

  it("opens settings from a native menu event and returns to the preserved workbench", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    listeners.surface?.("settings");
    listeners.settingsView?.("diagnostics");
    await flushPromises();
    expect(wrapper.get("h1").text()).toBe("运行诊断");

    await wrapper.get('button[aria-label="关闭设置并返回工作台"]').trigger("click");
    await flushPromises();

    expect(startHarness).toHaveBeenCalledOnce();
    expect(openWorkbench).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Cmd+W", { metaKey: true }],
    ["Ctrl+W", { ctrlKey: true }]
  ])("closes settings with %s without stopping the Harness", async (_label, modifiers) => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    listeners.surface?.("settings");
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "w",
      bubbles: true,
      cancelable: true,
      ...modifiers
    }));
    await flushPromises();

    expect(startHarness).toHaveBeenCalledOnce();
    expect(openWorkbench).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("starts a manual Desktop update check from the native menu event", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    listeners.surface?.("settings");
    listeners.settingsView?.("desktop-update");
    await flushPromises();

    expect(wrapper.get("h1").text()).toBe("更新");
    expect(checkForUpdates).toHaveBeenLastCalledWith(false);
  });

  it("opens an already running Harness without starting a second process", async () => {
    Object.assign(harness, {
      phase: "ready",
      url: "http://127.0.0.1:49152"
    });

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startHarness).not.toHaveBeenCalled();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("Harness 已就绪");
  });

  it("retries an early failure without a Desktop workspace", async () => {
    settings.onboardingCompleted = true;
    harness.phase = "failed";
    harness.errorCode = "harness-task-failed";
    vi.mocked(startHarness).mockResolvedValue({
      ...harness,
      phase: "ready",
      url: "http://127.0.0.1:49152",
      errorCode: null
    });

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "重试")?.trigger("click");
    await flushPromises();

    expect(startHarness).toHaveBeenCalledWith();
    expect(wrapper.text()).toContain("Harness 已就绪");
  });

  it("starts an idle Harness without requiring a Desktop workspace", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startHarness).toHaveBeenCalledOnce();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("运行状态");
    expect(wrapper.text()).not.toContain("选择工作区");
    expect(wrapper.findAll("button").find(button => button.text() === "启动")).toBeUndefined();
  });

  it("keeps the management view available when automatic startup fails", async () => {
    vi.mocked(startHarness).mockRejectedValue(new Error("startup failed"));

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startHarness).toHaveBeenCalledOnce();
    expect(openWorkbench).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("运行状态");
    expect(wrapper.text()).toContain("操作失败，请查看诊断信息");
  });

  it("clears diagnostics notices when leaving the diagnostics view", async () => {
    settings.onboardingCompleted = true;
    vi.mocked(exportDiagnostics).mockResolvedValue("/tmp/dsh-diagnostics.json");
    vi.mocked(exportLogs).mockResolvedValue("/tmp/deepseek-desktop.log");

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text().includes("诊断"))?.trigger("click");
    await wrapper.findAll("button").find(button => button.text() === "导出日志")?.trigger("click");
    await flushPromises();
    expect(exportLogs).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("/tmp/deepseek-desktop.log");

    await wrapper.findAll("button").find(button => button.text() === "导出诊断包")?.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("/tmp/dsh-diagnostics.json");

    await wrapper.findAll("button").find(button => button.text().includes("运行状态"))?.trigger("click");
    expect(wrapper.text()).not.toContain("/tmp/dsh-diagnostics.json");
  });

  it("shows the configured author and opens the project repository", async () => {
    settings.onboardingCompleted = true;
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    await wrapper.findAll("button").find(button => button.text().includes("关于"))?.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain(appConfig.authors.join(", "));
    const repository = wrapper.get(".repository-link");
    expect(repository.text()).toBe(appConfig.repository);
    await repository.trigger("click");
    expect(openRepository).toHaveBeenCalledOnce();
  });

  it("checks and stages an independent Harness update", async () => {
    settings.onboardingCompleted = true;
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text().includes("更新"))?.trigger("click");
    await wrapper.findAll("button").find(button => button.text() === "检查 Harness")?.trigger("click");
    await flushPromises();
    expect(checkHarnessUpdate).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("发现 Harness 1.1.0");
    await wrapper.findAll("button").find(button => button.text().includes("准备并等待"))?.trigger("click");
    await flushPromises();
    expect(downloadHarnessUpdate).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("下次启动切换");
  });

  it("replaces the Harness repository without exposing update service fields", async () => {
    settings.onboardingCompleted = true;
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text().includes("更新"))?.trigger("click");

    expect((wrapper.get("#harness-update-repository").element as HTMLInputElement).value)
      .toBe(appConfig.harness.repository);
    expect(wrapper.get("#harness-update-repository").attributes("type")).toBe("text");
    expect(wrapper.get("#harness-update-repository").attributes("inputmode")).toBe("url");
    await wrapper.get("#harness-update-repository").setValue("https://git.example.com/harness/harness.git");
    expect(wrapper.find("#harness-update-manifest-url").exists()).toBe(false);
    expect(wrapper.find("#harness-update-publisher").exists()).toBe(false);
    expect(wrapper.find("#harness-update-public-key").exists()).toBe(false);
    await wrapper.findAll("button").find(button => button.text() === "保存仓库")?.trigger("click");
    await flushPromises();

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 7,
      harnessUpdateRepository: "https://git.example.com/harness/harness.git"
    }));
    expect(wrapper.text()).toContain("Harness 仓库已保存");
  });

  it("shows a Desktop release reminder and can ignore that exact version", async () => {
    vi.mocked(checkForUpdates).mockResolvedValue({
      enabled: false,
      channel: "community",
      currentVersion: "1.0.0",
      availableVersion: "1.1.0-beta.1",
      releaseTag: "v1.1.0-beta.1",
      publishedAt: "2026-08-30T10:00:00Z",
      releaseNotes: "# Community release\n\nA **tested** community release.\n\n- Fixed update notes",
      prerelease: true,
      message: "update-available"
    });
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(wrapper.text()).toContain("发现 Desktop 1.1.0-beta.1");
    expect(wrapper.text()).toContain("预发布版");
    expect(wrapper.text()).toContain("A tested community release.");
    expect(wrapper.get(".update-notes h1").text()).toBe("Community release");
    expect(wrapper.get(".update-notes strong").text()).toBe("tested");
    expect(wrapper.get(".update-notes li").text()).toBe("Fixed update notes");
    await wrapper.findAll("button").find(button => button.text() === "忽略此版本")?.trigger("click");
    await flushPromises();

    expect(ignoreDesktopUpdate).toHaveBeenCalledWith("1.1.0-beta.1");
    expect(openDesktopRelease).not.toHaveBeenCalled();
  });

  it.each([null, "   "])("keeps the empty-summary fallback for %s notes", async releaseNotes => {
    vi.mocked(checkForUpdates).mockResolvedValue({
      enabled: false, channel: "community", currentVersion: "1.0.0", availableVersion: "1.1.0",
      releaseTag: "v1.1.0", publishedAt: null, releaseNotes, prerelease: true, message: "update-available"
    });
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.get('[role="alertdialog"]').text()).toContain(i18n.global.t("update.noSummary"));
    expect(wrapper.find(".update-notes").exists()).toBe(false);
  });

  it("does not interrupt startup when the silent Desktop update check fails", async () => {
    vi.mocked(checkForUpdates).mockRejectedValue(new Error("offline"));
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startHarness).toHaveBeenCalledOnce();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(wrapper.text()).not.toContain("Desktop 更新检查失败");
  });
});
