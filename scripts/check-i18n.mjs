import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/i18n/messages.ts", import.meta.url), "utf8");
const executable = source
  .replace(/^import \{ appConfig \} from "\.\.\/app-config";\s*$/mu, "")
  .replace(/^const appName = appConfig\.productName;\s*$/mu, 'const appName = "Application";')
  .replace(/^export const messages = /mu, "globalThis.__messages = ");
const context = {};
vm.runInNewContext(ts.transpileModule(executable, {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
}).outputText, context);
const messages = context.__messages;
if (!messages || typeof messages !== "object") throw new Error("could not evaluate i18n messages");

function flatten(value, prefix = "", output = new Map()) {
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof nested === "string") output.set(path, nested);
    else flatten(nested, path, output);
  }
  return output;
}

const locales = Object.keys(messages);
const baseline = flatten(messages[locales[0]]);
const failures = [];

const sourceFile = ts.createSourceFile("messages.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function propertyName(node) {
  if (!node.name) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) return node.name.text;
  return undefined;
}
function visit(node, path = "messages") {
  if (ts.isObjectLiteralExpression(node)) {
    const names = new Set();
    for (const property of node.properties) {
      const name = propertyName(property);
      if (name && names.has(name)) failures.push(`${path}: duplicate ${name}`);
      if (name) names.add(name);
      if (ts.isPropertyAssignment(property)) visit(property.initializer, `${path}.${name ?? "?"}`);
    }
  }
  ts.forEachChild(node, child => visit(child, path));
}
visit(sourceFile);

for (const locale of locales) {
  const entries = flatten(messages[locale]);
  for (const key of baseline.keys()) if (!entries.has(key)) failures.push(`${locale}: missing ${key}`);
  for (const key of entries.keys()) if (!baseline.has(key)) failures.push(`${locale}: unexpected ${key}`);
  for (const [key, value] of entries) if (value.trim() === "") failures.push(`${locale}: empty ${key}`);
}

const appSource = await readFile(new URL("../src/App.vue", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("../src-tauri/src/runtime.rs", import.meta.url), "utf8");
const script = appSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? "";
const template = appSource.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? "";
const referencedKeys = new Set();
const appScript = ts.createSourceFile("App.vue.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function collectReferencedKeys(node) {
  if (ts.isStringLiteral(node) && /^[a-z][\w-]*(?:\.[\w-]+)+$/u.test(node.text)) {
    referencedKeys.add(node.text);
  }
  ts.forEachChild(node, collectReferencedKeys);
}
collectReferencedKeys(appScript);
for (const match of template.matchAll(/\bt\(\s*["']([^"']+)["']/gu)) referencedKeys.add(match[1]);
for (const key of referencedKeys) {
  if (!baseline.has(key)) failures.push(`App.vue: referenced i18n key is missing: ${key}`);
}

const runtimeCodePattern = /"(runtime-[a-z-]+|restart-limit-reached)"/gu;
const nonErrorRuntimeLiterals = new Set(["runtime-bin", "runtime-update"]);
const emittedRuntimeCodes = new Set(
  [...runtimeSource.matchAll(runtimeCodePattern)]
    .map(match => match[1])
    .filter(code => !nonErrorRuntimeLiterals.has(code))
);
const mappedRuntimeCodes = new Set(
  [...script.matchAll(/^\s*"(runtime-[a-z-]+|restart-limit-reached)":\s*"runtime\.errors\.[^"]+",?$/gmu)]
    .map(match => match[1])
);
for (const code of emittedRuntimeCodes) {
  if (!mappedRuntimeCodes.has(code)) failures.push(`App.vue: Runtime error code is not mapped: ${code}`);
}
for (const code of mappedRuntimeCodes) {
  if (!emittedRuntimeCodes.has(code)) failures.push(`App.vue: stale Runtime error mapping: ${code}`);
}
const allowedText = new Set(["DSH", "简体中文", "繁體中文", "English"]);
let textBuffer = "";
for (let index = 0; index < template.length;) {
  if (template[index] !== "<") {
    textBuffer += template[index++];
    continue;
  }
  const visible = textBuffer.replace(/\{\{[\s\S]*?\}\}/g, "").trim();
  if (visible && /[A-Za-z\u3400-\u9fff]/.test(visible) && !allowedText.has(visible)) {
    failures.push(`App.vue: hardcoded visible text ${JSON.stringify(visible)}`);
  }
  textBuffer = "";
  let quote = "";
  let end = index + 1;
  for (; end < template.length; end += 1) {
    const character = template[end];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      break;
    }
  }
  const tag = template.slice(index, end + 1);
  for (const match of tag.matchAll(/\s(?:aria-label|title|placeholder)="([^"]+)"/g)) {
    failures.push(`App.vue: hardcoded visible attribute ${JSON.stringify(match[1])}`);
  }
  index = end + 1;
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`i18n parity passed: ${locales.length} locales, ${baseline.size} keys`);
}
