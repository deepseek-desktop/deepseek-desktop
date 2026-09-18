function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePath(value, packageName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`native package has an invalid executable path: ${packageName}`);
  }
  return value;
}

function declaredArtifact(kind, path, files, packageName) {
  const resolvedPath = requirePath(path, packageName);
  const sha256 = files[resolvedPath];
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error(`native package ${kind} has no SHA-256 declaration: ${packageName}/${resolvedPath}`);
  }
  return { kind, path: resolvedPath, sha256 };
}

/**
 * Normalize the two native-package metadata formats published by the official
 * Harness projects. System launchers use `binaries`; LibreOffice Kit uses the
 * versioned `engine` plus per-file SHA-256 declarations. Linux intentionally
 * receives the portable WASM engine because no Linux native package exists.
 */
export function prebuildArtifactDeclarations(prebuilds, packageName) {
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
    return [declaredArtifact("native-engine", prebuilds.engine.executable, prebuilds.files, packageName)];
  }
  if (prebuilds.schemaVersion === 1
    && isRecord(prebuilds.engine)
    && prebuilds.engine.kind === "wasm"
    && isRecord(prebuilds.files)) {
    return ["loader", "wasm", "data", "metadata"].map(field =>
      declaredArtifact("wasm-engine-file", prebuilds.engine[field], prebuilds.files, packageName)
    );
  }
  throw new Error(`native package has no supported executable declarations: ${packageName}`);
}

export function assertPrebuildPlatform(prebuilds, artifacts, acceptedPlatforms, packageName) {
  const portableWasm = prebuilds.platform === "wasm"
    && artifacts.length > 0
    && artifacts.every(artifact => artifact.kind === "wasm-engine-file");
  if (portableWasm || acceptedPlatforms.has(prebuilds.platform)) return;
  throw new Error(
    `native package platform mismatch: ${packageName} declares ${String(prebuilds.platform)}, expected one of ${[...acceptedPlatforms].join(", ")}`
  );
}
