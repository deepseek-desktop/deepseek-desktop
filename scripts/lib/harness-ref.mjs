const versionTagPattern = /^(?:dsh-)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined || right[index] === undefined) return left[index] === undefined ? -1 : 1;
    const leftNumber = /^\d+$/u.test(left[index]);
    const rightNumber = /^\d+$/u.test(right[index]);
    if (leftNumber && rightNumber) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) return difference;
      continue;
    }
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    const difference = left[index].localeCompare(right[index], "en");
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseVersionTag(tag) {
  const match = versionTagPattern.exec(tag.trim());
  if (!match) return null;
  return {
    tag: tag.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? []
  };
}

function compareVersions(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    const difference = left[field] - right[field];
    if (difference !== 0) return difference;
  }
  return comparePrerelease(left.prerelease, right.prerelease)
    || left.tag.localeCompare(right.tag, "en");
}

export function selectLatestHarnessTag(tags) {
  const versions = tags.map(parseVersionTag).filter(Boolean).sort(compareVersions);
  if (versions.length === 0) {
    throw new Error("RUNTIME_REF is empty and the Runtime repository has no SemVer release tags");
  }
  return versions.at(-1).tag;
}
