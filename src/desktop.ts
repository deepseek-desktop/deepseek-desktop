import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { appConfig } from "./app-config";
import type { DesktopAbout, DesktopSettings, DesktopSettingsView, DesktopSurface, RuntimeStatus, RuntimeUpdateStatus, UpdateStatus } from "./contracts";

const inTauri = (): boolean => "__TAURI_INTERNALS__" in window;

const browserSettings: DesktopSettings = {
  schemaVersion: 5,
  locale: "zh-CN",
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false,
  runtimeUpdateChannel: appConfig.runtimeUpdate.channel,
  runtimeUpdateMode: appConfig.runtimeUpdate.autoUpdate ? "automatic" : "notify",
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

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (!inTauri()) {
    return {
      phase: "idle",
      url: null,
      restartCount: 0,
      diagnosticId: null,
      errorCode: null
    };
  }
  return invoke<RuntimeStatus>("runtime_status");
}

export async function startRuntime(): Promise<RuntimeStatus> {
  if (!inTauri()) return { ...(await getRuntimeStatus()), phase: "ready" };
  return invoke<RuntimeStatus>("runtime_start");
}

export async function stopRuntime(): Promise<RuntimeStatus> {
  if (!inTauri()) return getRuntimeStatus();
  return invoke<RuntimeStatus>("runtime_stop");
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

export async function openWorkbench(): Promise<void> {
  if (inTauri()) await invoke("runtime_open");
}

export async function getAbout(): Promise<DesktopAbout> {
  if (!inTauri()) {
    return {
      desktopVersion: appConfig.version,
      runtimeVersion: appConfig.harness.ref.replace(/^dsh-v/u, "") || "auto",
      runtimeCommit: "development",
      nodeVersion: appConfig.toolchain.nodeVersion,
      authors: appConfig.authors.join(", "),
      repository: appConfig.repository,
      channel: appConfig.release.channel,
      signedRelease: appConfig.release.signed
    };
  }
  return invoke<DesktopAbout>("desktop_about");
}

export async function openRepository(): Promise<void> {
  if (!inTauri()) {
    window.open(appConfig.repository, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("repository_open");
}

export async function checkForUpdates(silent = false): Promise<UpdateStatus> {
  if (!inTauri()) {
    return {
      enabled: false,
      channel: "community",
      currentVersion: appConfig.version,
      availableVersion: null,
      releaseTag: null,
      publishedAt: null,
      releaseNotes: null,
      prerelease: false,
      message: "updates-disabled"
    };
  }
  return invoke<UpdateStatus>("update_check", { silent });
}

export async function ignoreDesktopUpdate(version: string): Promise<DesktopSettings> {
  if (!inTauri()) {
    browserSettings.desktopUpdateIgnoredVersion = version;
    return { ...browserSettings };
  }
  return invoke<DesktopSettings>("desktop_update_ignore", { version });
}

export async function openDesktopRelease(tag: string): Promise<void> {
  if (!inTauri()) {
    window.open(`${appConfig.repository}/releases/tag/${encodeURIComponent(tag)}`, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("desktop_update_open_release", { tag });
}

function browserRuntimeUpdateStatus(): RuntimeUpdateStatus {
  return {
    enabled: Boolean(appConfig.runtimeUpdate.manifestUrl && appConfig.runtimeUpdate.publicKey),
    phase: appConfig.runtimeUpdate.manifestUrl ? "idle" : "disabled",
    currentVersion: appConfig.harness.ref.replace(/^dsh-v/u, "") || "development",
    currentCommit: "development",
    currentSource: "bundled",
    availableVersion: null,
    pendingVersion: null,
    channel: browserSettings.runtimeUpdateChannel,
    mode: browserSettings.runtimeUpdateMode,
    pinnedVersion: browserSettings.runtimePinnedVersion,
    downloadedBytes: 0,
    totalBytes: null,
    message: appConfig.runtimeUpdate.manifestUrl ? "idle" : "not-configured"
  };
}

export async function getRuntimeUpdateStatus(): Promise<RuntimeUpdateStatus> {
  if (!inTauri()) return browserRuntimeUpdateStatus();
  return invoke<RuntimeUpdateStatus>("runtime_update_status");
}

export async function checkRuntimeUpdate(): Promise<RuntimeUpdateStatus> {
  if (!inTauri()) return browserRuntimeUpdateStatus();
  return invoke<RuntimeUpdateStatus>("runtime_update_check");
}

export async function downloadRuntimeUpdate(): Promise<RuntimeUpdateStatus> {
  if (!inTauri()) return browserRuntimeUpdateStatus();
  return invoke<RuntimeUpdateStatus>("runtime_update_download");
}

export async function restoreBundledRuntime(): Promise<RuntimeUpdateStatus> {
  if (!inTauri()) return browserRuntimeUpdateStatus();
  return invoke<RuntimeUpdateStatus>("runtime_update_restore_bundled");
}

export async function onRuntimeUpdateStatus(handler: (status: RuntimeUpdateStatus) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen<RuntimeUpdateStatus>("runtime-update://status", event => handler(event.payload));
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

export async function onDesktopSettingsView(handler: (view: DesktopSettingsView) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen<DesktopSettingsView>("desktop://settings-view", event => handler(event.payload));
}
