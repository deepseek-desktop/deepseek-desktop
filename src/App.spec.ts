import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import { appConfig } from "./app-config";
import type { DesktopSettings, RuntimeStatus } from "./contracts";
import { checkForUpdates, checkRuntimeUpdate, downloadRuntimeUpdate, exportDiagnostics, exportLogs, ignoreDesktopUpdate, openDesktopMenu, openDesktopRelease, openRepository, openWorkbench, saveSettings, startRuntime } from "./desktop";
import { i18n } from "./i18n";

const settings: DesktopSettings = {
  schemaVersion: 6,
  locale: "zh-CN",
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false,
  runtimeUpdateChannel: "stable",
  runtimeUpdateMode: "automatic",
  runtimeUpdateRepository: null,
  runtimePinnedVersion: null,
  desktopUpdateLastCheckAt: null,
  desktopUpdateIgnoredVersion: null,
  recoveryReason: null
};
const runtime: RuntimeStatus = {
  phase: "idle",
  url: null,
  restartCount: 0,
  diagnosticId: null,
  errorCode: null
};

const listeners = vi.hoisted(() => ({
  locale: undefined as ((locale: "zh-CN" | "zh-TW" | "en-US") => void) | undefined,
  settingsView: undefined as ((view: "runtime" | "diagnostics" | "update" | "desktop-update" | "about") => void) | undefined,
  surface: undefined as ((surface: "settings" | "workbench") => void) | undefined
}));

vi.mock("./desktop", () => ({
  checkForUpdates: vi.fn(async () => ({
    enabled: false, channel: "community", currentVersion: "1.0.0", availableVersion: null,
    releaseTag: null, publishedAt: null, releaseNotes: null, prerelease: false, message: "up-to-date"
  })),
  checkRuntimeUpdate: vi.fn(async () => ({
    enabled: true, phase: "available", currentVersion: "1.0.0", currentCommit: "a".repeat(40), currentSource: "bundled",
    availableVersion: "1.1.0", pendingVersion: null, channel: "stable", mode: "automatic", pinnedVersion: null,
    downloadedBytes: 0, totalBytes: 1024, message: "available"
  })),
  exportDiagnostics: vi.fn(async () => ""),
  exportLogs: vi.fn(async () => ""),
  getAbout: vi.fn(async () => ({
    desktopVersion: appConfig.version,
    runtimeVersion: "0.1.2-alpha.1",
    runtimeCommit: "cd5ef8148158c3a752a658978873241fdf8e2bbc",
    nodeVersion: "24.20.0",
    authors: appConfig.authors.join(", "),
    repository: appConfig.repository,
    channel: "community",
    signedRelease: false
  })),
  getRuntimeStatus: vi.fn(async () => ({ ...runtime })),
  getRuntimeUpdateStatus: vi.fn(async () => ({
    enabled: true, phase: "idle", currentVersion: "1.0.0", currentCommit: "a".repeat(40), currentSource: "bundled",
    availableVersion: null, pendingVersion: null, channel: "stable", mode: "automatic", pinnedVersion: null,
    downloadedBytes: 0, totalBytes: null, message: "idle"
  })),
  getSettings: vi.fn(async () => ({ ...settings })),
  onRuntimeStatus: vi.fn(async () => () => undefined),
  onRuntimeUpdateStatus: vi.fn(async () => () => undefined),
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
  openRepository: vi.fn(),
  openWorkbench: vi.fn(),
  saveSettings: vi.fn(async value => value),
  downloadRuntimeUpdate: vi.fn(async () => ({
    enabled: true, phase: "staged", currentVersion: "1.0.0", currentCommit: "a".repeat(40), currentSource: "bundled",
    availableVersion: "1.1.0", pendingVersion: "1.1.0", channel: "stable", mode: "automatic", pinnedVersion: null,
    downloadedBytes: 1024, totalBytes: 1024, message: "restart-to-apply"
  })),
  restoreBundledRuntime: vi.fn(async () => ({
    enabled: true, phase: "rolled-back", currentVersion: "1.0.0", currentCommit: "a".repeat(40), currentSource: "bundled",
    availableVersion: null, pendingVersion: null, channel: "stable", mode: "automatic", pinnedVersion: null,
    downloadedBytes: 0, totalBytes: null, message: "bundled-restored"
  })),
  startRuntime: vi.fn(),
  stopRuntime: vi.fn(async () => ({ ...runtime }))
}));

enableAutoUnmount(afterEach);

