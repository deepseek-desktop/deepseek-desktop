import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import { parseReleaseTag } from "./lib/release-tag.mjs";

const root = resolve(import.meta.dirname, "..");
const DOWNLOADS_MARKER = "<!-- release-downloads -->";
const CHANGES_MARKER = "<!-- release-changes -->";

function downloadUrl(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export function communityReleaseAssetNames(version) {
  return [
    `DeepSeek.Desktop_${version}_aarch64.dmg`,
    `DeepSeek.Desktop_${version}_x64.dmg`,
    `DeepSeek.Desktop_${version}_x64-setup.exe`,
    `DeepSeek.Desktop_${version}_amd64.AppImage`,
    `DeepSeek.Desktop_${version}_amd64.deb`,
    "SHA256SUMS"
  ];
}

export function unreleasedChanges(changelog) {
  const match = /(?:^|\n)## 未发布[^\S\r\n]*\r?\n([\s\S]*?)(?=\r?\n##[^\S\r\n]|$)/u.exec(changelog);
  const changes = match?.[1]?.trim();
  if (!changes || !changes.split("\n").some(line => /^-\s+/u.test(line))) {
    throw new Error("CHANGELOG must contain non-empty unreleased changes");
  }
  return changes;
}

export function prepareCommunityReleaseNotes({ template, repository, tag, assetNames, changes }) {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository || "")) throw new Error("GitHub repository must use owner/name format");
  const { version } = parseReleaseTag(tag);
  const expected = communityReleaseAssetNames(version);
  const actual = [...assetNames].sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error("release notes require the complete public asset set");
  }
  if (template.split(DOWNLOADS_MARKER).length !== 2) {
    throw new Error("community release notes must contain one download marker");
  }
  if (template.split(CHANGES_MARKER).length !== 2) {
    throw new Error("community release notes must contain one changes marker");
  }
  if (typeof changes !== "string" || changes.trim().length === 0) {
    throw new Error("community release notes require release changes");
  }

  const links = [
    ["macOS Apple 芯片", expected[0]],
    ["macOS Intel", expected[1]],
    ["Windows x64", expected[2]],
    ["Linux x64 AppImage", expected[3]],
    ["Linux x64 DEB", expected[4]],
    ["SHA-256 校验文件", expected[5]]
  ].map(([label, name]) => `| ${label} | [${name}](${downloadUrl(repository, tag, name)}) |`).join("\n");

  const downloads = `## 下载与安装\n\n| 平台 / 用途 | 文件 |\n| --- | --- |\n${links}\n\n安装前请核对同版本 SHA256SUMS。GitHub 自动生成的 Source code 是源码，不是安装包。[安装与校验步骤](https://github.com/${repository}/blob/HEAD/README.md#下载安装)。`;
  const releaseChanges = `## 更新内容\n\n${changes.trim()}`;
  const body = template.replace(DOWNLOADS_MARKER, downloads).replace(CHANGES_MARKER, releaseChanges).trim();
  return `${body}\n\n**本版源码：** [${tag}](https://github.com/${repository}/tree/${encodeURIComponent(tag)})\n`;
}

export async function prepareCommunityReleaseNotesFile({ templatePath, changelogPath, assetsPath, outputPath, repository, tag }) {
  const entries = await readdir(assetsPath, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile())) throw new Error("public release assets must only contain files");
  const notes = prepareCommunityReleaseNotes({
    template: await readFile(templatePath, "utf8"),
    repository,
    tag,
    assetNames: entries.map(entry => entry.name),
    changes: unreleasedChanges(await readFile(changelogPath, "utf8"))
  });
  await writeFile(outputPath, notes);
  return outputPath;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const output = await prepareCommunityReleaseNotesFile({
    templatePath: process.env.CI_RELEASE_NOTES_TEMPLATE || join(root, ".github", "release-notes-community.md"),
    changelogPath: process.env.CI_RELEASE_CHANGELOG || join(root, "CHANGELOG.md"),
    assetsPath: process.env.CI_RELEASE_ASSETS_OUTPUT || join(root, "release-assets", "publish"),
    outputPath: process.env.CI_RELEASE_NOTES_OUTPUT || join(root, "release-assets", "RELEASE-NOTES.md"),
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME
  });
  console.log(`prepared release notes at ${basename(output)}`);
}
