import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import type { DesktopSettings, RuntimeStatus } from "./contracts";
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
    desktopVersion: "0.1.0-community.1",
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
  restartRuntime: vi.fn(async () => ({ ...runtime })),
  saveSettings: vi.fn(async value => value),
  startRuntime: vi.fn(),
  stopRuntime: vi.fn(async () => ({ ...runtime }))
}));

describe("DSH Desktop shell", () => {
  beforeEach(() => {
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
});
