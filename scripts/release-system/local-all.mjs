import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, totalmem } from "node:os";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  assertNodeId,
  atomicWriteJson,
  flag,
  loadTargets,
  option,
  options,
  parseArguments,
  redactError,
  requireOption,
  sha256File
} from "./common.mjs";
import { ReleaseControllerService } from "./controller-service.mjs";
import { ensureAdminToken, startReleaseServer } from "./http-server.mjs";
import { createReleasePlan } from "./release-plan.mjs";
import { prepareRelease } from "./prepared-release.mjs";
import { ReleaseStateStore } from "./state-store.mjs";
import { createLockedSourceBundle } from "./git-source.mjs";

const root = resolve(import.meta.dirname, "../..");
const defaultConfigPath = join(root, ".deepseek-release.local.json");
const defaultImage = "deepseek-desktop-local-linux-x64:1.0.0";
const allTargetIds = ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"];
const allowedOptions = new Set([
  "channel",
  "check",
  "concurrency",
  "config",
  "destination",
  "docker-image",
  "keep-work",
  "rebuild-docker",
  "signed",
  "source",
  "tag",
  "target",
  "windows-host",
  "windows-vm"
]);

function commandExists(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function runSync(command, args, { cwd = root, env = process.env, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = quiet ? (result.stderr || result.stdout).trim() : "";
    throw new Error(`${basename(command)} failed with code ${String(result.status)}${detail ? `: ${detail}` : ""}`);
  }
  return quiet ? result.stdout.trim() : "";
}

function run(command, args, { cwd = root, env = process.env, input = "", label = basename(command) } = {}) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    console.log(`\n[${label}] starting`);
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "inherit", "inherit"] });
    child.once("error", error => {
      error.durationMs = Date.now() - startedAt;
      reject(error);
    });
    child.once("close", code => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        console.log(`[${label}] completed in ${formatDuration(durationMs)}`);
        resolvePromise({ durationMs });
      } else {
        const error = new Error(`${label} exited with code ${String(code)} after ${formatDuration(durationMs)}`);
        error.durationMs = durationMs;
        reject(error);
      }
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runStateLabel(runId) {
  return `target/local-release/runs/${runId}`;
}

function publicationLabel(destination) {
  const suffix = relative(root, destination);
  if (suffix && !suffix.startsWith("..") && !isAbsolute(suffix)) return suffix.replaceAll("\\", "/");
  return "external-filesystem";
}

async function publicationAssets(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    const info = await stat(path);
    return { name: entry.name, size: info.size, sha256: await sha256File(path) };
  }));
}

function formatDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 100) / 10;
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s` : `${seconds.toFixed(1)}s`;
}

export async function runWithConcurrency(taskFactories, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("release worker concurrency must be a positive integer");
  const results = new Array(taskFactories.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < taskFactories.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await taskFactories[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, taskFactories.length) }, () => consume()));
  return results;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function defaultConfig() {
  return {
    schemaVersion: 1,
    docker: { image: defaultImage, rebuild: false },
    windows: {
      adapter: "parallels",
      vm: "",
      controllerHost: "10.211.55.2",
      autoStart: true,
      workRoot: "C:\\DeepSeekDesktopRelease",
      sharedHome: "\\\\Mac\\Home"
    },
    destination: join(root, "release", "local-all")
  };
}

function validateLocalAllConfig(config) {
  if (typeof config.docker.image !== "string" || !/^[A-Za-z0-9._/-]+(?::[A-Za-z0-9._-]+)?$/u.test(config.docker.image)) {
    throw new Error("docker.image must be a local image name without shell syntax");
  }
  if (typeof config.docker.rebuild !== "boolean") throw new Error("docker.rebuild must be boolean");
  if (config.windows.adapter !== "parallels") throw new Error("windows.adapter currently supports only parallels");
  for (const key of ["vm", "controllerHost", "workRoot", "sharedHome"]) {
    if (typeof config.windows[key] !== "string") throw new Error(`windows.${key} must be a string`);
    if (/\r|\n/u.test(config.windows[key])) throw new Error(`windows.${key} must be a single line`);
  }
  if (config.windows.workRoot.includes("\"") || config.windows.sharedHome.includes("\"")) {
    throw new Error("windows paths must not contain a double quote");
  }
  if (
    (!isIP(config.windows.controllerHost) && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u.test(config.windows.controllerHost))
    || (/^[0-9.]+$/u.test(config.windows.controllerHost) && !isIP(config.windows.controllerHost))
  ) {
    throw new Error("windows.controllerHost must be an IP address or DNS name");
  }
  if (typeof config.windows.autoStart !== "boolean") throw new Error("windows.autoStart must be boolean");
  if (typeof config.destination !== "string" || !config.destination.trim()) throw new Error("destination must be a non-empty path");
  return config;
}

export async function loadLocalAllConfig(path = defaultConfigPath, { explicit = false } = {}) {
  const defaults = defaultConfig();
  let document = {};
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && !explicit) return defaults;
    throw error;
  }
  assertObject(document, "local release configuration");
  assertKnownKeys(document, new Set(["schemaVersion", "docker", "windows", "destination"]), "local release configuration");
  if (document.schemaVersion !== 1) throw new Error("local release configuration schemaVersion must be 1");
  const docker = assertObject(document.docker || {}, "docker configuration");
  assertKnownKeys(docker, new Set(["image", "rebuild"]), "docker configuration");
  const windows = assertObject(document.windows || {}, "windows configuration");
  assertKnownKeys(windows, new Set(["adapter", "vm", "controllerHost", "autoStart", "workRoot", "sharedHome"]), "windows configuration");
  const merged = {
    schemaVersion: 1,
    docker: { ...defaults.docker, ...docker },
    windows: { ...defaults.windows, ...windows },
    destination: document.destination || defaults.destination
  };
  return validateLocalAllConfig(merged);
}

export function macPathToParallelsShared(path, { hostHome = homedir(), guestHome = "\\\\Mac\\Home" } = {}) {
  const absolute = resolve(path);
  const home = resolve(hostHome);
  const suffix = relative(home, absolute);
  if (!suffix || suffix.startsWith("..") || isAbsolute(suffix)) {
    throw new Error(`Parallels shared path must be under ${home}`);
  }
  return `${guestHome.replace(/[\\/]+$/u, "")}\\${suffix.split(sep).join("\\")}`;
}

function nodeId(targetId, runner) {
  const host = hostname().replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^[^A-Za-z0-9]+/u, "") || "local-host";
  return assertNodeId(`${host}.${runner}.${targetId}`);
}

function validateArguments(parsed) {
  if (parsed.positionals.length > 0) throw new Error(`unexpected arguments: ${parsed.positionals.join(", ")}`);
  const unknown = [...parsed.options.keys()].filter(name => !allowedOptions.has(name));
  if (unknown.length > 0) throw new Error(`unknown release:local-all options: ${unknown.join(", ")}`);
}

async function ensureRosettaNode(runRoot) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("release:local-all currently requires an Apple Silicon macOS host");
  }
  runSync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], { quiet: true });
  const lock = JSON.parse(await readFile(join(root, "runtime", "toolchain-lock.json"), "utf8"));
  const artifact = lock.node?.artifacts?.["x86_64-apple-darwin"];
  const version = lock.node?.version;
  if (!version || !artifact?.archive || !artifact?.sha256) throw new Error("toolchain lock has no macOS x64 Node artifact");
  const toolchainRoot = join(root, "target", "local-release", "toolchains", `node-v${version}-darwin-x64`);
  const node = join(toolchainRoot, "bin", "node");
  try {
    const architecture = runSync("/usr/bin/arch", ["-x86_64", node, "-p", "process.arch"], { quiet: true });
    if (architecture === "x64") return node;
  } catch {
    await rm(toolchainRoot, { recursive: true, force: true });
  }
  const archive = join(runRoot, artifact.archive);
  const partial = `${archive}.partial`;
  await rm(partial, { force: true });
  runSync("curl", [
    "--fail", "--location", "--retry", "5", "--retry-all-errors", "--connect-timeout", "30", "--max-time", "600",
    "--output", partial, `${lock.node.sourceUrl}${artifact.archive}`
  ]);
  if (await sha256File(partial) !== artifact.sha256) {
    await rm(partial, { force: true });
    throw new Error("downloaded macOS x64 Node archive failed SHA-256 verification");
  }
  await rename(partial, archive);
  const temporary = `${toolchainRoot}.${process.pid}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  runSync("tar", ["-xzf", archive, "--strip-components", "1", "-C", temporary]);
  await rm(toolchainRoot, { recursive: true, force: true });
  await rename(temporary, toolchainRoot);
  const architecture = runSync("/usr/bin/arch", ["-x86_64", node, "-p", "process.arch"], { quiet: true });
  if (architecture !== "x64") throw new Error("downloaded Rosetta Node does not report x64 architecture");
  return node;
}

