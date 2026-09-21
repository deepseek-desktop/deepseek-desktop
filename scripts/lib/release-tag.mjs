const desktopVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.([1-9]\d*)$/u;

export function parseDesktopVersion(value) {
  const version = value?.trim() ?? "";
  const match = desktopVersionPattern.exec(version);
  if (!match) throw new Error(`unsupported Desktop version: ${version || "<empty>"}`);
  const coreVersion = match.slice(1, 4).join(".");
  const revision = Number(match[4]);
  if (!Number.isSafeInteger(revision)) throw new Error(`unsupported Desktop version: ${version}`);
  return Object.freeze({
    version,
    coreVersion,
    revision,
    bundleVersion: `${coreVersion}+${revision}`
  });
}

export function parseReleaseTag(value) {
  const tag = value?.trim() ?? "";
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  try {
    parseDesktopVersion(version);
  } catch {
    throw new Error(`unsupported release tag: ${tag || "<empty>"}`);
  }
  return { tag, version };
}

export function releaseTagsForVersion(version) {
  try {
    parseDesktopVersion(version);
  } catch {
    throw new Error(`unsupported release version: ${version || "<empty>"}`);
  }
  return [version, `v${version}`];
}

export function isPrereleaseVersion(version) {
  try {
    parseDesktopVersion(version);
  } catch {
    throw new Error(`unsupported release version: ${version || "<empty>"}`);
  }
  return false;
}
