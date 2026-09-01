import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import { appConfig } from "./app-config";
import type { DesktopSettings, RuntimeStatus } from "./contracts";
import { checkForUpdates, checkRuntimeUpdate, downloadRuntimeUpdate, exportDiagnostics, exportLogs, ignoreDesktopUpdate, openDesktopRelease, openRepository, openWorkbench, saveSettings, startRuntime } from "./desktop";
import { i18n } from "./i18n";

const settings: DesktopSettings = {
  schemaVersion: 5,
  locale: "zh-CN",
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false,
  runtimeUpdateChannel: "stable",
  runtimeUpdateMode: "automatic",
  runtimeUpdateSource: "official",
  runtimeUpdateManifestUrl: null,
  runtimeUpdateRepository: null,
  runtimeUpdatePublisher: null,
  runtimeUpdatePublicKey: null,
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
  onDesktopSettingsView: vi.fn(async (handler) => {
    listeners.settingsView = handler;
    return () => undefined;
  }),
  onDesktopSurface: vi.fn(async (handler) => {
    listeners.surface = handler;
    return () => undefined;
  }),
  ignoreDesktopUpdate: vi.fn(async version => ({ ...settings, desktopUpdateIgnoredVersion: version })),
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

describe(`${appConfig.productName} shell`, () => {
  beforeEach(() => {
    Object.assign(settings, {
      schemaVersion: 5,
      locale: "zh-CN",
      onboardingCompleted: false,
      updateChannel: "community",
      updateEnabled: false,
      runtimeUpdateChannel: "stable",
      runtimeUpdateMode: "automatic",
      runtimeUpdateSource: "official",
      runtimeUpdateManifestUrl: null,
      runtimeUpdateRepository: null,
      runtimeUpdatePublisher: null,
      runtimeUpdatePublicKey: null,
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
    await wrapper.findAll("button").find(button => button.text().includes("下载并等待"))?.trigger("click");
    await flushPromises();
    expect(downloadRuntimeUpdate).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("下次启动安装");
  });

  it("saves a complete custom Runtime update trust profile", async () => {
    settings.onboardingCompleted = true;
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text().includes("更新"))?.trigger("click");

    await wrapper.get("#runtime-update-source").setValue("custom");
    await wrapper.get("#runtime-update-manifest-url").setValue("https://updates.example.com/runtime/manifest.json");
    await wrapper.get("#runtime-update-repository").setValue("https://git.example.com/runtime/runtime.git");
    await wrapper.get("#runtime-update-publisher").setValue("example-runtime");
    await wrapper.get("#runtime-update-public-key").setValue("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=");
    await wrapper.findAll("button").find(button => button.text() === "保存更新源")?.trigger("click");
    await flushPromises();

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      runtimeUpdateSource: "custom",
      runtimeUpdateManifestUrl: "https://updates.example.com/runtime/manifest.json",
      runtimeUpdateRepository: "https://git.example.com/runtime/runtime.git",
      runtimeUpdatePublisher: "example-runtime",
      runtimeUpdatePublicKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="
    }));
    expect(wrapper.text()).toContain("Runtime 更新源已保存");
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
