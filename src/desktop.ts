import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { appConfig } from "./app-config";
import type { DesktopAbout, DesktopSettings, DesktopSurface, RuntimeStatus, UpdateStatus } from "./contracts";

const inTauri = (): boolean => "__TAURI_INTERNALS__" in window;

const browserSettings: DesktopSettings = {
  schemaVersion: 1,
  locale: "zh-CN",
  theme: "system",
  workspace: null,
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false
};

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (!inTauri()) {
    return {
      phase: "idle",
      url: null,
      workspace: browserSettings.workspace,
      restartCount: 0,
      diagnosticId: null,
      errorCode: null
    };
  }
  return invoke<RuntimeStatus>("runtime_status");
}

export async function startRuntime(workspace: string): Promise<RuntimeStatus> {
  if (!inTauri()) return { ...(await getRuntimeStatus()), phase: "ready", workspace };
  return invoke<RuntimeStatus>("runtime_start", { workspace });
}

export async function stopRuntime(): Promise<RuntimeStatus> {
  if (!inTauri()) return getRuntimeStatus();
  return invoke<RuntimeStatus>("runtime_stop");
}

export async function restartRuntime(): Promise<RuntimeStatus> {
  if (!inTauri()) return getRuntimeStatus();
  return invoke<RuntimeStatus>("runtime_restart");
}

export async function getSettings(): Promise<DesktopSettings> {
  if (!inTauri()) return { ...browserSettings };
  return invoke<DesktopSettings>("settings_get");
}

export async function saveSettings(settings: DesktopSettings): Promise<DesktopSettings> {
  if (!inTauri()) {
    Object.assign(browserSettings, settings);
    return { ...browserSettings };
  }
  return invoke<DesktopSettings>("settings_update", { settings });
}

export async function chooseWorkspace(title: string): Promise<string | null> {
  if (!inTauri()) return null;
  return invoke<string | null>("workspace_choose", { title });
}

export async function openWorkbench(): Promise<void> {
  if (inTauri()) await invoke("runtime_open");
}

export async function getAbout(): Promise<DesktopAbout> {
  if (!inTauri()) {
    return {
      desktopVersion: appConfig.version,
      runtimeVersion: appConfig.harness.ref.replace(/^dsh-v/u, ""),
      runtimeCommit: "development",
      nodeVersion: "24.16.0",
      channel: "community",
      signedRelease: false
    };
  }
  return invoke<DesktopAbout>("desktop_about");
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!inTauri()) {
    return {
      enabled: false,
      channel: "community",
      currentVersion: appConfig.version,
      availableVersion: null,
      message: "updates-disabled"
    };
  }
  return invoke<UpdateStatus>("update_check");
}

export async function exportDiagnostics(): Promise<string> {
  if (!inTauri()) return "";
  return invoke<string>("diagnostics_export");
}

export async function exportLogs(): Promise<string> {
  if (!inTauri()) return "";
  return invoke<string>("logs_export");
}

export async function onRuntimeStatus(handler: (status: RuntimeStatus) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen<RuntimeStatus>("runtime://status", event => handler(event.payload));
}

export async function onDesktopSurface(handler: (surface: DesktopSurface) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen<DesktopSurface>("desktop://surface", event => handler(event.payload));
}
