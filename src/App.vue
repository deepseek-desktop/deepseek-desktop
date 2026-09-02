<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import DesktopMenuBar from "./DesktopMenuBar.vue";
import { appConfig } from "./app-config";
import deepSeekDesktopLogo from "./assets/deepseek-desktop.svg";
import type { DesktopAbout, DesktopSettings, DesktopSettingsView, RuntimeStatus, RuntimeUpdateStatus, UpdateStatus } from "./contracts";
import {
  checkRuntimeUpdate,
  checkForUpdates,
  downloadRuntimeUpdate,
  exportDiagnostics,
  exportLogs,
  getAbout,
  getRuntimeStatus,
  getRuntimeUpdateStatus,
  getSettings,
  ignoreDesktopUpdate,
  onDesktopLocale,
  onDesktopSettingsView,
  onDesktopSurface,
  onRuntimeStatus,
  onRuntimeUpdateStatus,
  openDesktopMenu,
  openDesktopRelease,
  openWorkbench,
  openRepository,
  restoreBundledRuntime,
  saveSettings,
  startRuntime,
  stopRuntime
} from "./desktop";
import type { DesktopMenuName } from "./desktop";
import { normalizeLocale, type SupportedLocale } from "./i18n";

type ViewName = Exclude<DesktopSettingsView, "desktop-update">;

const { locale, t } = useI18n();
const menuOnly = Boolean((window as Window & {
  __DEEPSEEK_DESKTOP_MENU_ONLY__?: boolean;
}).__DEEPSEEK_DESKTOP_MENU_ONLY__);
const view = ref<ViewName>("runtime");
const busy = ref(false);
const notice = ref("");
const runtime = ref<RuntimeStatus>({
  phase: "idle",
  url: null,
  restartCount: 0,
  diagnosticId: null,
  errorCode: null
});
const settings = ref<DesktopSettings>({
  schemaVersion: 6,
  locale: normalizeLocale(navigator.language),
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false,
  runtimeUpdateChannel: "stable",
  runtimeUpdateMode: "notify",
  runtimeUpdateRepository: null,
  runtimePinnedVersion: null,
  desktopUpdateLastCheckAt: null,
  desktopUpdateIgnoredVersion: null,
  recoveryReason: null
});
const about = ref<DesktopAbout | null>(null);
const update = ref<UpdateStatus | null>(null);
const runtimeUpdate = ref<RuntimeUpdateStatus | null>(null);
let unlisten: (() => void) | undefined;
let unlistenSurface: (() => void) | undefined;
let unlistenSettingsView: (() => void) | undefined;
let unlistenRuntimeUpdate: (() => void) | undefined;
let unlistenLocale: (() => void) | undefined;
const workbenchVisible = ref(false);
const updatePromptVisible = ref(false);
let workbenchOpening = false;
let desktopMenuOpening = false;

