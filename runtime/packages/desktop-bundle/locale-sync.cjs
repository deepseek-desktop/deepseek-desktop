const { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { parseDocument } = require("yaml");

const localeMap = {
  "zh-CN": "zh",
  "zh-TW": "zh",
  "en-US": "en"
};

const desktopLocale = process.env.DEEPSEEK_HARNESS_DESKTOP_LOCALE;
const harnessLocale = localeMap[desktopLocale];
const dshHome = process.env.DSH_HOME;

if (!harnessLocale) throw new Error(`desktop locale is unsupported: ${desktopLocale ?? "<missing>"}`);
if (!dshHome) throw new Error("DSH_HOME is not configured");

const settingsPath = join(dshHome, "settings.yaml");
const temporaryPath = join(dirname(settingsPath), ".settings.yaml.desktop.tmp");
const document = parseDocument(existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "");
if (document.errors.length > 0) {
  throw new Error(`settings.yaml is invalid: ${document.errors[0].message}`);
}

document.setIn(["locale", "preference"], harnessLocale);
let descriptor;
try {
  writeFileSync(temporaryPath, document.toString(), { encoding: "utf8", mode: 0o600 });
  descriptor = openSync(temporaryPath, "r+");
  fsyncSync(descriptor);
  closeSync(descriptor);
  descriptor = undefined;
  renameSync(temporaryPath, settingsPath);
} finally {
  if (descriptor !== undefined) closeSync(descriptor);
  if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
}
