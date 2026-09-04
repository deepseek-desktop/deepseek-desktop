import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";

import { requestLoopback, waitForLoopback } from "./loopback-http.mjs";

const harnessRoot = resolve(import.meta.dirname, "..");
const desktopRoot = resolve(harnessRoot, "..");
const lock = JSON.parse(await readFile(join(desktopRoot, "target", "generated", "harness-lock.json"), "utf8"));
const { values: options } = parseArgs({ options: { directory: { type: "string" }, entry: { type: "string" }, "settings-ui": { type: "boolean" } } });
if (Boolean(options.directory) !== Boolean(options.entry)) throw new Error("Candidate smoke requires --directory and --entry together");
const LEGACY_COOKIE_COUNT = 60;

function createLegacyCookieJar() {
  const cookies = new Map();
  for (let index = 0; index < LEGACY_COOKIE_COUNT; index += 1) {
    const suffix = index.toString(36).padStart(43, "0");
    cookies.set(`dsh-auth-${suffix}`, `v1.${"x".repeat(154)}.${"y".repeat(43)}`);
  }
  return cookies;
}

function serializeCookies(cookies) {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function applySetCookies(cookies, headerValue) {
  const values = Array.isArray(headerValue) ? headerValue : headerValue ? [headerValue] : [];
  for (const value of values) {
    const [pair, ...attributes] = value.split(";");
    const at = pair.indexOf("=");
    if (at === -1) continue;
    const name = pair.slice(0, at).trim();
    const cookieValue = pair.slice(at + 1).trim();
    if (attributes.some(attribute => /^\s*Max-Age=0\s*$/iu.test(attribute))) cookies.delete(name);
    else cookies.set(name, cookieValue);
  }
}

function pluginScriptUrls(html, baseUrl) {
  const urls = new Set();
  for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gu)) {
    const value = match[1].replaceAll("&amp;", "&").replaceAll("&#38;", "&");
    const url = new URL(value, baseUrl);
    if (url.origin === baseUrl.origin && url.pathname === "/plugins/") urls.add(url.href);
  }
  return [...urls];
}

function diagnosticTail(value) {
  const safeLines = String(value)
    .split("\n")
    .filter(line => !/(?:authorization|credential|api[-_ ]?key|password|secret|token)/iu.test(line))
    .map(line => line
      .replace(/(?:sk|api)[-_][A-Za-z0-9._-]{12,}/giu, "[REDACTED]")
      .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]"));
  return safeLines.join("\n").slice(-8_192).trim();
}

function withHarnessDiagnostic(error, output, cycle) {
  const tail = diagnosticTail(output);
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`harness failed after readiness on cycle ${cycle}: ${message}${tail ? `\n${tail}` : ""}`);
}

function hostTarget() {
  const targets = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc"
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`unsupported harness host ${process.platform}-${process.arch}`);
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

function processGroupExists(pid) {
  if (process.platform === "win32") return false;
  const processes = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  if (processes.status === 0) {
    return processes.stdout.split("\n").some(line => {
      const match = line.trim().match(/^(\d+)\s+(\S+)/u);
      return Number.parseInt(match?.[1] || "", 10) === pid && !match?.[2]?.startsWith("Z");
    });
  }
  // Minimal systems may not provide ps; retain the signal probe as a fallback.
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || (process.platform !== "win32" && !processGroupExists(child.pid))) return true;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  return child.exitCode !== null || (process.platform !== "win32" && !processGroupExists(child.pid));
}

async function terminateTree(child) {
  const pid = child.pid;
  if (!pid) return;
  signalTree(child, "SIGTERM");
  if (!await waitForExit(child, 2_000)) {
    signalTree(child, "SIGKILL");
    if (!await waitForExit(child, 3_000)) throw new Error(`harness process ${pid} did not terminate`);
  }
  if (processGroupExists(pid)) {
    signalTree(child, "SIGKILL");
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    if (processGroupExists(pid)) throw new Error(`harness process group ${pid} still has descendants`);
  }
}

