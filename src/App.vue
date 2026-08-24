<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DesktopAbout, DesktopSettings, RuntimeStatus, UpdateStatus } from "./contracts";
import {
  checkForUpdates,
  chooseWorkspace,
  exportDiagnostics,
  getAbout,
  getRuntimeStatus,
  getSettings,
  onRuntimeStatus,
  openHarness,
  restartRuntime,
  saveSettings,
  startRuntime,
  stopRuntime
} from "./desktop";
import { normalizeLocale, type SupportedLocale } from "./i18n";

type ViewName = "onboarding" | "runtime" | "diagnostics" | "update" | "about";

const { locale, t } = useI18n();
const view = ref<ViewName>("onboarding");
const onboardingStep = ref(0);
const busy = ref(false);
const notice = ref("");
const runtime = ref<RuntimeStatus>({
  phase: "idle",
  url: null,
  workspace: null,
  restartCount: 0,
  diagnosticId: null,
  errorCode: null
});
const settings = ref<DesktopSettings>({
  schemaVersion: 1,
  locale: normalizeLocale(navigator.language),
  theme: "system",
  workspace: null,
  onboardingCompleted: false,
  updateChannel: "community",
  updateEnabled: false
});
const about = ref<DesktopAbout | null>(null);
const update = ref<UpdateStatus | null>(null);
let unlisten: (() => void) | undefined;

const phaseLabel = computed(() => t(`runtime.${runtime.value.phase}`));
const runtimeErrorKeys: Record<string, string> = {
  "runtime-artifact-missing": "runtime.errors.artifactMissing",
  "runtime-timeout": "runtime.errors.timeout",
  "runtime-exited": "runtime.errors.exited",
  "runtime-output-closed": "runtime.errors.outputClosed",
  "runtime-health-check-failed": "runtime.errors.healthCheckFailed",
  "runtime-credential-channel-failed": "runtime.errors.credentialChannelFailed",
  "restart-limit-reached": "runtime.errors.restartLimitReached"
};
const runtimeDescription = computed(() => {
  if (!runtime.value.errorCode) return t("runtime.detail");
  return `${runtime.value.errorCode}: ${t(runtimeErrorKeys[runtime.value.errorCode] || "error.unexpected")}`;
});
const aboutChannel = computed(() => about.value?.channel === "community" ? t("about.community") : about.value?.channel || "-");
const updateDescription = computed(() => {
  if (!update.value) return t("update.notChecked");
  const messageKey = {
    "updates-disabled": "update.disabled",
    "signed-updater-not-configured": "update.notConfigured",
    "update-available": "update.available",
    "up-to-date": "update.current"
  }[update.value.message] || "update.current";
  return t(messageKey, { version: update.value.availableVersion || "" });
});
const canStart = computed(() => Boolean(settings.value.workspace) && !busy.value);

async function persistSettings(): Promise<void> {
  settings.value = await saveSettings(settings.value);
}

async function selectLocale(value: Event): Promise<void> {
  const next = (value.target as HTMLSelectElement).value as SupportedLocale;
  locale.value = next;
  settings.value.locale = next;
  await persistSettings();
}

async function selectWorkspace(): Promise<void> {
  const selected = await chooseWorkspace(t("onboarding.chooseWorkspace"));
  if (!selected) return;
  settings.value.workspace = selected;
  await persistSettings();
  notice.value = "";
}

async function launch(): Promise<void> {
  if (!settings.value.workspace) {
    notice.value = t("error.workspaceRequired");
    onboardingStep.value = 1;
    return;
  }
  busy.value = true;
  notice.value = "";
  try {
    runtime.value = await startRuntime(settings.value.workspace);
    settings.value.onboardingCompleted = true;
    await persistSettings();
    view.value = "runtime";
  } catch {
    notice.value = t("error.unexpected");
    view.value = "runtime";
  } finally {
    busy.value = false;
  }
}

