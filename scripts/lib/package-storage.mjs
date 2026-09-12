import { rm, statfs } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

const GIBIBYTE = 1024 ** 3;

function isHostedLinux(platform, environment) {
  return platform === "linux" && environment.GITHUB_ACTIONS === "true";
}

function gibibytes(bytes) {
  return `${(bytes / GIBIBYTE).toFixed(2)} GiB`;
}

async function availableBytes(path, readFilesystem = statfs) {
  const filesystem = await readFilesystem(path, { bigint: true });
  return Number(filesystem.bavail * filesystem.bsize);
}

/**
 * The hosted Linux release runs debug verification and the optimized Tauri
 * build in one job. Cargo cannot reuse debug objects for the release profile,
 * and the verified upstream sync cache is no longer needed after Harness staging.
 * Reclaim those two transient trees before linuxdeploy duplicates the AppDir.
 */
export async function reclaimHostedLinuxPackagingSpace({
  projectRoot,
  platform = process.platform,
  environment = process.env,
  remove = rm,
  readFilesystem = statfs,
  log = console.log
} = {}) {
  if (!projectRoot || !isAbsolute(projectRoot)) {
    throw new Error("packaging storage cleanup requires an absolute project root");
  }
  if (!isHostedLinux(platform, environment)) {
    return { performed: false, removed: [] };
  }

  const root = resolve(projectRoot);
  const removed = [
    join(root, "src-tauri", "target", "debug"),
    join(root, "target", "harness-sync")
  ];
  const before = await availableBytes(root, readFilesystem).catch(() => undefined);
  for (const path of removed) await remove(path, { recursive: true, force: true });
  const after = await availableBytes(root, readFilesystem).catch(() => undefined);

  const change = before === undefined || after === undefined
    ? "available disk could not be measured"
    : `available disk ${gibibytes(before)} -> ${gibibytes(after)} (reclaimed ${gibibytes(Math.max(0, after - before))})`;
  log(`Hosted Linux packaging cleanup: ${change}`);
  for (const path of removed) log(`- removed transient ${path.slice(root.length + 1)}`);
  return { performed: true, removed, before, after };
}

export function withHostedLinuxTauriDiagnostics(
  arguments_,
  { platform = process.platform, environment = process.env } = {}
) {
  return isHostedLinux(platform, environment) ? [...arguments_, "--verbose"] : [...arguments_];
}

export async function reportPackagingStorage({
  projectRoot,
  label,
  readFilesystem = statfs,
  log = console.error
}) {
  if (!projectRoot || !isAbsolute(projectRoot)) return;
  try {
    const bytes = await availableBytes(resolve(projectRoot), readFilesystem);
    log(`${label}: ${gibibytes(bytes)} available on the packaging filesystem`);
  } catch (error) {
    log(`${label}: unable to measure packaging filesystem: ${error instanceof Error ? error.message : String(error)}`);
  }
}