async function ensureDockerImage(config, rebuild) {
  const docker = commandExists("docker");
  if (!docker) throw new Error("Docker is required for the Linux x64 local worker");
  runSync(docker, ["version", "--format", "{{.Server.Version}}"], { quiet: true });
  const exists = spawnSync(docker, ["image", "inspect", config.image], { stdio: "ignore" }).status === 0;
  if (!exists || rebuild || config.rebuild) {
    runSync(docker, [
      "build", "--platform", "linux/amd64", "--progress", "plain",
      "--file", "docker/ci/Dockerfile", "--tag", config.image, "."
    ]);
  }
  return docker;
}

function parallelsVms(prlctl) {
  const text = runSync(prlctl, ["list", "-a", "-j"], { quiet: true });
  const values = JSON.parse(text);
  if (!Array.isArray(values)) throw new Error("Parallels returned an invalid VM list");
  return values;
}

async function ensureWindowsVm(config, { allowStart }) {
  const prlctl = commandExists("prlctl");
  if (!prlctl) throw new Error("Parallels prlctl is required for the Windows x64 local worker");
  const vms = parallelsVms(prlctl);
  let vm = config.vm ? vms.find(candidate => candidate.name === config.vm) : null;
  if (!vm) {
    const candidates = vms.filter(candidate => /windows/iu.test(candidate.name || ""));
    if (candidates.length === 1) vm = candidates[0];
    else if (!config.vm) throw new Error("set windows.vm because a single Windows Parallels VM could not be selected automatically");
  }
  if (!vm) throw new Error(`Parallels VM not found: ${config.vm}`);
  let startedByUs = false;
  if (vm.status !== "running") {
    if (!allowStart || !config.autoStart) throw new Error(`Parallels VM ${vm.name} is not running`);
    runSync(prlctl, ["start", vm.name]);
    startedByUs = true;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
      const current = parallelsVms(prlctl).find(candidate => candidate.name === vm.name);
      if (current?.status === "running") break;
      if (attempt === 59) throw new Error(`Parallels VM ${vm.name} did not start in time`);
    }
  }
  return { prlctl, vmName: vm.name, startedByUs };
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function writeWindowsScripts(runRoot, settings) {
  const ca = macPathToParallelsShared(settings.caFile, settings.share);
  const worker = macPathToParallelsShared(join(root, "scripts", "release-system", "cli.mjs"), settings.share);
  const healthProbe = macPathToParallelsShared(join(root, "scripts", "release-system", "health-probe.mjs"), settings.share);
  const preflightPath = join(runRoot, "windows-preflight.ps1");
  const healthPath = join(runRoot, "windows-health.ps1");
  const workerPath = join(runRoot, "windows-worker.ps1");
  const vsWhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  await writeFile(preflightPath, [
    "$ErrorActionPreference = 'Stop'",
    `$worker = ${powershellLiteral(worker)}`,
    `if (-not (Test-Path -LiteralPath $worker)) { throw 'Parallels shared worker script is unavailable' }`,
    "$node = Get-Command node.exe -ErrorAction Stop",
    "$git = Get-Command git.exe -ErrorAction Stop",
    "$corepack = Get-Command corepack.cmd -ErrorAction Stop",
    "if ((& $node.Source -p 'process.arch').Trim() -ne 'x64') { throw 'Windows worker Node must report x64' }",
    `$vswhere = ${powershellLiteral(vsWhere)}`,
    "if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Build Tools with vswhere are required' }",
    "$install = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()",
    "if (-not $install) { throw 'Visual Studio C++ x64 tools are required' }",
    "$vsDevCmd = Join-Path $install 'Common7\\Tools\\VsDevCmd.bat'",
    "if (-not (Test-Path -LiteralPath $vsDevCmd)) { throw 'VsDevCmd.bat is unavailable' }",
    "Write-Output ('Windows x64 prerequisites are ready: ' + $node.Source)"
  ].join("\r\n"));
  await writeFile(healthPath, [
    "$ErrorActionPreference = 'Stop'",
    `$env:NODE_EXTRA_CA_CERTS = ${powershellLiteral(ca)}`,
    `& node.exe ${powershellLiteral(healthProbe)} ${powershellLiteral(settings.controller)}`,
    "exit $LASTEXITCODE"
  ].join("\r\n"));
  const workerArguments = [
    worker,
    "worker",
    "--controller", settings.controller,
    "--node-id", settings.nodeId,
    "--token-stdin",
    "--work-root", settings.workRoot,
    "--prepared-root", settings.preparedRoot,
    ...(settings.sourceBundle ? ["--source-bundle", settings.sourceBundle] : []),
    ...(settings.keepWork ? ["--keep-work"] : [])
  ];
  const cmdArguments = workerArguments.map(value => `"${String(value).replaceAll("\"", "\"\"")}"`).join(" ");
  await writeFile(workerPath, [
    "$ErrorActionPreference = 'Stop'",
    `$env:NODE_EXTRA_CA_CERTS = ${powershellLiteral(ca)}`,
    `$env:DEEPSEEK_DESKTOP_TOOLCHAIN_DIR = ${powershellLiteral(`${settings.workRoot}\\toolchain`)}`,
    `$env:PLAYWRIGHT_BROWSERS_PATH = ${powershellLiteral(`${settings.workRoot}\\playwright`)}`,
    `$env:DEEPSEEK_DESKTOP_CARGO_CACHE_ROOT = ${powershellLiteral(`${settings.workRoot}\\cargo`)}`,
    `$env:DEEPSEEK_DESKTOP_RUNTIME_TARGET_CACHE_ROOT = ${powershellLiteral(`${settings.workRoot}\\runtime-target-cache`)}`,
    `$vswhere = ${powershellLiteral(vsWhere)}`,
    "$install = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()",
    "$vsDevCmd = Join-Path $install 'Common7\\Tools\\VsDevCmd.bat'",
    `$command = 'call \"' + $vsDevCmd + '\" -arch=x64 -host_arch=x64 && node.exe ${cmdArguments}'`,
    "& cmd.exe /d /s /c $command",
    "exit $LASTEXITCODE"
  ].join("\r\n"));
  return {
    preflight: macPathToParallelsShared(preflightPath, settings.share),
    health: macPathToParallelsShared(healthPath, settings.share),
    worker: macPathToParallelsShared(workerPath, settings.share)
  };
}