const target = hostTarget();
const staging = options.directory ? resolve(options.directory) : join(harnessRoot, "staging", target);
const nodeSuffix = process.platform === "win32" ? ".exe" : "";
const node = join(desktopRoot, "src-tauri", "binaries", `node-${target}${nodeSuffix}`);
const dsh = join(staging, options.entry ?? lock.harness.entry);
const parentWatch = join(staging, "node_modules", "deepseek-desktop-bundle", "parent-watch.cjs");
const localeSync = join(staging, "node_modules", "deepseek-desktop-bundle", "locale-sync.cjs");
const pnpmCli = join(staging, "node_modules", "pnpm", "bin", "pnpm.cjs");
const marketPackage = join(staging, "node_modules", "dshmarket", "package.json");
await Promise.all([stat(node), stat(dsh), stat(parentWatch), stat(localeSync), stat(pnpmCli), stat(marketPackage)]);

const smokeRoot = join(desktopRoot, "target", "deepseek-desktop-harness-smoke");
const dshHome = join(smokeRoot, "home");
const profile = join(dshHome, "profiles", "desktop-web");
const desktopModules = join(profile, "node_modules");
const harnessBin = join(smokeRoot, "data", "harness-bin");
const credentialHelperScript = join(smokeRoot, "credential-helper.mjs");
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(desktopModules, { recursive: true });
await mkdir(harnessBin, { recursive: true });
await writeFile(credentialHelperScript, `
import { readFileSync } from "node:fs";
if (!process.argv.includes("--credential-vault-helper")) process.exit(2);
const request = JSON.parse(readFileSync(0, "utf8"));
let value = null;
if (request.operation === "describe-ref" || request.operation === "describe-record") value = { configured: false };
else if (request.operation === "list-records") value = { records: [] };
process.stdout.write(JSON.stringify({ ok: true, value }));
`);
await writeFile(join(profile, "package.json"), `${JSON.stringify({
  name: "deepseek-desktop-web-profile",
  private: true,
  dsh: { profile: { bundles: [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "deepseek-desktop-bundle",
    "dshmarket"
  ] } }
}, null, 2)}\n`);
await writeFile(join(profile, "cordis.patch.yml"), "[]\n");
await writeFile(join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\n");
for (const name of [
  "deepseek-desktop-bundle",
  "deepseek-desktop-credentials-vault",
  "dshmarket",
  "@deepseek-ai/dsh-web-search-follow-model"
]) {
  await mkdir(dirname(join(desktopModules, name)), { recursive: true });
  await cp(join(staging, "node_modules", name), join(desktopModules, name), { recursive: true });
}
const packageManager = process.platform === "win32" ? join(harnessBin, "pnpm.cmd") : join(harnessBin, "pnpm");
if (process.platform === "win32") {
  await writeFile(packageManager, "@echo off\r\n\"%DEEPSEEK_DESKTOP_NODE_PATH%\" \"%DEEPSEEK_DESKTOP_PNPM_CLI%\" %*\r\n");
} else {
  await writeFile(packageManager, "#!/bin/sh\nexec \"$DEEPSEEK_DESKTOP_NODE_PATH\" \"$DEEPSEEK_DESKTOP_PNPM_CLI\" \"$@\"\n");
  await chmod(packageManager, 0o700);
}

const environment = {
  PATH: [harnessBin, process.env.PATH].filter(Boolean).join(delimiter),
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: "true",
  DEEPSEEK_DESKTOP_HELPER_PATH: node,
  DEEPSEEK_DESKTOP_HELPER_SCRIPT: credentialHelperScript,
  DEEPSEEK_DESKTOP_DATA_DIR: join(smokeRoot, "data"),
  DEEPSEEK_DESKTOP_PARENT_PID: String(process.pid),
  DEEPSEEK_DESKTOP_LOCALE: "zh-TW",
  DEEPSEEK_DESKTOP_NODE_PATH: node,
  DEEPSEEK_DESKTOP_PNPM_CLI: pnpmCli,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost"
};

function harnessArguments(...arguments_) {
  return [
    "--expose-internals",
    "--require", parentWatch,
    "--require", localeSync,
    dsh,
    ...arguments_
  ];
}

const preloadBoundary = spawnSync(node, [
  "--require",
  parentWatch,
  "--require",
  localeSync,
  "-e",
  "process.stdout.write(JSON.stringify(process.execArgv))"
], {
  cwd: smokeRoot,
  env: environment,
  encoding: "utf8",
  windowsHide: true
});
if (preloadBoundary.status !== 0) {
  throw new Error(`desktop preload boundary failed: ${preloadBoundary.stderr || preloadBoundary.stdout}`);
}
const inheritedExecArgv = JSON.parse(preloadBoundary.stdout || "[]");
if (inheritedExecArgv.some(argument => /(?:parent-watch|locale-sync)\.cjs$/.test(String(argument)))) {
  throw new Error(`desktop-only preloads leaked into child CLI argv: ${preloadBoundary.stdout}`);
}

const pnpmVersion = spawnSync(node, [pnpmCli, "--version"], {
  cwd: smokeRoot,
  env: environment,
  encoding: "utf8",
  windowsHide: true
});
const pnpmStdout = pnpmVersion.stdout?.trim() || "";
if (pnpmVersion.status !== 0 || pnpmStdout !== lock.toolchain.pnpm) {
  throw new Error(`packaged pnpm is unavailable: ${pnpmVersion.error?.message || pnpmVersion.stderr || pnpmVersion.stdout}`);
}

const dump = spawnSync(node, harnessArguments("--profile", "desktop-web", "--dump-config"), {
  cwd: smokeRoot,
  env: environment,
  input: "smoke-credential-session\n",
  encoding: "utf8"
});
if (dump.status !== 0) throw new Error(`profile composition failed: ${dump.stderr || dump.stdout}`);
if (!dump.stdout.includes("deepseek-desktop-credentials-vault")) {
  throw new Error("desktop encrypted credential provider is absent from the composed profile");
}
if (!dump.stdout.includes("dshmarket")) {
  throw new Error("DSH Market is absent from the composed profile");
}
if (!dump.stdout.includes("@deepseek-ai/dsh-web-search-follow-model")
  || !dump.stdout.includes("searchProvider: follow-model")) {
  throw new Error("follow-model web search is not the composed profile default");
}
const { parse: parseYaml } = createRequire(dsh)("yaml");
function officialSearchRow(text) {
  return parseYaml(text, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: value => value }] }).find(row => row.id === "web-search-deepseek");
}
const official = officialSearchRow(dump.stdout);
if (official?.name !== "@deepseek-ai/dsh-web-search-deepseek" || official.disabled === true) {
  throw new Error("the upstream search plugin must remain enabled in a fresh Desktop profile");
}
await writeFile(join(profile, "cordis.patch.yml"), "- id: web-search-deepseek\n  disabled: true\n");
const userDisabledDump = spawnSync(node, harnessArguments("--profile", "desktop-web", "--dump-config"), {
  cwd: smokeRoot, env: environment, input: "smoke-credential-session\n", encoding: "utf8", windowsHide: true
});
if (userDisabledDump.status !== 0 || officialSearchRow(userDisabledDump.stdout)?.disabled !== true
  || !userDisabledDump.stdout.includes("searchProvider: follow-model")) {
  throw new Error("Desktop must preserve the user's official-plugin disable choice without changing search routing");
}
await writeFile(join(profile, "cordis.patch.yml"), "[]\n");
if (!/locale:\s+preference: zh/u.test(await readFile(join(dshHome, "settings.yaml"), "utf8"))) {
  throw new Error("desktop locale bridge did not persist the mapped Harness locale");
}