describe(`${appConfig.productName} shell`, () => {
  beforeEach(() => {
    Object.assign(settings, {
      schemaVersion: 6,
      locale: "zh-CN",
      onboardingCompleted: false,
      updateChannel: "community",
      updateEnabled: false,
      runtimeUpdateChannel: "stable",
      runtimeUpdateMode: "automatic",
      runtimeUpdateRepository: null,
      runtimePinnedVersion: null,
      desktopUpdateLastCheckAt: null,
      desktopUpdateIgnoredVersion: null,
      recoveryReason: null
    });
    Object.assign(runtime, {
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
    vi.mocked(startRuntime).mockResolvedValue({
      ...runtime,
      phase: "ready",
      url: "http://127.0.0.1:49152"
    });
    i18n.global.locale.value = "zh-CN";
  });

  it("starts the Runtime automatically and switches visible navigation to English", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startRuntime).toHaveBeenCalledOnce();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("Runtime 已就绪");
    expect(wrapper.text()).not.toContain("开始使用");

    await wrapper.get("select").setValue("en-US");
    await flushPromises();
    expect(wrapper.text()).toContain("Runtime ready");
    expect(wrapper.text()).toContain("Runtime");
    expect(wrapper.text()).toContain("Diagnostics");
    expect(wrapper.get('[role="menubar"]').text()).toContain("FileEditViewWindowHelp");
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

    expect(startRuntime).not.toHaveBeenCalled();
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

    expect(startRuntime).toHaveBeenCalledOnce();
    expect(openWorkbench).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Cmd+W", { metaKey: true }],
    ["Ctrl+W", { ctrlKey: true }]
  ])("closes settings with %s without stopping the Runtime", async (_label, modifiers) => {
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

    expect(startRuntime).toHaveBeenCalledOnce();
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

  it("opens an already running Runtime without starting a second process", async () => {
    Object.assign(runtime, {
      phase: "ready",
      url: "http://127.0.0.1:49152"
    });

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startRuntime).not.toHaveBeenCalled();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("Runtime 已就绪");
  });

  it("retries an early failure without a Desktop workspace", async () => {
    settings.onboardingCompleted = true;
    runtime.phase = "failed";
    runtime.errorCode = "runtime-task-failed";
    vi.mocked(startRuntime).mockResolvedValue({
      ...runtime,
      phase: "ready",
      url: "http://127.0.0.1:49152",
      errorCode: null
    });

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "重试")?.trigger("click");
    await flushPromises();

    expect(startRuntime).toHaveBeenCalledWith();
    expect(wrapper.text()).toContain("Runtime 已就绪");
  });

  it("starts an idle Runtime without requiring a Desktop workspace", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startRuntime).toHaveBeenCalledOnce();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("运行状态");
    expect(wrapper.text()).not.toContain("选择工作区");
    expect(wrapper.findAll("button").find(button => button.text() === "启动")).toBeUndefined();
  });

  it("keeps the management view available when automatic startup fails", async () => {
    vi.mocked(startRuntime).mockRejectedValue(new Error("startup failed"));

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startRuntime).toHaveBeenCalledOnce();
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

  it("checks and stages an independent Runtime update", async () => {
    settings.onboardingCompleted = true;
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text().includes("更新"))?.trigger("click");
    await wrapper.findAll("button").find(button => button.text() === "检查 Runtime")?.trigger("click");
    await flushPromises();
    expect(checkRuntimeUpdate).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("发现 Runtime 1.1.0");
    await wrapper.findAll("button").find(button => button.text().includes("准备并等待"))?.trigger("click");
    await flushPromises();
    expect(downloadRuntimeUpdate).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("下次启动切换");
  });

  it("replaces the Runtime repository without exposing update service fields", async () => {
    settings.onboardingCompleted = true;
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text().includes("更新"))?.trigger("click");

    expect((wrapper.get("#runtime-update-repository").element as HTMLInputElement).value)
      .toBe(appConfig.harness.repository);
    expect(wrapper.get("#runtime-update-repository").attributes("type")).toBe("text");
    expect(wrapper.get("#runtime-update-repository").attributes("inputmode")).toBe("url");
    await wrapper.get("#runtime-update-repository").setValue("https://git.example.com/runtime/runtime.git");
    expect(wrapper.find("#runtime-update-manifest-url").exists()).toBe(false);
    expect(wrapper.find("#runtime-update-publisher").exists()).toBe(false);
    expect(wrapper.find("#runtime-update-public-key").exists()).toBe(false);
    await wrapper.findAll("button").find(button => button.text() === "保存仓库")?.trigger("click");
    await flushPromises();

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 6,
      runtimeUpdateRepository: "https://git.example.com/runtime/runtime.git"
    }));
    expect(wrapper.text()).toContain("Runtime 仓库已保存");
  });

  it("shows a Desktop release reminder and can ignore that exact version", async () => {
    vi.mocked(checkForUpdates).mockResolvedValue({
      enabled: false,
      channel: "community",
      currentVersion: "1.0.0",
      availableVersion: "1.1.0-beta.1",
      releaseTag: "v1.1.0-beta.1",
      publishedAt: "2026-08-30T10:00:00Z",
      releaseNotes: "A tested community release.",
      prerelease: true,
      message: "update-available"
    });
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(wrapper.text()).toContain("发现 Desktop 1.1.0-beta.1");
    expect(wrapper.text()).toContain("预发布版");
    expect(wrapper.text()).toContain("A tested community release.");
    await wrapper.findAll("button").find(button => button.text() === "忽略此版本")?.trigger("click");
    await flushPromises();

    expect(ignoreDesktopUpdate).toHaveBeenCalledWith("1.1.0-beta.1");
    expect(openDesktopRelease).not.toHaveBeenCalled();
  });

  it("does not interrupt startup when the silent Desktop update check fails", async () => {
    vi.mocked(checkForUpdates).mockRejectedValue(new Error("offline"));
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(startRuntime).toHaveBeenCalledOnce();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(wrapper.text()).not.toContain("Desktop 更新检查失败");
  });
});
