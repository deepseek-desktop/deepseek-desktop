import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const RUST_PATH_REMAP_VERSION = 1;

function remap(source, destination) {
  return source ? `--remap-path-prefix=${resolve(source)}=${destination}` : "";
}

export function portableRustFlags({
  projectRoot,
  cargoTargetDir,
  defaultCargoTargetDir = join(projectRoot, "src-tauri", "target"),
  userHome = homedir(),
  existing = ""
}) {
  return [
    existing,
    cargoTargetDir !== defaultCargoTargetDir ? remap(cargoTargetDir, "/build/cargo-target") : "",
    remap(projectRoot, "/build/source"),
    remap(userHome, "/build/home")
  ].filter(Boolean).join(" ");
}
