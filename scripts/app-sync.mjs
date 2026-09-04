import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import { loadBuildConfig } from "./lib/build-config.mjs";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.slice(2).includes("--check");
const unknownArguments = process.argv.slice(2).filter(argument => argument !== "--check");
if (unknownArguments.length > 0) throw new Error(`unsupported app:sync argument(s): ${unknownArguments.join(", ")}`);

function runPnpm(args) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm executable is unavailable; run app:sync through pnpm");
  const result = spawnSync(process.execPath, [pnpmCli, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} exited with code ${String(result.status)}`);
}

async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const config = await loadBuildConfig(root);
const outputRoot = check
  ? await mkdtemp(join(tmpdir(), "deepseek-desktop-app-sync-"))
  : join(root, "target", "generated");

try {
  const brandingRoot = join(outputRoot, "branding");
  const iconsRoot = join(brandingRoot, "icons");
  await mkdir(iconsRoot, { recursive: true });
  runPnpm(["exec", "tauri", "icon", resolve(root, config.iconSource), "--output", iconsRoot]);

  const baseTauri = JSON.parse(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const icon = name => relative(join(root, "src-tauri"), join(iconsRoot, name)).replaceAll("\\", "/");
  const tauriConfig = {
    ...baseTauri,
    productName: config.productName,
    version: config.version,
    identifier: config.identifier,
    app: {
      ...baseTauri.app,
      windows: baseTauri.app.windows.map((window, index) => index === 0 ? { ...window, title: config.windowTitle } : window)
    },
    bundle: {
      ...baseTauri.bundle,
      icon: [icon("32x32.png"), icon("128x128.png"), icon("128x128@2x.png"), icon("icon.icns"), icon("icon.ico"), icon("icon.png")],
      shortDescription: config.description,
      longDescription: config.description,
      copyright: config.copyright
    }
  };
  await writeJson(join(outputRoot, "app-config.json"), config);
  await writeJson(join(outputRoot, "tauri.conf.json"), tauriConfig);
  let harnessSource = {
    schemaVersion: 1,
    repository: config.harness.repository,
    requestedRef: config.harness.ref || null
  };
  if (!check) {
    try {
      const existing = JSON.parse(await readFile(join(outputRoot, "harness-source.json"), "utf8"));
      if (existing.repository === config.harness.repository
        && existing.requestedRef === (config.harness.ref || null)
        && existing.resolvedCommit) {
        harnessSource = existing;
      }
    } catch {}
  }
  await writeJson(join(outputRoot, "harness-source.json"), harnessSource);
  await writeJson(join(brandingRoot, "manifest.json"), {
    schemaVersion: 1,
    source: config.iconSource,
    width: config.icon.width,
    height: config.icon.height,
    generatedIcons: tauriConfig.bundle.icon.map(path => path.split("/").at(-1))
  });
  console.log(`${check ? "validated" : "generated"} application configuration: ${config.productName} ${config.version}`);
} finally {
  if (check) await rm(outputRoot, { recursive: true, force: true });
}