const phaseLabel = computed(() => t(`runtime.${runtime.value.phase}`));
const runtimeStartLabel = computed(() => runtime.value.phase === "failed" ? t("common.retry") : t("common.start"));
const runtimeErrorKeys: Record<string, string> = {
  "runtime-artifact-missing": "runtime.errors.artifactMissing",
  "runtime-workdir-unavailable": "runtime.errors.workdirUnavailable",
  "runtime-profile-prepare-failed": "runtime.errors.profilePrepareFailed",
  "runtime-helper-unavailable": "runtime.errors.helperUnavailable",
  "runtime-credential-session-failed": "runtime.errors.credentialSessionFailed",
  "runtime-environment-failed": "runtime.errors.environmentFailed",
  "runtime-timeout": "runtime.errors.timeout",
  "runtime-exited": "runtime.errors.exited",
  "runtime-process-management-failed": "runtime.errors.processManagementFailed",
  "runtime-output-unavailable": "runtime.errors.outputUnavailable",
  "runtime-process-status-failed": "runtime.errors.processStatusFailed",
  "runtime-output-closed": "runtime.errors.outputClosed",
  "runtime-health-check-failed": "runtime.errors.healthCheckFailed",
  "runtime-credential-channel-failed": "runtime.errors.credentialChannelFailed",
  "runtime-task-failed": "runtime.errors.taskFailed",
  "restart-limit-reached": "runtime.errors.restartLimitReached"
};
const settingsRecoveryKeys = {
  corrupt: "settings.recovered.corrupt",
  future: "settings.recovered.future"
} as const;
const runtimeDescription = computed(() => {
  if (!runtime.value.errorCode) return t("runtime.detail");
  return `${runtime.value.errorCode}: ${t(runtimeErrorKeys[runtime.value.errorCode] || "error.unexpected")}`;
});
const aboutChannel = computed(() => {
  const key = {
    local: "about.local",
    community: "about.community",
    stable: "about.stable"
  }[about.value?.channel || ""];
  return key ? t(key) : about.value?.channel || "-";
});
const aboutSignature = computed(() => about.value?.signedRelease ? t("about.signed") : t("about.unsigned"));
const updateDescription = computed(() => {
  if (!update.value) return t("update.notChecked");
  const messageKey = {
    "updates-disabled": "update.disabled",
    "signed-updater-not-configured": "update.notConfigured",
    "update-available": "update.available",
    "update-ignored": "update.ignored",
    "check-skipped": "update.skipped",
    "up-to-date": "update.current"
  }[update.value.message] || "update.current";
  return t(messageKey, { version: update.value.availableVersion || "" });
});
const runtimeUpdateDescription = computed(() => {
  if (!runtimeUpdate.value) return t("runtimeUpdate.messages.idle");
  const key = `runtimeUpdate.messages.${runtimeUpdate.value.message.replaceAll("-", "_")}`;
  return t(key, {
    version: runtimeUpdate.value.availableVersion || runtimeUpdate.value.pendingVersion || ""
  });
});
const canDownloadRuntime = computed(() => runtimeUpdate.value?.phase === "available" && !busy.value);
const runtimeRepositoryDraft = ref({
  repository: appConfig.harness.repository
});
const runtimeRepositoryComplete = computed(() => runtimeRepositoryDraft.value.repository.trim().length > 0);
const runtimeRepositoryDirty = computed(() =>
  runtimeRepositoryDraft.value.repository !== (
    settings.value.runtimeUpdateRepository || appConfig.harness.repository
  )
);

function syncRuntimeRepositoryDraft(): void {
  runtimeRepositoryDraft.value = {
    repository: settings.value.runtimeUpdateRepository || appConfig.harness.repository
  };
}

async function persistSettings(): Promise<void> {
  settings.value = await saveSettings(settings.value);
}

function navigate(next: ViewName): void {
  notice.value = "";
  view.value = next;
}

async function selectLocale(value: Event): Promise<void> {
  const next = (value.target as HTMLSelectElement).value as SupportedLocale;
  const previous = settings.value.locale;
  locale.value = next;
  settings.value.locale = next;
  try {
    await persistSettings();
  } catch {
    locale.value = previous;
    settings.value.locale = previous;
    notice.value = t("error.settingsSaveFailed");
  }
}

async function startFromStatus(clearNotice = true): Promise<void> {
  busy.value = true;
  if (clearNotice) notice.value = "";
  try {
    runtime.value = await startRuntime();
    await showWorkbench();
  } catch {
    notice.value = t("error.unexpected");
  } finally {
    busy.value = false;
  }
}

async function showWorkbench(): Promise<void> {
  if (runtime.value.phase !== "ready" || workbenchVisible.value || workbenchOpening) return;
  workbenchOpening = true;
  try {
    await openWorkbench();
  } catch {
    notice.value = t("error.unexpected");
  } finally {
    workbenchOpening = false;
  }
}

async function closeSettings(): Promise<void> {
  if (runtime.value.phase !== "ready") return;
  await showWorkbench();
}

