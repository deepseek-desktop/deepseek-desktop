<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { appConfig } from "./app-config";
import { openDesktopUpdateLink } from "./desktop";
import { releaseNoteUrl, renderReleaseNotes } from "./release-notes";

const props = defineProps<{ notes: string; releaseTag: string }>();
const { t } = useI18n();
const openFailed = ref(false);
const html = computed(() => renderReleaseNotes(
  props.notes,
  `${appConfig.repository}/releases/tag/${encodeURIComponent(props.releaseTag)}`
));
watch(() => props.notes, () => { openFailed.value = false; });

async function openLink(event: MouseEvent): Promise<void> {
  if (event.button !== 0 && event.button !== 1) return;
  const anchor = event.target instanceof Element ? event.target.closest("a") : null;
  if (!anchor) return;
  event.preventDefault();
  const url = releaseNoteUrl(anchor.getAttribute("href") || "");
  if (!url) return;
  openFailed.value = false;
  try {
    await openDesktopUpdateLink(url);
  } catch {
    openFailed.value = true;
  }
}
</script>

<template>
  <div class="release-notes">
    <div class="update-notes" tabindex="0" role="region" :aria-label="t('update.summary')" @click="openLink" @auxclick="openLink" v-html="html" />
    <p v-if="openFailed" class="notice" role="alert">{{ t("error.updateLinkOpenFailed") }}</p>
  </div>
</template>
