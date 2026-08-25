import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";

const runtimeRoot = resolve(import.meta.dirname, "..");
const desktopRoot = resolve(runtimeRoot, "..");
const lock = JSON.parse(await readFile(join(runtimeRoot, "runtime-lock.json"), "utf8"));

function hostTarget() {
  const targets = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc"
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`unsupported runtime host ${process.platform}-${process.arch}`);
  return target;
}

function signalTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-child.pid, signal); } catch {}
  }
}

async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return true;
  return new Promise(resolveExit => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

function processGroupExists(pid) {
  if (process.platform === "win32") return false;
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

async function terminateTree(child) {
  const pid = child.pid;
  if (!pid) return;
  signalTree(child, "SIGTERM");
  if (!await waitForExit(child, 2_000)) {
    signalTree(child, "SIGKILL");
    if (!await waitForExit(child, 3_000)) throw new Error(`runtime process ${pid} did not terminate`);
  }
  if (processGroupExists(pid)) {
    signalTree(child, "SIGKILL");
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    if (processGroupExists(pid)) throw new Error(`runtime process group ${pid} still has descendants`);
  }
}

const target = hostTarget();
const staging = join(runtimeRoot, "staging", target);
const nodeSuffix = process.platform === "win32" ? ".exe" : "";
const node = join(desktopRoot, "src-tauri", "binaries", `node-${target}${nodeSuffix}`);
const dsh = join(staging, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const parentWatch = join(staging, "node_modules", "deepseek-desktop-bundle", "parent-watch.cjs");
const localeSync = join(staging, "node_modules", "deepseek-desktop-bundle", "locale-sync.cjs");
await Promise.all([stat(node), stat(dsh), stat(parentWatch), stat(localeSync)]);

const smokeRoot = join(desktopRoot, "target", "deepseek-desktop-runtime-smoke");
const dshHome = join(smokeRoot, "home");
const profile = join(dshHome, "profiles", "desktop-web");
const desktopModules = join(profile, "node_modules");
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(desktopModules, { recursive: true });
await writeFile(join(profile, "package.json"), `${JSON.stringify({
  name: "deepseek-desktop-web-profile",
  private: true,
  dsh: { profile: { bundles: [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "deepseek-desktop-bundle"
  ] } }
}, null, 2)}\n`);
await writeFile(join(profile, "cordis.patch.yml"), "[]\n");
await writeFile(join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\n");
for (const name of ["deepseek-desktop-bundle", "deepseek-desktop-credentials-vault"]) {
  await cp(join(staging, "node_modules", name), join(desktopModules, name), { recursive: true });
}

const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: "true",
  DEEPSEEK_DESKTOP_HELPER_PATH: process.execPath,
  DEEPSEEK_DESKTOP_DATA_DIR: join(smokeRoot, "data"),
  DEEPSEEK_DESKTOP_PARENT_PID: String(process.pid),
  DEEPSEEK_DESKTOP_LOCALE: "zh-TW",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost"
};

const dump = spawnSync(node, ["--require", parentWatch, "--require", localeSync, dsh, "--profile", "desktop-web", "--dump-config"], {
  cwd: smokeRoot,
  env: environment,
  input: "smoke-credential-session\n",
  encoding: "utf8"
});
if (dump.status !== 0) throw new Error(`profile composition failed: ${dump.stderr || dump.stdout}`);
if (!dump.stdout.includes("deepseek-desktop-credentials-vault")) {
  throw new Error("desktop encrypted credential provider is absent from the composed profile");
}
if (!/locale:\s+preference: zh/u.test(await readFile(join(dshHome, "settings.yaml"), "utf8"))) {
  throw new Error("desktop locale bridge did not persist the mapped Runtime locale");
}

const cycles = Number.parseInt(process.env.DEEPSEEK_DESKTOP_SMOKE_CYCLES || "1", 10);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 1_000) {
  throw new Error(`DEEPSEEK_DESKTOP_SMOKE_CYCLES must be between 1 and 1000, got ${process.env.DEEPSEEK_DESKTOP_SMOKE_CYCLES}`);
}

async function runCycle(index) {
  const child = spawn(node, [
    "--require", parentWatch,
    "--require", localeSync,
    dsh,
    "--profile", "desktop-web",
    "--host", "127.0.0.1",
    "--port", "0",
    "--no-open"
  ], {
    cwd: smokeRoot,
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdin.end("smoke-credential-session\n");

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  try {
    const ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`runtime readiness timed out on cycle ${index}:\n${output}`)), 20_000);
      const inspect = chunk => {
        const match = String(chunk).match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timer);
          resolveReady(match[1]);
        }
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`runtime exited before readiness on cycle ${index} (${String(code)}):\n${output}`));
      });
    });
    const readyUrl = new URL(ready);
    if (readyUrl.hostname !== "127.0.0.1" || !readyUrl.port) throw new Error(`unexpected readiness origin ${ready}`);
    const response = await fetch(ready);
    if (!response.ok) throw new Error(`runtime health check returned ${response.status}`);
    const body = await response.text();
    if (!body.toLowerCase().includes("html")) throw new Error("runtime did not return an HTML shell");
  } finally {
    await terminateTree(child);
  }
}

async function verifyParentDeathCleanup() {
  if (process.platform === "win32") return;
  const launcher = join(smokeRoot, "orphan-cleanup-launcher.mjs");
  await writeFile(launcher, `
import { spawn } from "node:child_process";
const [node, parentWatch, localeSync, dsh, cwd, dshHome, dataDir] = process.argv.slice(2);
const child = spawn(node, ["--require", parentWatch, "--require", localeSync, dsh, "--profile", "desktop-web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
  cwd,
  detached: true,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "true",
    DEEPSEEK_DESKTOP_HELPER_PATH: process.execPath,
    DEEPSEEK_DESKTOP_DATA_DIR: dataDir,
    DEEPSEEK_DESKTOP_PARENT_PID: String(process.pid),
    DEEPSEEK_DESKTOP_LOCALE: "zh-TW",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost"
  },
  stdio: ["pipe", "ignore", "ignore"]
});
child.stdin.end("smoke-credential-session\\n");
setTimeout(() => {
  console.log(child.pid);
  child.unref();
  process.exit(0);
}, 1_000);
`);
  const launched = spawnSync(process.execPath, [launcher, node, parentWatch, localeSync, dsh, smokeRoot, dshHome, join(smokeRoot, "data")], {
    cwd: smokeRoot,
    encoding: "utf8",
    timeout: 5_000
  });
  if (launched.status !== 0) throw new Error(`orphan cleanup launcher failed: ${launched.stderr || launched.stdout}`);
  const pid = Number.parseInt(launched.stdout.trim(), 10);
  if (!Number.isInteger(pid)) throw new Error(`orphan cleanup launcher returned an invalid pid: ${launched.stdout}`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && processGroupExists(pid)) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  if (processGroupExists(pid)) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    throw new Error(`runtime process group ${pid} survived its desktop parent`);
  }
  console.log("runtime parent-death cleanup passed");
}

for (let index = 1; index <= cycles; index += 1) {
  await runCycle(index);
  if (cycles > 1 && (index === cycles || index % 10 === 0)) console.log(`runtime stability progress: ${index}/${cycles}`);
}

await verifyParentDeathCleanup();

for (const plaintext of [".credentials.yaml", ".env"]) {
  try {
    await stat(join(dshHome, plaintext));
    throw new Error(`runtime created forbidden plaintext credential file ${plaintext}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
console.log(`runtime smoke passed: Runtime ${lock.runtime.version}, ${cycles} cycle(s)`);