async function showDesktopMenu(menu: DesktopMenuName, anchorX: number): Promise<void> {
  if (desktopMenuOpening) return;
  desktopMenuOpening = true;
  try {
    await openDesktopMenu(menu, anchorX);
  } catch {
    notice.value = t("error.menuOpenFailed");
  } finally {
    desktopMenuOpening = false;
  }
}

function handleSettingsKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && updatePromptVisible.value) {
    event.preventDefault();
    updatePromptVisible.value = false;
    return;
  }
  const closeSettingsShortcut = event.key.toLowerCase() === "w"
    && (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey;
  if ((event.key === "Escape" || closeSettingsShortcut)
    && !workbenchVisible.value
    && runtime.value.phase === "ready") {
    event.preventDefault();
    void closeSettings();
  }
}

async function stop(): Promise<void> {
  busy.value = true;
  try {
    runtime.value = await stopRuntime();
  } catch {
    notice.value = t("error.unexpected");
  } finally {
    busy.value = false;
  }
}

async function exportBundle(): Promise<void> {
  try {
    const path = await exportDiagnostics();
    notice.value = path ? `${t("diagnostics.exported")}: ${path}` : t("diagnostics.exported");
  } catch {
    notice.value = t("error.diagnosticsExportFailed");
  }
}

async function exportLogFile(): Promise<void> {
  try {
    const path = await exportLogs();
    notice.value = path ? `${t("diagnostics.logsExported")}: ${path}` : t("diagnostics.logsExported");
  } catch {
    notice.value = t("error.logsExportFailed");
  }
}

function formatPublishedAt(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function checkUpdate(silent = false): Promise<void> {
  try {
    update.value = await checkForUpdates(silent);
    settings.value = await getSettings();
    updatePromptVisible.value = update.value.message === "update-available" && Boolean(update.value.releaseTag);
    if (!silent) notice.value = updateDescription.value;
  } catch {
    if (!silent) notice.value = t("error.updateCheckFailed");
  }
}

async function downloadDesktopUpdate(): Promise<void> {
  if (!update.value?.releaseTag) return;
  try {
    await openDesktopRelease(update.value.releaseTag);
    updatePromptVisible.value = false;
    await closeSettings();
  } catch {
    notice.value = t("error.updateOpenFailed");
  }
}

async function deferDesktopUpdate(): Promise<void> {
  updatePromptVisible.value = false;
  await closeSettings();
}

async function ignoreAvailableDesktopUpdate(): Promise<void> {
  if (!update.value?.availableVersion) return;
  try {
    settings.value = await ignoreDesktopUpdate(update.value.availableVersion);
    update.value.message = "update-ignored";
    updatePromptVisible.value = false;
    await closeSettings();
  } catch {
    notice.value = t("error.settingsSaveFailed");
  }
}

async function checkRuntime(): Promise<void> {
  busy.value = true;
  try {
    runtimeUpdate.value = await checkRuntimeUpdate();
    notice.value = runtimeUpdateDescription.value;
  } catch {
    notice.value = t("error.runtimeUpdateCheckFailed");
  } finally {
    busy.value = false;
  }
}

async function downloadRuntime(): Promise<void> {
  busy.value = true;
  try {
    runtimeUpdate.value = await downloadRuntimeUpdate();
    notice.value = runtimeUpdateDescription.value;
  } catch {
    notice.value = t("error.runtimeUpdateDownloadFailed");
  } finally {
    busy.value = false;
  }
}

async function restoreRuntime(): Promise<void> {
  busy.value = true;
  try {
    runtimeUpdate.value = await restoreBundledRuntime();
    about.value = await getAbout();
    notice.value = runtimeUpdateDescription.value;
  } catch {
    notice.value = t("error.runtimeRestoreFailed");
  } finally {
    busy.value = false;
  }
}

async function selectRuntimeUpdateMode(value: Event): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const previous = settings.value.runtimeUpdateMode;
  settings.value.runtimeUpdateMode = (value.target as HTMLSelectElement).value as DesktopSettings["runtimeUpdateMode"];
  try {
    await persistSettings();
    runtimeUpdate.value = await getRuntimeUpdateStatus();
  } catch {
    settings.value.runtimeUpdateMode = previous;
    notice.value = t("error.settingsSaveFailed");
  } finally {
    busy.value = false;
  }
}