const cycles = Number.parseInt(process.env.DEEPSEEK_DESKTOP_SMOKE_CYCLES || "1", 10);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 1_000) {
  throw new Error(`DEEPSEEK_DESKTOP_SMOKE_CYCLES must be between 1 and 1000, got ${process.env.DEEPSEEK_DESKTOP_SMOKE_CYCLES}`);
}

async function runCycle(index) {
  const child = spawn(node, harnessArguments(
    "--profile", "desktop-web",
    "--host", "127.0.0.1",
    "--port", "0",
    "--no-open"
  ), {
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
      const timer = setTimeout(() => reject(new Error(`harness readiness timed out on cycle ${index}:\n${output}`)), 20_000);
      const inspect = chunk => {
        const match = String(chunk).match(/dsh web: (http:\/\/[^\s]+)/u);
        if (match) {
          clearTimeout(timer);
          resolveReady(match[1]);
        }
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`harness exited before readiness on cycle ${index} (code=${String(code)}, signal=${String(signal)}):\n${output}`));
      });
    });
    const readyUrl = new URL(ready);
    if (readyUrl.hostname !== "127.0.0.1" || !readyUrl.port) throw new Error(`unexpected readiness origin ${ready}`);
    if (!readyUrl.searchParams.get("token")) throw new Error("harness readiness URL is missing its browser session token");
    // Bundled builds also verify their cookie cleanup patch. Repository candidates
    // start a fresh browser session; Desktop resets service cookies at navigation.
    const browserCookies = options.directory ? new Map() : createLegacyCookieJar();
    let exchange;
    try {
      exchange = await waitForLoopback(ready, {
        child,
        headers: { cookie: serializeCookies(browserCookies) }
      });
    } catch (error) {
      throw withHarnessDiagnostic(error, output, index);
    }
    const setCookie = exchange.headers["set-cookie"];
    applySetCookies(browserCookies, setCookie);
    if (exchange.status !== 303 || exchange.headers.location !== "/" || browserCookies.size !== 1) {
      throw new Error(`harness browser token exchange failed with ${exchange.status}`);
    }
    const cookie = serializeCookies(browserCookies);
    const cleanUrl = new URL("/", readyUrl);
    const response = await requestLoopback(cleanUrl, { headers: { cookie } });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`harness health check returned ${response.status}`);
    }
    if (!response.body.toLowerCase().includes("html")) throw new Error("harness did not return an HTML shell");
    const scripts = pluginScriptUrls(response.body, cleanUrl);
    if (scripts.length === 0) throw new Error("harness HTML shell does not reference plugin scripts");
    for (const script of scripts) {
      const scriptResponse = await requestLoopback(script, {
        headers: { cookie },
        // Repository builds may coalesce the full plugin graph into one script.
        bodyLimit: 16 * 1024 * 1024
      });
      const contentType = String(scriptResponse.headers["content-type"] || "");
      if (scriptResponse.status < 200 || scriptResponse.status >= 300 || !contentType.includes("javascript")) {
        throw new Error(`harness plugin script failed with ${scriptResponse.status}: ${new URL(script).pathname}`);
      }
    }
    if (options["settings-ui"]) {
      const { verifySearchSettings } = await import("./verify-search-settings-ui.mjs");
      await verifySearchSettings(cleanUrl, browserCookies, smokeRoot);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    if (output.includes("dsh web: opening the default browser")) {
      throw new Error("desktop Harness attempted to open the system browser");
    }
  } finally {
    await terminateTree(child);
  }
}

