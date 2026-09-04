<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import DesktopMenuBar from "./DesktopMenuBar.vue";
import { appConfig } from "./app-config";
import deepSeekDesktopLogo from "./assets/deepseek-desktop.svg";
import type { DesktopAbout, DesktopSettings, DesktopSettingsView, HarnessStatus, HarnessUpdateStatus, UpdateStatus } from "./contracts";
import {
  checkHarnessUpdate,
  checkForUpdates,
  downloadHarnessUpdate,
  exportDiagnostics,
  exportLogs,
  getAbout,
  getHarnessStatus,
  getHarnessUpdateStatus,
  getSettings,
  ignoreDesktopUpdate,
  onDesktopLocale,
  onDesktopSettingsView,
  onDesktopSurface,
  onHarnessStatus,
  onHarnessUpdateStatus,
  openDesktopMenu,
  openDesktopRelease,
  openWorkbench,
  openRepository,
  restoreBundledHarness,
  saveSettings,
  startHarness,
  stopHarness
} from "./desktop";
import type { DesktopMenuName } from "./desktop";
import { normalizeLocale, type SupportedLocale } from "./i18n";

type ViewName = Exclude<DesktopSettingsView, "desktop-update">;

const { locale, t } = useI18n();
const menuOnly = Boolean((window as Window & {
  __DEEPSEEK_DESKTOP_MENU_ONLY__?: boolean;
}).__DEEPSEEK_DESKTOP_MENU_ONLY__);
const view = ref<ViewName>("harness");
const busy = ref(false);
const notice = ref("");
const harness = ref<HarnessStatus>({
  phase: "idle",
  url: null,
  restartCount: 0,
  diagnosticId: null,
  errorCode: null
});
const settings = ref<DesktopSettings>({
  schemaVersion: 7,
  locale: normalizeLocale(navigator.language),
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false,
  harnessUpdateChannel: "stable",
  harnessUpdateMode: "notify",
  harnessUpdateRepository: null,
  harnessPinnedVersion: null,
  desktopUpdateLastCheckAt: null,
  desktopUpdateIgnoredVersion: null,
  recoveryReason: null
});
const about = ref<DesktopAbout | null>(null);
const update = ref<UpdateStatus | null>(null);
const harnessUpdate = ref<HarnessUpdateStatus | null>(null);
let unlisten: (() => void) | undefined;
let unlistenSurface: (() => void) | undefined;
let unlistenSettingsView: (() => void) | undefined;
let unlistenHarnessUpdate: (() => void) | undefined;
let unlistenLocale: (() => void) | undefined;
const workbenchVisible = ref(false);
const updatePromptVisible = ref(false);
let workbenchOpening = false;
let desktopMenuOpening = false;