async function selectRuntimeUpdateChannel(value: Event): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const previous = settings.value.runtimeUpdateChannel;
  settings.value.runtimeUpdateChannel = (value.target as HTMLSelectElement).value as DesktopSettings["runtimeUpdateChannel"];
  try {
    await persistSettings();
    runtimeUpdate.value = await getRuntimeUpdateStatus();
  } catch {
    settings.value.runtimeUpdateChannel = previous;
    notice.value = t("error.settingsSaveFailed");
  } finally {
    busy.value = false;
  }
}

async function saveRuntimeRepository(): Promise<void> {
  if (busy.value || !runtimeRepositoryComplete.value) return;
  busy.value = true;
  const previous = { ...settings.value };
  try {
    const repository = runtimeRepositoryDraft.value.repository.trim();
    const official = repository === appConfig.harness.repository;
    settings.value.runtimeUpdateRepository = official ? null : repository;
    await persistSettings();
    syncRuntimeRepositoryDraft();
    runtimeUpdate.value = await getRuntimeUpdateStatus();
    notice.value = t("runtimeUpdate.repositorySaved");
  } catch {
    settings.value = previous;
    syncRuntimeRepositoryDraft();
    notice.value = t("error.runtimeRepositoryFailed");
  } finally {
    busy.value = false;
  }
}

async function toggleRuntimePin(value: Event): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const previous = settings.value.runtimePinnedVersion;
  settings.value.runtimePinnedVersion = (value.target as HTMLInputElement).checked
    ? runtimeUpdate.value?.currentVersion || about.value?.runtimeVersion || null
    : null;
  try {
    await persistSettings();
    runtimeUpdate.value = await getRuntimeUpdateStatus();
  } catch {
    settings.value.runtimePinnedVersion = previous;
    notice.value = t("error.settingsSaveFailed");
  } finally {
    busy.value = false;
  }
}

async function visitRepository(): Promise<void> {
  try {
    await openRepository();
  } catch {
    notice.value = t("error.unexpected");
  }
}

onMounted(async () => {
  if (menuOnly) {
    try {
      unlistenLocale = await onDesktopLocale(next => {
        locale.value = normalizeLocale(next);
      });
      locale.value = normalizeLocale((await getSettings()).locale);
    } catch {
      // Keep the navigator locale when the dedicated menu cannot read Shell settings.
    }
    return;
  }
  window.addEventListener("keydown", handleSettingsKeydown);
  try {
    [settings.value, runtime.value, about.value, runtimeUpdate.value] = await Promise.all([
      getSettings(),
      getRuntimeStatus(),
      getAbout(),
      getRuntimeUpdateStatus()
    ]);
    locale.value = settings.value.locale;
  syncRuntimeRepositoryDraft();
    if (settings.value.recoveryReason) {
      notice.value = t(settingsRecoveryKeys[settings.value.recoveryReason]);
    }
  } catch {
    notice.value = t("error.initializationFailed");
    return;
  }
  try {
    unlisten = await onRuntimeStatus(status => {
      runtime.value = status;
      if (status.phase === "ready") void showWorkbench();
    });
    unlistenSurface = await onDesktopSurface(surface => {
      workbenchVisible.value = surface === "workbench";
    });
    unlistenSettingsView = await onDesktopSettingsView(next => {
      if (next === "desktop-update") {
        navigate("update");
        void checkUpdate(false);
      } else {
        navigate(next);
      }
    });
    unlistenRuntimeUpdate = await onRuntimeUpdateStatus(status => {
      runtimeUpdate.value = status;
    });
  } catch {
    notice.value = t("error.eventChannelFailed");
  }
  if (runtime.value.phase === "ready") {
    await showWorkbench();
  } else if (runtime.value.phase === "idle") {
    await startFromStatus(false);
  }
  void checkUpdate(true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleSettingsKeydown);
  unlisten?.();
  unlistenSurface?.();
  unlistenSettingsView?.();
  unlistenRuntimeUpdate?.();
  unlistenLocale?.();
});
</script>

