import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import type { DesktopSettings, RuntimeStatus } from "./contracts";
import { exportDiagnostics, startRuntime } from "./desktop";
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
  getAbout: vi.fn(async () => ({
    desktopVersion: "0.1.0-community.2",
    harnessVersion: "0.1.1-rc.2",
    harnessCommit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
    nodeVersion: "24.16.0",
    channel: "community",
    signedRelease: false
  })),
  getRuntimeStatus: vi.fn(async () => ({ ...runtime })),
  getSettings: vi.fn(async () => ({ ...settings })),
  onRuntimeStatus: vi.fn(async () => () => undefined),
  openHarness: vi.fn(),
  saveSettings: vi.fn(async value => value),
  startRuntime: vi.fn(),
  stopRuntime: vi.fn(async () => ({ ...runtime }))
}));

describe("DSH Desktop shell", () => {
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
    expect(wrapper.text()).toContain("欢迎使用 DSH Desktop");

    await wrapper.get("select").setValue("en-US");
    await flushPromises();
    expect(wrapper.text()).toContain("Welcome to DSH Desktop");
    expect(wrapper.text()).toContain("Runtime");
    expect(wrapper.text()).toContain("Diagnostics");
  });

  it("keeps launch disabled until a workspace is selected", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    const continueButton = () => wrapper.findAll("button").find(button => button.text() === "继续");
    await continueButton()?.trigger("click");
    await continueButton()?.trigger("click");
    expect(wrapper.findAll("button").find(button => button.text() === "启动工作台")?.attributes("disabled")).toBeDefined();
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
    expect(wrapper.text()).toContain("Runtime 已就绪");
  });

  it("clears diagnostics notices when leaving the diagnostics view", async () => {
    settings.onboardingCompleted = true;
    vi.mocked(exportDiagnostics).mockResolvedValue("/tmp/dsh-diagnostics.json");

    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text().includes("诊断"))?.trigger("click");
    await wrapper.findAll("button").find(button => button.text() === "导出诊断包")?.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("/tmp/dsh-diagnostics.json");

    await wrapper.findAll("button").find(button => button.text().includes("开始使用"))?.trigger("click");
    expect(wrapper.text()).not.toContain("/tmp/dsh-diagnostics.json");
  });
});
