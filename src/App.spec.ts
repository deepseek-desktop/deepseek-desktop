import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import { appConfig } from "./app-config";
import type { DesktopSettings, RuntimeStatus } from "./contracts";
import { checkRuntimeUpdate, downloadRuntimeUpdate, exportDiagnostics, exportLogs, openRepository, openWorkbench, startRuntime } from "./desktop";
import { i18n } from "./i18n";

const settings: DesktopSettings = {
  schemaVersion: 3,
  locale: "zh-CN",
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false,
  runtimeUpdateChannel: "stable",
  runtimeUpdateMode: "automatic",
  runtimePinnedVersion: null,
  recoveryReason: null
};
const runtime: RuntimeStatus = {
  phase: "idle",
  url: null,
  restartCount: 0,
  diagnosticId: null,
  errorCode: null
};

vi.mock("./desktop", () => ({
  checkForUpdates: vi.fn(),
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
    nodeVersion: "24.16.0",
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
  onDesktopSurface: vi.fn(async () => () => undefined),
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
      schemaVersion: 3,
      locale: "zh-CN",
      onboardingCompleted: false,
      updateChannel: "community",
      updateEnabled: false,
      runtimeUpdateChannel: "stable",
      runtimeUpdateMode: "automatic",
      runtimePinnedVersion: null,
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
    i18n.global.locale.value = "zh-CN";
  });

  it("loads onboarding and switches all visible navigation to English", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.text()).toContain(`欢迎使用 ${appConfig.productName}`);

    await wrapper.get("select").setValue("en-US");
    await flushPromises();
    expect(wrapper.text()).toContain(`Welcome to ${appConfig.productName}`);
    expect(wrapper.text()).toContain("Runtime");
    expect(wrapper.text()).toContain("Diagnostics");
  });

  it("starts onboarding without requiring a Desktop workspace", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    const continueButton = () => wrapper.findAll("button").find(button => button.text() === "继续");
    await continueButton()?.trigger("click");
    expect(wrapper.text()).toContain("配置模型");
    expect(wrapper.text()).not.toContain("选择工作区");
    expect(wrapper.findAll("button").find(button => button.text() === "启动工作台")).toBeDefined();
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

  it("starts an idle runtime without a Desktop workspace", async () => {
    settings.onboardingCompleted = true;
    vi.mocked(startRuntime).mockResolvedValue({
      ...runtime,
      phase: "ready",
      url: "http://127.0.0.1:49152"
    });

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    const startButton = wrapper.findAll("button").find(button => button.text() === "启动");
    expect(startButton).toBeDefined();
    await startButton?.trigger("click");
    await flushPromises();

    expect(startRuntime).toHaveBeenCalledWith();
    expect(openWorkbench).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("运行状态");
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

    await wrapper.findAll("button").find(button => button.text().includes("开始使用"))?.trigger("click");
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
});
