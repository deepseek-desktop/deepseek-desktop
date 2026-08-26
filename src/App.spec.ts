import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import { appConfig } from "./app-config";
import type { DesktopSettings, RuntimeStatus } from "./contracts";
import { chooseWorkspace, exportDiagnostics, exportLogs, openRepository, openWorkbench, startRuntime } from "./desktop";
import { i18n } from "./i18n";

const settings: DesktopSettings = {
  schemaVersion: 1,
  locale: "zh-CN",
  theme: "system",
  workspace: null,
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false
};
const runtime: RuntimeStatus = {
  phase: "idle",
  url: null,
  workspace: null,
  restartCount: 0,
  diagnosticId: null,
  errorCode: null
};

vi.mock("./desktop", () => ({
  checkForUpdates: vi.fn(),
  chooseWorkspace: vi.fn(async () => null),
  exportDiagnostics: vi.fn(async () => ""),
  exportLogs: vi.fn(async () => ""),
  getAbout: vi.fn(async () => ({
    desktopVersion: appConfig.version,
    runtimeVersion: "0.1.1-rc.2",
    runtimeCommit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
    nodeVersion: "24.16.0",
    authors: appConfig.authors.join(", "),
    repository: appConfig.repository,
    channel: "community",
    signedRelease: false
  })),
  getRuntimeStatus: vi.fn(async () => ({ ...runtime })),
  getSettings: vi.fn(async () => ({ ...settings })),
  onRuntimeStatus: vi.fn(async () => () => undefined),
  onDesktopSurface: vi.fn(async () => () => undefined),
  openRepository: vi.fn(),
  openWorkbench: vi.fn(),
  saveSettings: vi.fn(async value => value),
  startRuntime: vi.fn(),
  stopRuntime: vi.fn(async () => ({ ...runtime }))
}));

describe(`${appConfig.productName} shell`, () => {
  beforeEach(() => {
    Object.assign(settings, {
      schemaVersion: 1,
      locale: "zh-CN",
      theme: "system",
      workspace: null,
      onboardingCompleted: false,
      updateChannel: "community",
      updateEnabled: false
    });
    Object.assign(runtime, {
      phase: "idle",
      url: null,
      workspace: null,
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

  it("does not advance past workspace selection until a directory is selected", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    const continueButton = () => wrapper.findAll("button").find(button => button.text() === "继续");
    await continueButton()?.trigger("click");
    expect(wrapper.text()).toContain("选择工作区");
    expect(continueButton()?.attributes("disabled")).toBeDefined();
    await continueButton()?.trigger("click");
    expect(wrapper.text()).toContain("选择工作区");
    expect(wrapper.findAll("button").find(button => button.text() === "启动工作台")).toBeUndefined();

    vi.mocked(chooseWorkspace).mockResolvedValue("/tmp/dsh-workspace");
    await wrapper.findAll("button").find(button => button.text() === "选择目录")?.trigger("click");
    await flushPromises();
    expect(continueButton()?.attributes("disabled")).toBeUndefined();
    await continueButton()?.trigger("click");
    expect(wrapper.text()).toContain("配置模型");
  });

  it("retries an early failure with the persisted workspace", async () => {
    settings.workspace = "/tmp/dsh-workspace";
    settings.onboardingCompleted = true;
    runtime.phase = "failed";
    runtime.errorCode = "runtime-task-failed";
    vi.mocked(startRuntime).mockResolvedValue({
      ...runtime,
      phase: "ready",
      workspace: settings.workspace,
      url: "http://127.0.0.1:49152",
      errorCode: null
    });

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "重试")?.trigger("click");
    await flushPromises();

    expect(startRuntime).toHaveBeenCalledWith(settings.workspace);
    expect(wrapper.text()).toContain("Runtime 已就绪");
  });

  it("starts an idle runtime with the persisted workspace", async () => {
    settings.workspace = "/tmp/dsh-workspace";
    settings.onboardingCompleted = true;
    vi.mocked(startRuntime).mockResolvedValue({
      ...runtime,
      phase: "ready",
      workspace: settings.workspace,
      url: "http://127.0.0.1:49152"
    });

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    const startButton = wrapper.findAll("button").find(button => button.text() === "启动");
    expect(startButton).toBeDefined();
    await startButton?.trigger("click");
    await flushPromises();

    expect(startRuntime).toHaveBeenCalledWith(settings.workspace);
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
});
