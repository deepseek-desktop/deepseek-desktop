function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePath(value, packageName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`native package has an invalid executable path: ${packageName}`);
  }
  return value;
}

/**
 * Normalize the two native-package metadata formats published by the official
 * Harness projects. System launchers use `binaries`; LibreOffice Kit uses the
 * versioned `engine` plus per-file SHA-256 declarations.
 */
export function nativeExecutableDeclarations(prebuilds, packageName) {
  if (!isRecord(prebuilds)) {
    throw new Error(`native package has invalid prebuild metadata: ${packageName}`);
  }
  if (Array.isArray(prebuilds.binaries)) {
    return prebuilds.binaries.map(binary => {
      if (!isRecord(binary)) {
        throw new Error(`native package has an invalid binary declaration: ${packageName}`);
      }
      return { ...binary, path: requirePath(binary.path, packageName) };
    });
  }
  if (prebuilds.schemaVersion === 1
    && isRecord(prebuilds.engine)
    && prebuilds.engine.kind === "native"
    && isRecord(prebuilds.files)) {
    const path = requirePath(prebuilds.engine.executable, packageName);
    const sha256 = prebuilds.files[path];
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error(`native package engine executable has no SHA-256 declaration: ${packageName}/${path}`);
    }
    return [{ kind: "native-engine", path, sha256 }];
  }
  throw new Error(`native package has no supported executable declarations: ${packageName}`);
}