async function retry(): Promise<void> {
  busy.value = true;
  try {
    runtime.value = await restartRuntime();
  } catch {
    notice.value = t("error.unexpected");
  } finally {
    busy.value = false;
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
  const path = await exportDiagnostics();
  notice.value = path ? `${t("diagnostics.exported")}: ${path}` : t("diagnostics.exported");
}

async function checkUpdate(): Promise<void> {
  update.value = await checkForUpdates();
  notice.value = updateDescription.value;
}

onMounted(async () => {
  [settings.value, runtime.value, about.value] = await Promise.all([
    getSettings(),
    getRuntimeStatus(),
    getAbout()
  ]);
  locale.value = settings.value.locale;
  view.value = settings.value.onboardingCompleted ? "runtime" : "onboarding";
  unlisten = await onRuntimeStatus(status => {
    runtime.value = status;
  });
});

onBeforeUnmount(() => unlisten?.());
</script>

<template>
  <main class="desktop-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">DSH</span>
        <span>
          <strong>{{ t("app.name") }}</strong>
          <small>{{ t("app.subtitle") }}</small>
        </span>
      </div>
      <select class="locale-select" :value="locale" :aria-label="t('common.languageSelector')" @change="selectLocale">
        <option value="zh-CN">简体中文</option>
        <option value="zh-TW">繁體中文</option>
        <option value="en-US">English</option>
      </select>
    </header>

    <section class="workspace-layout">
      <nav class="side-nav" :aria-label="t('navigation.label')">
        <button :class="{ active: view === 'onboarding' }" @click="view = 'onboarding'">
          <span aria-hidden="true">01</span>{{ t("navigation.onboarding") }}
        </button>
        <button :class="{ active: view === 'runtime' }" @click="view = 'runtime'">
          <span aria-hidden="true">02</span>{{ t("navigation.runtime") }}
        </button>
        <button :class="{ active: view === 'diagnostics' }" @click="view = 'diagnostics'">
          <span aria-hidden="true">03</span>{{ t("navigation.diagnostics") }}
        </button>
        <button :class="{ active: view === 'update' }" @click="view = 'update'">
          <span aria-hidden="true">04</span>{{ t("navigation.update") }}
        </button>
        <button :class="{ active: view === 'about' }" @click="view = 'about'">
          <span aria-hidden="true">05</span>{{ t("navigation.about") }}
        </button>
      </nav>

      <section class="content" aria-live="polite">
        <template v-if="view === 'onboarding'">
          <div class="section-heading">
            <span class="eyebrow">{{ String(onboardingStep + 1).padStart(2, "0") }} / 03</span>
            <h1>{{ t(["onboarding.welcomeTitle", "onboarding.workspaceTitle", "onboarding.modelTitle"][onboardingStep]) }}</h1>
            <p>{{ t(["onboarding.welcomeDescription", "onboarding.workspaceDescription", "onboarding.modelDescription"][onboardingStep]) }}</p>
          </div>

          <div v-if="onboardingStep === 0" class="feature-grid">
            <div><strong>{{ t("features.runtime") }}</strong><span>{{ t("features.runtimeValue") }}</span></div>
            <div><strong>{{ t("features.keychain") }}</strong><span>{{ t("features.keychainValue") }}</span></div>
            <div><strong>{{ t("features.workspace") }}</strong><span>{{ t("features.workspaceValue") }}</span></div>
          </div>

          <div v-else-if="onboardingStep === 1" class="workspace-picker">
            <div>
              <strong>{{ settings.workspace || t("onboarding.workspacePlaceholder") }}</strong>
              <small>{{ t("onboarding.workspaceDescription") }}</small>
            </div>
            <button class="button secondary" @click="selectWorkspace">{{ t("onboarding.chooseWorkspace") }}</button>
          </div>

          <div v-else class="model-step">
            <span class="status-dot"></span>
            <div>
              <strong>{{ t("onboarding.modelTitle") }}</strong>
              <p>{{ t("onboarding.modelDescription") }}</p>
            </div>
          </div>

          <footer class="actions">
            <button v-if="onboardingStep > 0" class="button secondary" @click="onboardingStep -= 1">{{ t("common.back") }}</button>
            <button v-if="onboardingStep < 2" class="button primary" @click="onboardingStep += 1">{{ t("common.continue") }}</button>
            <button v-else class="button primary" :disabled="!canStart" @click="launch">{{ t("onboarding.start") }}</button>
          </footer>
        </template>

        <template v-else-if="view === 'runtime'">
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
              <div><dt>{{ t("runtime.workspace") }}</dt><dd>{{ runtime.workspace || settings.workspace || "-" }}</dd></div>
              <div><dt>{{ t("runtime.restarts") }}</dt><dd>{{ runtime.restartCount }}</dd></div>
              <div v-if="runtime.diagnosticId"><dt>{{ t("runtime.diagnosticId") }}</dt><dd>{{ runtime.diagnosticId }}</dd></div>
            </dl>
          </div>
          <footer class="actions">
            <button v-if="runtime.phase === 'ready'" class="button primary" @click="openHarness">{{ t("common.open") }}</button>
            <button v-if="runtime.phase === 'ready'" class="button secondary" :disabled="busy" @click="stop">{{ t("common.stop") }}</button>
            <button v-else class="button primary" :disabled="busy" @click="retry">{{ t("common.retry") }}</button>
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
            <div><span>{{ t("diagnostics.workspace") }}</span><strong>{{ runtime.workspace || settings.workspace || "-" }}</strong></div>
          </div>
          <footer class="actions">
            <button class="button primary" @click="exportBundle">{{ t("diagnostics.export") }}</button>
          </footer>
        </template>

        <template v-else-if="view === 'update'">
          <div class="section-heading">
            <span class="eyebrow">{{ t("update.eyebrow") }}</span>
            <h1>{{ t("update.title") }}</h1>
            <p>{{ t("update.description") }}</p>
          </div>
          <div class="plain-list">
            <div><span>{{ t("update.currentVersion") }}</span><strong>{{ about?.desktopVersion || "-" }}</strong></div>
            <div><span>{{ t("update.channel") }}</span><strong>{{ aboutChannel }}</strong></div>
            <div><span>{{ t("update.status") }}</span><strong>{{ updateDescription }}</strong></div>
          </div>
          <footer class="actions">
            <button class="button secondary" @click="checkUpdate">{{ t("update.check") }}</button>
          </footer>
        </template>

        <template v-else>
          <div class="section-heading">
            <span class="eyebrow">{{ t("about.eyebrow") }}</span>
            <h1>{{ t("about.title") }}</h1>
            <p>{{ t("about.unsigned") }}</p>
          </div>
          <div v-if="about" class="plain-list">
            <div><span>{{ t("about.desktopVersion") }}</span><strong>{{ about.desktopVersion }}</strong></div>
            <div><span>{{ t("about.harnessVersion") }}</span><strong>{{ about.harnessVersion }}</strong></div>
            <div><span>{{ t("about.nodeVersion") }}</span><strong>{{ about.nodeVersion }}</strong></div>
            <div><span>{{ t("about.channel") }}</span><strong>{{ aboutChannel }}</strong></div>
          </div>
        </template>

        <p v-if="notice" class="notice">{{ notice }}</p>
      </section>
    </section>
  </main>
</template>
