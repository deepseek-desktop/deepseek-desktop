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

/**
 * Check one staged native artifact's file mode and manifest record.
 *
 * Split out of the Harness verifier because the POSIX execute bit has no NTFS equivalent and
 * the assertions kept failing on Windows for reasons that had nothing to do with the artifact:
 * Node reports no execute bit there, and the stager records no mode at all. Both platforms are
 * covered by tests here so the next platform difference is caught before a release matrix.
 * @param artifact - one declaration from {@link prebuildArtifactDeclarations}.
 * @param fileMode - the staged file's mode, or undefined where the filesystem carries none.
 * @param record - the Harness manifest entry for the staged path.
 * @param context - `stagedPath` for messages and `executableBitIsMeaningful` for the platform.
 * @throws Error naming the artifact and what is missing.
 */
export function assertNativeArtifactModes(artifact, fileMode, record, context) {
  const { stagedPath, executableBitIsMeaningful } = context;
  if (record === undefined) {
    throw new Error(`Harness manifest omits the native artifact: ${stagedPath}`);
  }
  // A WASM module is loaded, never executed, so it carries no execute bit on any platform.
  if (artifact.kind === "wasm-engine-file" || !executableBitIsMeaningful) return;
  if (!Number.isInteger(fileMode) || (fileMode & 0o111) === 0) {
    throw new Error(`native package launcher is not executable: ${stagedPath}`);
  }
  if (!Number.isInteger(record.mode) || (record.mode & 0o111) === 0) {
    throw new Error(`Harness manifest omits the executable mode for native launcher: ${stagedPath}`);
  }
}