async function verifyParentDeathCleanup() {
  if (process.platform === "win32") return;
  const launcher = join(smokeRoot, "orphan-cleanup-launcher.mjs");
  await writeFile(launcher, `
import { spawn } from "node:child_process";
const [node, parentWatch, localeSync, dsh, cwd, dshHome, dataDir, credentialHelperScript] = process.argv.slice(2);
const child = spawn(node, ["--expose-internals", "--require", parentWatch, "--require", localeSync, dsh, "--profile", "desktop-web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
  cwd,
  detached: true,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "true",
    DEEPSEEK_DESKTOP_HELPER_PATH: node,
    DEEPSEEK_DESKTOP_HELPER_SCRIPT: credentialHelperScript,
    DEEPSEEK_DESKTOP_DATA_DIR: dataDir,
    DEEPSEEK_DESKTOP_PARENT_PID: String(process.pid),
    DEEPSEEK_DESKTOP_LOCALE: "zh-TW",
    DEEPSEEK_DESKTOP_NODE_PATH: process.env.DEEPSEEK_DESKTOP_NODE_PATH,
    DEEPSEEK_DESKTOP_PNPM_CLI: process.env.DEEPSEEK_DESKTOP_PNPM_CLI,
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
  const launched = spawnSync(process.execPath, [launcher, node, parentWatch, localeSync, dsh, smokeRoot, dshHome, join(smokeRoot, "data"), credentialHelperScript], {
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
    throw new Error(`harness process group ${pid} survived its desktop parent`);
  }
  console.log("harness parent-death cleanup passed");
}

for (let index = 1; index <= cycles; index += 1) {
  await runCycle(index);
  if (cycles > 1 && (index === cycles || index % 10 === 0)) console.log(`harness stability progress: ${index}/${cycles}`);
}

await verifyParentDeathCleanup();

for (const plaintext of [".credentials.yaml", ".env"]) {
  try {
    await stat(join(dshHome, plaintext));
    throw new Error(`harness created forbidden plaintext credential file ${plaintext}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
console.log(`harness smoke passed: Harness ${options.directory ? "candidate" : lock.harness.version}, ${cycles} cycle(s)`);
