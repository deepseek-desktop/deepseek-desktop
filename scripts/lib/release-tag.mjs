const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export function parseReleaseTag(value) {
  const tag = value?.trim() ?? "";
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!semverPattern.test(version)) {
    throw new Error(`unsupported release tag: ${tag || "<empty>"}`);
  }
  return { tag, version };
}

export function releaseTagsForVersion(version) {
  if (!semverPattern.test(version)) throw new Error(`unsupported release version: ${version || "<empty>"}`);
  return [version, `v${version}`];
}

export function isPrereleaseVersion(version) {
  if (!semverPattern.test(version)) throw new Error(`unsupported release version: ${version || "<empty>"}`);
  return version.split("+", 1)[0].includes("-");
}
