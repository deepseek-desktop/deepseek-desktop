import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { appConfig } from "./app-config";
import type { DesktopAbout, DesktopSettings, DesktopSettingsView, DesktopSurface, HarnessStatus, HarnessUpdateStatus, UpdateStatus } from "./contracts";

const inTauri = (): boolean => "__TAURI_INTERNALS__" in window;

export type DesktopMenuName = "file" | "edit" | "view" | "window" | "help";

const browserSettings: DesktopSettings = {
  schemaVersion: 7,
  locale: "zh-CN",
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false,
  harnessUpdateChannel: appConfig.harnessUpdate.channel,
  harnessUpdateMode: appConfig.harnessUpdate.autoUpdate ? "automatic" : "notify",
  harnessUpdateRepository: null,
  harnessPinnedVersion: null,
  desktopUpdateLastCheckAt: null,
  desktopUpdateIgnoredVersion: null,
  recoveryReason: null
};

export async function getHarnessStatus(): Promise<HarnessStatus> {
  if (!inTauri()) {
    return {
      phase: "idle",
      url: null,
      restartCount: 0,
      diagnosticId: null,
      errorCode: null
    };
  }
  return invoke<HarnessStatus>("harness_status");
}

export async function startHarness(): Promise<HarnessStatus> {
  if (!inTauri()) return { ...(await getHarnessStatus()), phase: "ready" };
  return invoke<HarnessStatus>("harness_start");
}

export async function stopHarness(): Promise<HarnessStatus> {
  if (!inTauri()) return getHarnessStatus();
  return invoke<HarnessStatus>("harness_stop");
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
  if (inTauri()) await invoke("harness_open");
}

export async function openDesktopMenu(menu: DesktopMenuName, anchorX: number): Promise<void> {
  if (inTauri()) await invoke("desktop_menu_popup", { menu, anchorX });
}

export async function getAbout(): Promise<DesktopAbout> {
  if (!inTauri()) {
    return {
      desktopVersion: appConfig.version,
      harnessVersion: appConfig.harness.ref.replace(/^dsh-v/u, "") || "auto",
      harnessCommit: "development",
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

export async function openDesktopUpdateLink(url: string): Promise<void> {
  if (!inTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("desktop_update_open_link", { url });
}

function browserHarnessUpdateStatus(): HarnessUpdateStatus {
  return {
    enabled: Boolean(appConfig.harness.repository),
    phase: appConfig.harness.repository ? "idle" : "disabled",
    currentVersion: appConfig.harness.ref.replace(/^dsh-v/u, "") || "development",
    currentCommit: "development",
    currentSource: "bundled",
    availableVersion: null,
    pendingVersion: null,
    channel: browserSettings.harnessUpdateChannel,
    mode: browserSettings.harnessUpdateMode,
    pinnedVersion: browserSettings.harnessPinnedVersion,
    downloadedBytes: 0,
    totalBytes: null,
    message: appConfig.harness.repository ? "idle" : "not-configured"
  };
}

export async function getHarnessUpdateStatus(): Promise<HarnessUpdateStatus> {
  if (!inTauri()) return browserHarnessUpdateStatus();
  return invoke<HarnessUpdateStatus>("harness_update_status");
}

export async function checkHarnessUpdate(): Promise<HarnessUpdateStatus> {
  if (!inTauri()) return browserHarnessUpdateStatus();
  return invoke<HarnessUpdateStatus>("harness_update_check");
}

export async function downloadHarnessUpdate(): Promise<HarnessUpdateStatus> {
  if (!inTauri()) return browserHarnessUpdateStatus();
  return invoke<HarnessUpdateStatus>("harness_update_download");
}

export async function restoreBundledHarness(): Promise<HarnessUpdateStatus> {
  if (!inTauri()) return browserHarnessUpdateStatus();
  return invoke<HarnessUpdateStatus>("harness_update_restore_bundled");
}

export async function onHarnessUpdateStatus(handler: (status: HarnessUpdateStatus) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen<HarnessUpdateStatus>("harness-update://status", event => handler(event.payload));
}

export async function exportDiagnostics(): Promise<string> {
  if (!inTauri()) return "";
  return invoke<string>("diagnostics_export");
}

export async function exportLogs(): Promise<string> {
  if (!inTauri()) return "";
  return invoke<string>("logs_export");
}

export async function onHarnessStatus(handler: (status: HarnessStatus) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen<HarnessStatus>("harness://status", event => handler(event.payload));
}

export async function onDesktopSurface(handler: (surface: DesktopSurface) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen<DesktopSurface>("desktop://surface", event => handler(event.payload));
}

export async function onDesktopSettingsView(handler: (view: DesktopSettingsView) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen<DesktopSettingsView>("desktop://settings-view", event => handler(event.payload));
}

export async function onDesktopLocale(handler: (locale: DesktopSettings["locale"]) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen<DesktopSettings["locale"]>("desktop://locale", event => handler(event.payload));
}
