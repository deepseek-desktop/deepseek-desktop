import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { parse } from "yaml";

const script = resolve(import.meta.dirname, "../packages/desktop-bundle/locale-sync.cjs");
const root = await mkdtemp(join(tmpdir(), "dsh-desktop-locale-"));
const settings = join(root, "settings.yaml");

function run(locale) {
  return spawnSync(process.execPath, [script], {
    env: { DSH_HOME: root, DSH_DESKTOP_LOCALE: locale },
    encoding: "utf8"
  });
}

try {
  await writeFile(settings, "# keep this comment\nllm:\n  provider: mock\nlocale:\n  preference: en\n", "utf8");
  assert.equal(run("zh-TW").status, 0);
  let text = await readFile(settings, "utf8");
  assert.match(text, /# keep this comment/u);
  assert.deepEqual(parse(text), { llm: { provider: "mock" }, locale: { preference: "zh" } });

  assert.equal(run("en-US").status, 0);
  text = await readFile(settings, "utf8");
  assert.deepEqual(parse(text), { llm: { provider: "mock" }, locale: { preference: "en" } });

  assert.notEqual(run("ja-JP").status, 0);
  console.log("Desktop locale bridge passed: zh-CN/zh-TW -> zh, en-US -> en");
} finally {
  await rm(root, { recursive: true, force: true });
}
