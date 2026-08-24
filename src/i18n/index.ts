import { createI18n } from "vue-i18n";
import { messages } from "./messages";

export type SupportedLocale = keyof typeof messages;

export function normalizeLocale(value: string | undefined): SupportedLocale {
  const locale = value?.replace("_", "-").toLowerCase();
  if (locale === "zh-tw" || locale === "zh-hk" || locale === "zh-hant") return "zh-TW";
  if (locale?.startsWith("en")) return "en-US";
  return "zh-CN";
}

export const i18n = createI18n({
  legacy: false,
  locale: normalizeLocale(navigator.language),
  fallbackLocale: "zh-CN",
  messages
});
