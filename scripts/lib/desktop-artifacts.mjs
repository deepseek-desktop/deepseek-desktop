const artifactSuffixes = Object.freeze({
  "aarch64-apple-darwin": "aarch64.dmg",
  "x86_64-apple-darwin": "x64.dmg",
  "x86_64-pc-windows-msvc": "x64-setup.exe"
});

export function desktopArtifactName({ productName, version, target, extension }) {
  if (!productName?.trim() || !version?.trim()) throw new Error("productName and version are required");
  let suffix = artifactSuffixes[target];
  if (target === "x86_64-unknown-linux-gnu") {
    if (!new Set([".AppImage", ".deb"]).has(extension)) {
      throw new Error(`unsupported Linux artifact extension ${extension}`);
    }
    suffix = `amd64${extension}`;
  }
  if (typeof extension !== "string" || !suffix || !suffix.endsWith(extension)) {
    throw new Error(`unsupported Desktop artifact ${target} ${extension}`);
  }
  return `${productName}_${version}_${suffix}`;
}
