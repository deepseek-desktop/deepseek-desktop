export type RuntimePhase = "idle" | "starting" | "ready" | "stopping" | "recovering" | "failed";
export type DesktopSurface = "management" | "workbench";

export interface RuntimeStatus {
  phase: RuntimePhase;
  url: string | null;
  workspace: string | null;
  restartCount: number;
  diagnosticId: string | null;
  errorCode: string | null;
}

export interface DesktopSettings {
  schemaVersion: number;
  locale: "zh-CN" | "zh-TW" | "en-US";
  theme: "system" | "light" | "dark";
  workspace: string | null;
  onboardingCompleted: boolean;
  updateChannel: "community" | "stable";
  updateEnabled: boolean;
}

export interface DesktopAbout {
  desktopVersion: string;
  harnessVersion: string;
  harnessCommit: string;
  nodeVersion: string;
  channel: string;
  signedRelease: boolean;
}

export interface UpdateStatus {
  enabled: boolean;
  channel: string;
  currentVersion: string;
  availableVersion: string | null;
  message: string;
}
