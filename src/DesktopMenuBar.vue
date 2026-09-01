<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DesktopMenuName } from "./desktop";

const emit = defineEmits<{
  open: [menu: DesktopMenuName, anchorX: number];
}>();

const { t } = useI18n();
const menuNames: DesktopMenuName[] = ["file", "edit", "view", "window", "help"];
const menuButtons = ref<HTMLButtonElement[]>([]);
const activeIndex = ref(0);

function registerButton(element: unknown, index: number): void {
  if (element instanceof HTMLButtonElement) menuButtons.value[index] = element;
}

function focusMenu(index: number): void {
  const next = (index + menuNames.length) % menuNames.length;
  activeIndex.value = next;
  menuButtons.value[next]?.focus();
}

function openMenu(index: number): void {
  const button = menuButtons.value[index];
  if (!button) return;
  activeIndex.value = index;
  emit("open", menuNames[index], button.getBoundingClientRect().left);
}

function handleMenuKeydown(event: KeyboardEvent, index: number): void {
  switch (event.key) {
    case "ArrowLeft":
      event.preventDefault();
      focusMenu(index - 1);
      break;
    case "ArrowRight":
      event.preventDefault();
      focusMenu(index + 1);
      break;
    case "Home":
      event.preventDefault();
      focusMenu(0);
      break;
    case "End":
      event.preventDefault();
      focusMenu(menuNames.length - 1);
      break;
    case "ArrowDown":
    case "Enter":
    case " ":
      event.preventDefault();
      openMenu(index);
      break;
  }
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key === "F10" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    focusMenu(0);
    return;
  }
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const index = ["f", "e", "v", "w", "h"].indexOf(event.key.toLowerCase());
  if (index < 0) return;
  event.preventDefault();
  focusMenu(index);
  openMenu(index);
}

onMounted(() => window.addEventListener("keydown", handleWindowKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", handleWindowKeydown));
</script>

<template>
  <nav class="desktop-menu-bar" role="menubar" :aria-label="t('menu.label')">
    <button
      v-for="(menu, index) in menuNames"
      :key="menu"
      :ref="element => registerButton(element, index)"
      class="desktop-menu-trigger"
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      :aria-keyshortcuts="`Alt+${['F', 'E', 'V', 'W', 'H'][index]}`"
      :tabindex="activeIndex === index ? 0 : -1"
      @click="openMenu(index)"
      @focus="activeIndex = index"
      @keydown="handleMenuKeydown($event, index)"
    >{{ t(`menu.${menu}`) }}</button>
  </nav>
</template>
