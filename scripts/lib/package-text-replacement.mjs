import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function resolvePackageFile(directory, moduleFile) {
  if (typeof moduleFile !== "string" || !moduleFile || isAbsolute(moduleFile)) {
    throw new Error("package replacement moduleFile must be a non-empty relative path");
  }
  const packageRoot = resolve(directory);
  const target = resolve(packageRoot, moduleFile);
  const packageRelativePath = relative(packageRoot, target);
  if (!packageRelativePath || packageRelativePath === ".." || packageRelativePath.startsWith(`..${sep}`)) {
    throw new Error(`package replacement path escapes package root: ${moduleFile}`);
  }
  return target;
}

export function applyPackageTextReplacements(directory, moduleFile, replacements) {
  if (!Array.isArray(replacements) || replacements.length === 0) {
    throw new Error("package text replacement requires at least one replacement");
  }

  const target = resolvePackageFile(directory, moduleFile);
  let contents = readFileSync(target, "utf8");
  let changed = false;

  for (const [index, replacement] of replacements.entries()) {
    const before = replacement?.before;
    const after = replacement?.after;
    if (typeof before !== "string" || !before || typeof after !== "string" || !after || before === after) {
      throw new Error(`package text replacement ${String(index)} is invalid`);
    }

    const beforeCount = countOccurrences(contents, before);
    const afterCount = countOccurrences(contents, after);
    if (beforeCount === 1 && afterCount === 0) {
      contents = contents.replace(before, after);
      changed = true;
      continue;
    }
    if (beforeCount === 0 && afterCount === 1) continue;

    throw new Error(
      `package text replacement ${String(index)} is ambiguous in ${moduleFile}: before=${String(beforeCount)}, after=${String(afterCount)}`
    );
  }

  if (changed) writeFileSync(target, contents);
  return changed ? "applied" : "already-applied";
}
