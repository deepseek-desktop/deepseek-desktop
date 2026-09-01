import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import { parseReleaseTag } from "./lib/release-tag.mjs";

const root = resolve(import.meta.dirname, "..");
const DOWNLOADS_MARKER = "<!-- release-downloads -->";

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

export function prepareCommunityReleaseNotes({ template, repository, tag, assetNames }) {
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

  const links = [
    ["macOS Apple 芯片 / Apple Silicon", expected[0]],
    ["macOS Intel", expected[1]],
    ["Windows x64", expected[2]],
    ["Linux x64 AppImage", expected[3]],
    ["Linux x64 DEB", expected[4]],
    ["SHA-256 校验文件 / checksums", expected[5]]
  ].map(([label, name]) => `- [${label}](${downloadUrl(repository, tag, name)})`).join("\n");

  const downloads = `## 直接下载 / Direct downloads\n\n${links}`;
  return template.replace(DOWNLOADS_MARKER, downloads);
}

export async function prepareCommunityReleaseNotesFile({ templatePath, assetsPath, outputPath, repository, tag }) {
  const entries = await readdir(assetsPath, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile())) throw new Error("public release assets must only contain files");
  const notes = prepareCommunityReleaseNotes({
    template: await readFile(templatePath, "utf8"),
    repository,
    tag,
    assetNames: entries.map(entry => entry.name)
  });
  await writeFile(outputPath, notes);
  return outputPath;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const output = await prepareCommunityReleaseNotesFile({
    templatePath: process.env.CI_RELEASE_NOTES_TEMPLATE || join(root, ".github", "release-notes-community.md"),
    assetsPath: process.env.CI_RELEASE_ASSETS_OUTPUT || join(root, "release-assets", "publish"),
    outputPath: process.env.CI_RELEASE_NOTES_OUTPUT || join(root, "release-assets", "RELEASE-NOTES.md"),
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME
  });
  console.log(`prepared release notes at ${basename(output)}`);
}