const phaseLabel = computed(() => t(`harness.${harness.value.phase}`));
const harnessStartLabel = computed(() => harness.value.phase === "failed" ? t("common.retry") : t("common.start"));
const harnessErrorKeys: Record<string, string> = {
  "harness-artifact-missing": "harness.errors.artifactMissing",
  "harness-workdir-unavailable": "harness.errors.workdirUnavailable",
  "harness-profile-prepare-failed": "harness.errors.profilePrepareFailed",
  "harness-helper-unavailable": "harness.errors.helperUnavailable",
  "harness-credential-session-failed": "harness.errors.credentialSessionFailed",
  "harness-environment-failed": "harness.errors.environmentFailed",
  "harness-timeout": "harness.errors.timeout",
  "harness-exited": "harness.errors.exited",
  "harness-process-management-failed": "harness.errors.processManagementFailed",
  "harness-output-unavailable": "harness.errors.outputUnavailable",
  "harness-process-status-failed": "harness.errors.processStatusFailed",
  "harness-output-closed": "harness.errors.outputClosed",
  "harness-health-check-failed": "harness.errors.healthCheckFailed",
  "harness-credential-channel-failed": "harness.errors.credentialChannelFailed",
  "harness-task-failed": "harness.errors.taskFailed",
  "restart-limit-reached": "harness.errors.restartLimitReached"
};
const settingsRecoveryKeys = {
  corrupt: "settings.recovered.corrupt",
  future: "settings.recovered.future"
} as const;
const harnessDescription = computed(() => {
  if (!harness.value.errorCode) return t("harness.detail");
  return `${harness.value.errorCode}: ${t(harnessErrorKeys[harness.value.errorCode] || "error.unexpected")}`;
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
const harnessUpdateDescription = computed(() => {
  if (!harnessUpdate.value) return t("harnessUpdate.messages.idle");
  const key = `harnessUpdate.messages.${harnessUpdate.value.message.replaceAll("-", "_")}`;
  return t(key, {
    version: harnessUpdate.value.availableVersion || harnessUpdate.value.pendingVersion || ""
  });
});
const canDownloadHarness = computed(() => harnessUpdate.value?.phase === "available" && !busy.value);
const harnessRepositoryDraft = ref({
  repository: appConfig.harness.repository
});
const harnessRepositoryComplete = computed(() => harnessRepositoryDraft.value.repository.trim().length > 0);
const harnessRepositoryDirty = computed(() =>
  harnessRepositoryDraft.value.repository !== (
    settings.value.harnessUpdateRepository || appConfig.harness.repository
  )
);

function syncHarnessRepositoryDraft(): void {
  harnessRepositoryDraft.value = {
    repository: settings.value.harnessUpdateRepository || appConfig.harness.repository
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
    harness.value = await startHarness();
    await showWorkbench();
  } catch {
    notice.value = t("error.unexpected");
  } finally {
    busy.value = false;
  }
}

async function showWorkbench(): Promise<void> {
  if (harness.value.phase !== "ready" || workbenchVisible.value || workbenchOpening) return;
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
  if (harness.value.phase !== "ready") return;
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
    && harness.value.phase === "ready") {
    event.preventDefault();
    void closeSettings();
  }
}

async function stop(): Promise<void> {
  busy.value = true;
  try {
    harness.value = await stopHarness();
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

async function checkHarness(): Promise<void> {
  busy.value = true;
  try {
    harnessUpdate.value = await checkHarnessUpdate();
    notice.value = harnessUpdateDescription.value;
  } catch {
    notice.value = t("error.harnessUpdateCheckFailed");
  } finally {
    busy.value = false;
  }
}

async function downloadHarness(): Promise<void> {
  busy.value = true;
  try {
    harnessUpdate.value = await downloadHarnessUpdate();
    notice.value = harnessUpdateDescription.value;
  } catch {
    notice.value = t("error.harnessUpdateDownloadFailed");
  } finally {
    busy.value = false;
  }
}

async function restoreHarness(): Promise<void> {
  busy.value = true;
  try {
    harnessUpdate.value = await restoreBundledHarness();
    about.value = await getAbout();
    notice.value = harnessUpdateDescription.value;
  } catch {
    notice.value = t("error.harnessRestoreFailed");
  } finally {
    busy.value = false;
  }
}

async function selectHarnessUpdateMode(value: Event): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const previous = settings.value.harnessUpdateMode;
  settings.value.harnessUpdateMode = (value.target as HTMLSelectElement).value as DesktopSettings["harnessUpdateMode"];
  try {
    await persistSettings();
    harnessUpdate.value = await getHarnessUpdateStatus();
  } catch {
    settings.value.harnessUpdateMode = previous;
    notice.value = t("error.settingsSaveFailed");
  } finally {
    busy.value = false;
  }
}

async function selectHarnessUpdateChannel(value: Event): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const previous = settings.value.harnessUpdateChannel;
  settings.value.harnessUpdateChannel = (value.target as HTMLSelectElement).value as DesktopSettings["harnessUpdateChannel"];
  try {
    await persistSettings();
    harnessUpdate.value = await getHarnessUpdateStatus();
  } catch {
    settings.value.harnessUpdateChannel = previous;
    notice.value = t("error.settingsSaveFailed");
  } finally {
    busy.value = false;
  }
}

async function saveHarnessRepository(): Promise<void> {
  if (busy.value || !harnessRepositoryComplete.value) return;
  busy.value = true;
  const previous = { ...settings.value };
  try {
    const repository = harnessRepositoryDraft.value.repository.trim();
    const official = repository === appConfig.harness.repository;
    settings.value.harnessUpdateRepository = official ? null : repository;
    await persistSettings();
    syncHarnessRepositoryDraft();
    harnessUpdate.value = await getHarnessUpdateStatus();
    notice.value = t("harnessUpdate.repositorySaved");
  } catch {
    settings.value = previous;
    syncHarnessRepositoryDraft();
    notice.value = t("error.harnessRepositoryFailed");
  } finally {
    busy.value = false;
  }
}

async function toggleHarnessPin(value: Event): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const previous = settings.value.harnessPinnedVersion;
  settings.value.harnessPinnedVersion = (value.target as HTMLInputElement).checked
    ? harnessUpdate.value?.currentVersion || about.value?.harnessVersion || null
    : null;
  try {
    await persistSettings();
    harnessUpdate.value = await getHarnessUpdateStatus();
  } catch {
    settings.value.harnessPinnedVersion = previous;
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
    [settings.value, harness.value, about.value, harnessUpdate.value] = await Promise.all([
      getSettings(),
      getHarnessStatus(),
      getAbout(),
      getHarnessUpdateStatus()
    ]);
    locale.value = settings.value.locale;
  syncHarnessRepositoryDraft();
    if (settings.value.recoveryReason) {
      notice.value = t(settingsRecoveryKeys[settings.value.recoveryReason]);
    }
  } catch {
    notice.value = t("error.initializationFailed");
    return;
  }
  try {
    unlisten = await onHarnessStatus(status => {
      harness.value = status;
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
    unlistenHarnessUpdate = await onHarnessUpdateStatus(status => {
      harnessUpdate.value = status;
    });
  } catch {
    notice.value = t("error.eventChannelFailed");
  }
  if (harness.value.phase === "ready") {
    await showWorkbench();
  } else if (harness.value.phase === "idle") {
    await startFromStatus(false);
  }
  void checkUpdate(true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleSettingsKeydown);
  unlisten?.();
  unlistenSurface?.();
  unlistenSettingsView?.();
  unlistenHarnessUpdate?.();
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
          v-if="harness.phase === 'ready'"
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
        <button :class="{ active: view === 'harness' }" @click="navigate('harness')">
          <span aria-hidden="true">01</span>{{ t("navigation.harness") }}
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
        <template v-if="view === 'harness'">
          <div class="section-heading">
            <span class="eyebrow">{{ t("harness.supervisor") }}</span>
            <h1>{{ phaseLabel }}</h1>
            <p>{{ harnessDescription }}</p>
          </div>
          <div class="harness-panel" :data-phase="harness.phase">
            <div class="pulse" aria-hidden="true"></div>
            <dl>
              <div><dt>{{ t("harness.state") }}</dt><dd>{{ phaseLabel }}</dd></div>
              <div><dt>{{ t("harness.origin") }}</dt><dd>{{ harness.url || "-" }}</dd></div>
              <div><dt>{{ t("harness.restarts") }}</dt><dd>{{ harness.restartCount }}</dd></div>
              <div v-if="harness.diagnosticId"><dt>{{ t("harness.diagnosticId") }}</dt><dd>{{ harness.diagnosticId }}</dd></div>
            </dl>
          </div>
          <footer class="actions">
            <button v-if="harness.phase === 'ready'" class="button primary" @click="showWorkbench">{{ t("common.open") }}</button>
            <button v-if="harness.phase === 'ready'" class="button secondary" :disabled="busy" @click="stop">{{ t("common.stop") }}</button>
            <button v-else-if="harness.phase === 'failed' || harness.phase === 'idle'" class="button primary" :disabled="busy" @click="startFromStatus()">{{ harnessStartLabel }}</button>
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
            <div><span>{{ t("diagnostics.harness") }}</span><strong>{{ phaseLabel }}</strong></div>
            <div><span>{{ t("harness.diagnosticId") }}</span><strong>{{ harness.diagnosticId || "-" }}</strong></div>
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
          <h2 class="subsection-title">{{ t("harnessUpdate.title") }}</h2>
          <div v-if="harnessUpdate" class="plain-list compact-list">
            <div><span>{{ t("harnessUpdate.currentVersion") }}</span><strong>{{ harnessUpdate.currentVersion }}</strong></div>
            <div><span>{{ t("harnessUpdate.source") }}</span><strong>{{ t(`harnessUpdate.sources.${harnessUpdate.currentSource}`) }}</strong></div>
            <div><span>{{ t("harnessUpdate.commit") }}</span><code>{{ harnessUpdate.currentCommit.slice(0, 12) }}</code></div>
            <div><span>{{ t("harnessUpdate.status") }}</span><strong>{{ harnessUpdateDescription }}</strong></div>
            <div>
              <label for="harness-update-repository">{{ t("harnessUpdate.repository") }}</label>
              <input id="harness-update-repository" v-model="harnessRepositoryDraft.repository" class="setting-input" type="text" inputmode="url" spellcheck="false" :disabled="busy" :placeholder="t('harnessUpdate.repositoryPlaceholder')" />
            </div>
            <div class="harness-source-save">
              <span>{{ t("harnessUpdate.repositoryHelp") }}</span>
              <button class="button secondary" :disabled="busy || !harnessRepositoryDirty || !harnessRepositoryComplete" @click="saveHarnessRepository">{{ t("harnessUpdate.saveRepository") }}</button>
            </div>
            <div>
              <label for="harness-update-mode">{{ t("harnessUpdate.mode") }}</label>
              <select id="harness-update-mode" class="setting-select" :value="settings.harnessUpdateMode" :disabled="busy" @change="selectHarnessUpdateMode">
                <option value="automatic">{{ t("harnessUpdate.modes.automatic") }}</option>
                <option value="notify">{{ t("harnessUpdate.modes.notify") }}</option>
                <option value="manual">{{ t("harnessUpdate.modes.manual") }}</option>
              </select>
            </div>
            <div>
              <label for="harness-update-channel">{{ t("harnessUpdate.channel") }}</label>
              <select id="harness-update-channel" class="setting-select" :value="settings.harnessUpdateChannel" :disabled="busy" @change="selectHarnessUpdateChannel">
                <option value="stable">{{ t("harnessUpdate.channels.stable") }}</option>
                <option value="preview">{{ t("harnessUpdate.channels.preview") }}</option>
              </select>
            </div>
            <div>
              <span>{{ t("harnessUpdate.pin") }}</span>
              <label class="toggle-label"><input type="checkbox" :checked="Boolean(settings.harnessPinnedVersion)" :disabled="busy" @change="toggleHarnessPin" />{{ t("harnessUpdate.pinCurrent") }}</label>
            </div>
          </div>
          <footer class="actions wrap-actions">
            <button class="button secondary" :disabled="busy" @click="restoreHarness">{{ t("harnessUpdate.restoreBundled") }}</button>
            <button class="button secondary" :disabled="busy || !harnessUpdate?.enabled" @click="checkHarness">{{ t("harnessUpdate.check") }}</button>
            <button class="button primary" :disabled="!canDownloadHarness" @click="downloadHarness">{{ t("harnessUpdate.download") }}</button>
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
            <div><span>{{ t("about.harnessVersion") }}</span><strong>{{ about.harnessVersion }}</strong></div>
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