async function createTlsBundle(runRoot, hosts) {
  const openssl = commandExists("openssl");
  if (!openssl) throw new Error("OpenSSL is required to secure the local multi-environment controller");
  const tlsRoot = join(runRoot, "tls");
  await mkdir(tlsRoot, { recursive: true });
  const caKey = join(tlsRoot, "ca.key");
  const caCert = join(tlsRoot, "ca.crt");
  const serverKey = join(tlsRoot, "server.key");
  const serverCsr = join(tlsRoot, "server.csr");
  const serverCert = join(tlsRoot, "server.crt");
  const extension = join(tlsRoot, "server.ext");
  const uniqueHosts = [...new Set(["localhost", "127.0.0.1", ...hosts])];
  const sans = uniqueHosts.map((host, index) => `${isIP(host) ? "IP" : "DNS"}.${index + 1} = ${host}`).join("\n");
  await writeFile(extension, `[v3_server]\nbasicConstraints = CA:FALSE\nkeyUsage = digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = @alt_names\n[alt_names]\n${sans}\n`);
  runSync(openssl, ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", caKey], { quiet: true });
  runSync(openssl, ["req", "-x509", "-new", "-sha256", "-days", "2", "-key", caKey, "-subj", "/CN=DeepSeek Desktop Local Release CA", "-out", caCert], { quiet: true });
  runSync(openssl, ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", serverKey], { quiet: true });
  runSync(openssl, ["req", "-new", "-sha256", "-key", serverKey, "-subj", "/CN=localhost", "-out", serverCsr], { quiet: true });
  runSync(openssl, ["x509", "-req", "-sha256", "-days", "2", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-extfile", extension, "-extensions", "v3_server", "-out", serverCert], { quiet: true });
  await chmod(caKey, 0o600);
  await chmod(serverKey, 0o600);
  return { caCert, serverCert, serverKey };
}

async function checkFile(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`expected file is unavailable: ${path}`);
}

function workerEnvironment(caCert, targetId, nodeBin = "") {
  return {
    ...process.env,
    NODE_EXTRA_CA_CERTS: caCert,
    DEEPSEEK_DESKTOP_TOOLCHAIN_DIR: join(root, "target", "local-release", "toolchains", `rust-${targetId}`),
    PLAYWRIGHT_BROWSERS_PATH: join(root, "target", "local-release", "playwright"),
    DEEPSEEK_DESKTOP_CARGO_CACHE_ROOT: join(root, "target", "local-release", "cargo"),
    DEEPSEEK_DESKTOP_RUNTIME_TARGET_CACHE_ROOT: join(root, "target", "local-release", "runtime-target-cache"),
    ...(nodeBin ? { PATH: `${dirname(nodeBin)}:${process.env.PATH || ""}` } : {})
  };
}

function dockerBaseArgs(config, caCert) {
  return [
    "run", "--rm", "--platform", "linux/amd64", "--interactive",
    "--env", "NODE_EXTRA_CA_CERTS=/local-release/ca.crt",
    "--env", "DEEPSEEK_DESKTOP_TOOLCHAIN_DIR=/local-release/toolchain",
    "--env", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
    "--env", "DEEPSEEK_DESKTOP_CARGO_CACHE_ROOT=/local-release/cargo",
    "--env", "DEEPSEEK_DESKTOP_RUNTIME_TARGET_CACHE_ROOT=/local-release/runtime-target-cache",
    "--volume", `${root}:/orchestrator:ro`,
    "--volume", `${caCert}:/local-release/ca.crt:ro`,
    "--volume", "deepseek-desktop-local-release-toolchain:/local-release/toolchain",
    "--volume", "deepseek-desktop-local-release-pnpm:/root/.local/share/pnpm",
    "--volume", "deepseek-desktop-local-release-cargo:/local-release/cargo",
    "--volume", "deepseek-desktop-local-release-runtime-target-cache:/local-release/runtime-target-cache",
    config.image
  ];
}

export async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  validateArguments(parsed);
  const configValue = option(parsed, "config");
  const config = await loadLocalAllConfig(configValue ? resolve(configValue) : defaultConfigPath, { explicit: Boolean(configValue) });
  if (option(parsed, "docker-image")) config.docker.image = option(parsed, "docker-image");
  if (option(parsed, "windows-vm")) config.windows.vm = option(parsed, "windows-vm");
  if (option(parsed, "windows-host")) config.windows.controllerHost = option(parsed, "windows-host");
  if (option(parsed, "destination")) config.destination = option(parsed, "destination");
  validateLocalAllConfig(config);
  const targetIds = options(parsed, "target");
  const requestedTargets = targetIds.length > 0 ? targetIds : allTargetIds;
  const { byId } = await loadTargets();
  for (const targetId of requestedTargets) if (!byId.has(targetId)) throw new Error(`unknown local release target ${targetId}`);
  if (new Set(requestedTargets).size !== requestedTargets.length) throw new Error("local release targets must not be duplicated");
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("release:local-all currently coordinates four environments from an Apple Silicon macOS host");
  }

  const checkOnly = flag(parsed, "check");
  const requestedConcurrency = option(parsed, "concurrency");
  const concurrency = requestedConcurrency ? Number(requestedConcurrency) : (totalmem() <= 20 * 1024 ** 3 ? 2 : 3);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("--concurrency must be an integer between 1 and 4");
  const releaseStartedAt = Date.now();
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const runRoot = join(root, "target", "local-release", "runs", runId);
  await mkdir(runRoot, { recursive: true });
  const x64Node = requestedTargets.includes("macos-x64") ? await ensureRosettaNode(runRoot) : "";
  const docker = requestedTargets.includes("linux-x64")
    ? await ensureDockerImage(config.docker, flag(parsed, "rebuild-docker"))
    : "";
  const windows = requestedTargets.includes("windows-x64")
    ? await ensureWindowsVm(config.windows, { allowStart: !checkOnly })
    : null;

  const tls = await createTlsBundle(runRoot, [
    ...(requestedTargets.includes("linux-x64") ? ["host.docker.internal"] : []),
    ...(requestedTargets.includes("windows-x64") ? [config.windows.controllerHost] : [])
  ]);
  await checkFile(tls.caCert);
  const controllerRoot = join(runRoot, "controller");
  const store = new ReleaseStateStore(controllerRoot);
  await store.initialize();
  const admin = await ensureAdminToken(controllerRoot);
  const service = new ReleaseControllerService({ store, ticketTtlMs: 12 * 60 * 60_000, leaseTtlMs: 12 * 60 * 60_000 });
  const server = await startReleaseServer({
    service,
    host: "0.0.0.0",
    port: 0,
    adminToken: admin.token,
    tls: { cert: tls.serverCert, key: tls.serverKey }
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) throw new Error("local release controller did not allocate a port");
  const controllers = {
    "macos-arm64": `https://localhost:${port}`,
    "macos-x64": `https://localhost:${port}`,
    "linux-x64": `https://host.docker.internal:${port}`,
    "windows-x64": `https://${config.windows.controllerHost}:${port}`
  };
  const share = { hostHome: homedir(), guestHome: config.windows.sharedHome };
  const windowsSettings = windows ? {
    caFile: tls.caCert,
    controller: controllers["windows-x64"],
    keepWork: flag(parsed, "keep-work"),
    nodeId: nodeId("windows-x64", "parallels"),
    share,
    workRoot: config.windows.workRoot,
    preparedRoot: macPathToParallelsShared(join(root, "target", "local-release", "prepared"), share),
    sourceBundle: ""
  } : null;
  let windowsScripts = windows ? await writeWindowsScripts(runRoot, windowsSettings) : null;

  try {
    const probes = [];
    if (requestedTargets.includes("macos-arm64")) {
      probes.push(run(process.execPath, [join(root, "scripts/release-system/health-probe.mjs"), controllers["macos-arm64"]], {
        env: workerEnvironment(tls.caCert, "macos-arm64"), label: "macos-arm64 probe"
      }));
    }
    if (requestedTargets.includes("macos-x64")) {
      probes.push(run("/usr/bin/arch", ["-x86_64", x64Node, join(root, "scripts/release-system/health-probe.mjs"), controllers["macos-x64"]], {
        env: workerEnvironment(tls.caCert, "macos-x64", x64Node), label: "macos-x64 Rosetta probe"
      }));
    }
    if (requestedTargets.includes("linux-x64")) {
      probes.push(run(docker, [...dockerBaseArgs(config.docker, tls.caCert), "node", "/orchestrator/scripts/release-system/health-probe.mjs", controllers["linux-x64"]], {
        label: "linux-x64 Docker probe"
      }));
    }
    if (windows) {
      runSync(windows.prlctl, ["exec", windows.vmName, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", windowsScripts.preflight]);
      probes.push(run(windows.prlctl, ["exec", windows.vmName, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", windowsScripts.health], {
        label: "windows-x64 Parallels probe"
      }));
    }
    await Promise.all(probes);
    if (checkOnly) {
      console.log(`\nLocal four-environment preflight passed for: ${requestedTargets.join(", ")}`);
      console.log(`Run state: ${runStateLabel(runId)}`);
      return;
    }

    const tag = requireOption(parsed, "tag");
    const channel = option(parsed, "channel", "community");
    const signed = flag(parsed, "signed");
    const preparationStartedAt = Date.now();
    const preparation = await prepareRelease({ root, tag, channel, signed });
    const preparationDurationMs = Date.now() - preparationStartedAt;
    const runners = new Map([
      ["macos-arm64", "native"],
      ["macos-x64", "rosetta"],
      ["windows-x64", "parallels"],
      ["linux-x64", "docker"]
    ]);
    const trustedNodes = new Map(requestedTargets.map(targetId => [targetId, nodeId(targetId, runners.get(targetId))]));
    const plan = await createReleasePlan({
      root,
      tag,
      channel,
      signed,
      sourceRepository: option(parsed, "source"),
      requestedTargetIds: requestedTargets,
      trustedNodes,
      prepared: preparation.descriptor
    });
    const sourceBundle = await createLockedSourceBundle({
      repositoryRoot: root,
      tag,
      commit: plan.source.commit,
      destination: join(runRoot, "source.bundle")
    });
    if (windowsSettings) {
      windowsSettings.sourceBundle = macPathToParallelsShared(sourceBundle, share);
      windowsScripts = await writeWindowsScripts(runRoot, windowsSettings);
    }
    const created = await service.createRelease(plan);
    const tickets = { ...created.tickets };
    const keepWork = flag(parsed, "keep-work");
    const workerRun = targetId => async () => {
      const commonArgs = [
        join(root, "scripts/release-system/cli.mjs"), "worker",
        "--controller", controllers[targetId],
        "--node-id", trustedNodes.get(targetId),
        "--token-stdin",
        "--work-root", join(root, "target", "local-release", "work", targetId),
        "--prepared-root", join(root, "target", "local-release", "prepared"),
        "--source-bundle", sourceBundle,
        ...(keepWork ? ["--keep-work"] : [])
      ];
      if (targetId === "macos-arm64") {
        return run(process.execPath, commonArgs, {
          env: workerEnvironment(tls.caCert, targetId), input: `${tickets[targetId]}\n`, label: targetId
        });
      }
      if (targetId === "macos-x64") {
        return run("/usr/bin/arch", ["-x86_64", x64Node, ...commonArgs], {
          env: workerEnvironment(tls.caCert, targetId, x64Node), input: `${tickets[targetId]}\n`, label: targetId
        });
      }
      if (targetId === "linux-x64") {
        const args = [...dockerBaseArgs(config.docker, tls.caCert),
          "node", "/orchestrator/scripts/release-system/cli.mjs", "worker",
          "--controller", controllers[targetId], "--node-id", trustedNodes.get(targetId), "--token-stdin", "--work-root", "/local-release/work",
          "--prepared-root", "/orchestrator/target/local-release/prepared",
          "--source-bundle", `/orchestrator/${relative(root, sourceBundle).replaceAll("\\", "/")}`,
          ...(keepWork ? ["--keep-work"] : [])];
        return run(docker, args, { input: `${tickets[targetId]}\n`, label: targetId });
      }
      return run(windows.prlctl, ["exec", windows.vmName, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", windowsScripts.worker], {
        input: `${tickets[targetId]}\n`, label: targetId
      });
    };
    const workersStartedAt = Date.now();
    const results = new Array(requestedTargets.length);
    const targetDurations = new Array(requestedTargets.length).fill(0);
    const runTargets = async targetIdsToRun => {
      const passResults = await runWithConcurrency(targetIdsToRun.map(workerRun), concurrency);
      for (let index = 0; index < targetIdsToRun.length; index += 1) {
        const targetIndex = requestedTargets.indexOf(targetIdsToRun[index]);
        results[targetIndex] = passResults[index];
        targetDurations[targetIndex] += passResults[index].status === "fulfilled"
          ? passResults[index].value.durationMs
          : Number(passResults[index].reason?.durationMs || 0);
      }
    };
    await runTargets(requestedTargets);
    let release = await service.getRelease(created.release.id);
    const retryTargets = release.tasks
      .filter(task => new Set(["failed", "waiting"]).has(task.status))
      .map(task => task.targetId);
    if (retryTargets.length > 0) {
      console.log(`\nRetrying failed targets only: ${retryTargets.join(", ")}`);
      for (const targetId of retryTargets) {
        const retried = await service.retryTask(release.id, targetId);
        tickets[targetId] = retried.ticket;
      }
      await runTargets(retryTargets);
      release = await service.getRelease(created.release.id);
    }
    const summary = {
      schemaVersion: 1,
      releaseId: release.id,
      tag,
      status: release.status,
      startedAt: new Date(releaseStartedAt).toISOString(),
      concurrency,
      preparation: {
        durationMs: preparationDurationMs,
        cacheHit: preparation.cacheHit,
        receiptSha256: preparation.descriptor.receiptSha256,
        timings: preparation.timings
      },
      workersDurationMs: Date.now() - workersStartedAt,
      targets: requestedTargets.map((targetId, index) => ({
        targetId,
        runner: runners.get(targetId),
        status: release.tasks.find(task => task.targetId === targetId)?.status || "unknown",
        attempts: release.tasks.find(task => task.targetId === targetId)?.attempts || 0,
        durationMs: targetDurations[index] || null,
        error: results[index].status === "rejected" ? redactError(results[index].reason) : null
      }))
    };
    const failures = summary.targets.filter(target => target.status !== "completed");
    if (failures.length > 0) {
      summary.status = "failed";
      summary.durationMs = Date.now() - releaseStartedAt;
      summary.completedAt = new Date().toISOString();
      await atomicWriteJson(join(runRoot, "summary.json"), summary);
      throw new Error(`local release did not complete: ${failures.map(target => `${target.targetId}:${target.status}`).join(", ")}`);
    }
    const destination = resolve(root, config.destination);
    const publishStartedAt = Date.now();
    let publication;
    try {
      publication = await service.publishRelease(release.id, { provider: "filesystem", destination });
    } catch (error) {
      summary.status = "ready";
      summary.publishDurationMs = Date.now() - publishStartedAt;
      summary.durationMs = Date.now() - releaseStartedAt;
      summary.completedAt = new Date().toISOString();
      summary.publicationError = redactError(error);
      await atomicWriteJson(join(runRoot, "summary.json"), summary);
      throw new Error(`all installers are ready but filesystem publication failed; reuse the current run controller state without rebuilding: ${redactError(error)}`);
    }
    summary.status = "published";
    summary.publishDurationMs = Date.now() - publishStartedAt;
    summary.durationMs = Date.now() - releaseStartedAt;
    summary.completedAt = new Date().toISOString();
    summary.publication = {
      provider: "filesystem",
      destination: publicationLabel(publication.location),
      assets: await publicationAssets(publication.location)
    };
    for (const target of summary.targets) {
      const triple = byId.get(target.targetId).triple;
      try {
        const buildInfo = JSON.parse(await readFile(join(controllerRoot, "incoming", release.id, target.targetId, `BUILD-INFO.${triple}.json`), "utf8"));
        target.performance = buildInfo.performance || null;
        target.prepared = buildInfo.prepared || null;
      } catch {
        target.performance = null;
      }
    }
    await atomicWriteJson(join(runRoot, "summary.json"), summary);
    console.log(`\nFour-environment release completed in ${formatDuration(summary.durationMs)}.`);
    console.log(`Published to ${summary.publication.destination}`);
    console.log(`Timing summary: ${runStateLabel(runId)}/summary.json`);
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(redactError(error));
    process.exit(1);
  }
}