<template>
  <main v-if="menuOnly" class="desktop-menu-only">
    <DesktopMenuBar @open="showDesktopMenu" />
  </main>
  <main v-else class="desktop-shell" :class="{ 'workbench-surface': workbenchVisible }">
    <DesktopMenuBar @open="showDesktopMenu" />
    <div class="desktop-surface">
    <section v-show="!workbenchVisible" class="settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="topbar">
      <div class="brand">
        <img class="brand-mark" :src="deepSeekDesktopLogo" alt="" aria-hidden="true" />
        <span>
          <strong id="settings-title">{{ t("navigation.settings") }}</strong>
          <small>{{ t("app.name") }}</small>
        </span>
      </div>
      <div class="topbar-actions">
        <select class="locale-select" :value="locale" :aria-label="t('common.languageSelector')" @change="selectLocale">
          <option value="zh-CN">简体中文</option>
          <option value="zh-TW">繁體中文</option>
          <option value="en-US">English</option>
        </select>
        <button
          v-if="runtime.phase === 'ready'"
          class="icon-button"
          type="button"
          :aria-label="t('navigation.closeSettings')"
          :title="t('navigation.closeSettings')"
          @click="closeSettings"
        >×</button>
      </div>
      </header>

    <section class="workspace-layout">
      <nav class="side-nav" :aria-label="t('navigation.label')">
        <button :class="{ active: view === 'runtime' }" @click="navigate('runtime')">
          <span aria-hidden="true">01</span>{{ t("navigation.runtime") }}
        </button>
        <button :class="{ active: view === 'diagnostics' }" @click="navigate('diagnostics')">
          <span aria-hidden="true">02</span>{{ t("navigation.diagnostics") }}
        </button>
        <button :class="{ active: view === 'update' }" @click="navigate('update')">
          <span aria-hidden="true">03</span>{{ t("navigation.update") }}
        </button>
        <button :class="{ active: view === 'about' }" @click="navigate('about')">
          <span aria-hidden="true">04</span>{{ t("navigation.about") }}
        </button>
      </nav>

      <section class="content" aria-live="polite">
        <template v-if="view === 'runtime'">
          <div class="section-heading">
            <span class="eyebrow">{{ t("runtime.supervisor") }}</span>
            <h1>{{ phaseLabel }}</h1>
            <p>{{ runtimeDescription }}</p>
          </div>
          <div class="runtime-panel" :data-phase="runtime.phase">
            <div class="pulse" aria-hidden="true"></div>
            <dl>
              <div><dt>{{ t("runtime.state") }}</dt><dd>{{ phaseLabel }}</dd></div>
              <div><dt>{{ t("runtime.origin") }}</dt><dd>{{ runtime.url || "-" }}</dd></div>
              <div><dt>{{ t("runtime.restarts") }}</dt><dd>{{ runtime.restartCount }}</dd></div>
              <div v-if="runtime.diagnosticId"><dt>{{ t("runtime.diagnosticId") }}</dt><dd>{{ runtime.diagnosticId }}</dd></div>
            </dl>
          </div>
          <footer class="actions">
            <button v-if="runtime.phase === 'ready'" class="button primary" @click="showWorkbench">{{ t("common.open") }}</button>
            <button v-if="runtime.phase === 'ready'" class="button secondary" :disabled="busy" @click="stop">{{ t("common.stop") }}</button>
            <button v-else-if="runtime.phase === 'failed' || runtime.phase === 'idle'" class="button primary" :disabled="busy" @click="startFromStatus()">{{ runtimeStartLabel }}</button>
            <button v-else class="button primary" disabled>{{ phaseLabel }}</button>
          </footer>
        </template>

        <template v-else-if="view === 'diagnostics'">
          <div class="section-heading">
            <span class="eyebrow">{{ t("diagnostics.eyebrow") }}</span>
            <h1>{{ t("diagnostics.title") }}</h1>
            <p>{{ t("diagnostics.description") }}</p>
          </div>
          <div class="plain-list">
            <div><span>{{ t("diagnostics.runtime") }}</span><strong>{{ phaseLabel }}</strong></div>
            <div><span>{{ t("runtime.diagnosticId") }}</span><strong>{{ runtime.diagnosticId || "-" }}</strong></div>
          </div>
          <footer class="actions">
            <button class="button secondary" @click="exportLogFile">{{ t("diagnostics.exportLogs") }}</button>
            <button class="button primary" @click="exportBundle">{{ t("diagnostics.export") }}</button>
          </footer>
        </template>

        <template v-else-if="view === 'update'">
          <div class="section-heading">
            <span class="eyebrow">{{ t("update.eyebrow") }}</span>
            <h1>{{ t("update.title") }}</h1>
            <p>{{ t("update.description") }}</p>
          </div>
          <h2 class="subsection-title">{{ t("update.desktopTitle") }}</h2>
          <div class="plain-list compact-list">
            <div><span>{{ t("update.currentVersion") }}</span><strong>{{ about?.desktopVersion || "-" }}</strong></div>
            <div><span>{{ t("update.channel") }}</span><strong>{{ aboutChannel }}</strong></div>
            <div><span>{{ t("update.status") }}</span><strong>{{ updateDescription }}</strong></div>
          </div>
          <footer class="actions">
            <button class="button secondary" @click="checkUpdate(false)">{{ t("update.check") }}</button>
          </footer>
          <h2 class="subsection-title">{{ t("runtimeUpdate.title") }}</h2>
          <div v-if="runtimeUpdate" class="plain-list compact-list">
            <div><span>{{ t("runtimeUpdate.currentVersion") }}</span><strong>{{ runtimeUpdate.currentVersion }}</strong></div>
            <div><span>{{ t("runtimeUpdate.source") }}</span><strong>{{ t(`runtimeUpdate.sources.${runtimeUpdate.currentSource}`) }}</strong></div>
            <div><span>{{ t("runtimeUpdate.commit") }}</span><code>{{ runtimeUpdate.currentCommit.slice(0, 12) }}</code></div>
            <div><span>{{ t("runtimeUpdate.status") }}</span><strong>{{ runtimeUpdateDescription }}</strong></div>
            <div>
              <label for="runtime-update-repository">{{ t("runtimeUpdate.repository") }}</label>
              <input id="runtime-update-repository" v-model="runtimeRepositoryDraft.repository" class="setting-input" type="text" inputmode="url" spellcheck="false" :disabled="busy" :placeholder="t('runtimeUpdate.repositoryPlaceholder')" />
            </div>
            <div class="runtime-source-save">
              <span>{{ t("runtimeUpdate.repositoryHelp") }}</span>
              <button class="button secondary" :disabled="busy || !runtimeRepositoryDirty || !runtimeRepositoryComplete" @click="saveRuntimeRepository">{{ t("runtimeUpdate.saveRepository") }}</button>
            </div>
            <div>
              <label for="runtime-update-mode">{{ t("runtimeUpdate.mode") }}</label>
              <select id="runtime-update-mode" class="setting-select" :value="settings.runtimeUpdateMode" :disabled="busy" @change="selectRuntimeUpdateMode">
                <option value="automatic">{{ t("runtimeUpdate.modes.automatic") }}</option>
                <option value="notify">{{ t("runtimeUpdate.modes.notify") }}</option>
                <option value="manual">{{ t("runtimeUpdate.modes.manual") }}</option>
              </select>
            </div>
            <div>
              <label for="runtime-update-channel">{{ t("runtimeUpdate.channel") }}</label>
              <select id="runtime-update-channel" class="setting-select" :value="settings.runtimeUpdateChannel" :disabled="busy" @change="selectRuntimeUpdateChannel">
                <option value="stable">{{ t("runtimeUpdate.channels.stable") }}</option>
                <option value="preview">{{ t("runtimeUpdate.channels.preview") }}</option>
              </select>
            </div>
            <div>
              <span>{{ t("runtimeUpdate.pin") }}</span>
              <label class="toggle-label"><input type="checkbox" :checked="Boolean(settings.runtimePinnedVersion)" :disabled="busy" @change="toggleRuntimePin" />{{ t("runtimeUpdate.pinCurrent") }}</label>
            </div>
          </div>
          <footer class="actions wrap-actions">
            <button class="button secondary" :disabled="busy" @click="restoreRuntime">{{ t("runtimeUpdate.restoreBundled") }}</button>
            <button class="button secondary" :disabled="busy || !runtimeUpdate?.enabled" @click="checkRuntime">{{ t("runtimeUpdate.check") }}</button>
            <button class="button primary" :disabled="!canDownloadRuntime" @click="downloadRuntime">{{ t("runtimeUpdate.download") }}</button>
          </footer>
        </template>

        <template v-else>
          <div class="section-heading">
            <span class="eyebrow">{{ t("about.eyebrow") }}</span>
            <h1>{{ t("about.title") }}</h1>
            <p>{{ aboutSignature }}</p>
          </div>
          <div v-if="about" class="plain-list">
            <div><span>{{ t("about.desktopVersion") }}</span><strong>{{ about.desktopVersion }}</strong></div>
            <div><span>{{ t("about.runtimeVersion") }}</span><strong>{{ about.runtimeVersion }}</strong></div>
            <div><span>{{ t("about.nodeVersion") }}</span><strong>{{ about.nodeVersion }}</strong></div>
            <div><span>{{ t("about.channel") }}</span><strong>{{ aboutChannel }}</strong></div>
            <div><span>{{ t("about.author") }}</span><strong>{{ about.authors }}</strong></div>
            <div>
              <span>{{ t("about.repository") }}</span>
              <button class="repository-link" type="button" @click="visitRepository">{{ about.repository }}</button>
            </div>
          </div>
        </template>

        <p v-if="notice" class="notice">{{ notice }}</p>
      </section>
    </section>
      <div v-if="updatePromptVisible && update" class="desktop-update-backdrop">
        <section class="desktop-update-prompt" role="alertdialog" aria-modal="true" aria-labelledby="desktop-update-title">
          <div class="desktop-update-heading">
            <div>
              <span class="eyebrow">{{ t("update.desktopTitle") }}</span>
              <h2 id="desktop-update-title">{{ t("update.promptTitle", { version: update.availableVersion || "" }) }}</h2>
            </div>
            <span v-if="update.prerelease" class="release-badge">{{ t("update.prerelease") }}</span>
          </div>
          <dl class="desktop-update-meta">
            <div><dt>{{ t("update.publishedAt") }}</dt><dd>{{ formatPublishedAt(update.publishedAt) }}</dd></div>
            <div><dt>{{ t("update.summary") }}</dt><dd class="update-notes">{{ update.releaseNotes || t("update.noSummary") }}</dd></div>
          </dl>
          <p class="community-update-notice">{{ t("update.communityNotice") }}</p>
          <footer class="actions wrap-actions">
            <button class="button secondary" @click="ignoreAvailableDesktopUpdate">{{ t("update.ignoreVersion") }}</button>
            <button class="button secondary" @click="deferDesktopUpdate">{{ t("update.later") }}</button>
            <button class="button primary" @click="downloadDesktopUpdate">{{ t("update.download") }}</button>
          </footer>
        </section>
      </div>
    </section>
    </div>
  </main>
</template>
