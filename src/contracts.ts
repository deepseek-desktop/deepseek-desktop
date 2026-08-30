export type RuntimePhase = "idle" | "starting" | "ready" | "stopping" | "recovering" | "failed";
export type DesktopSurface = "management" | "workbench";

export interface RuntimeStatus {
  phase: RuntimePhase;
  url: string | null;
  restartCount: number;
  diagnosticId: string | null;
  errorCode: string | null;
}

export interface DesktopSettings {
  schemaVersion: number;
  locale: "zh-CN" | "zh-TW" | "en-US";
  onboardingCompleted: boolean;
  updateChannel: "community" | "stable";
  updateEnabled: boolean;
  runtimeUpdateChannel: "stable" | "preview";
  runtimeUpdateMode: "automatic" | "notify" | "manual";
  runtimePinnedVersion: string | null;
  recoveryReason?: "corrupt" | "future" | null;
}

export type RuntimeUpdatePhase = "disabled" | "idle" | "checking" | "available" | "downloading" | "staged" | "applying" | "applied" | "failed" | "rolled-back" | "pinned";

export interface RuntimeUpdateStatus {
  enabled: boolean;
  phase: RuntimeUpdatePhase;
  currentVersion: string;
  currentCommit: string;
  currentSource: "bundled" | "updated";
  availableVersion: string | null;
  pendingVersion: string | null;
  channel: "stable" | "preview";
  mode: "automatic" | "notify" | "manual";
  pinnedVersion: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  message: string;
}

export interface DesktopAbout {
  desktopVersion: string;
  runtimeVersion: string;
  runtimeCommit: string;
  nodeVersion: string;
  authors: string;
  repository: string;
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
