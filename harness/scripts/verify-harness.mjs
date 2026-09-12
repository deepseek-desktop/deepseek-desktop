import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { findInstalledPackages, listInstalledPackages, packageInventory } from "../../scripts/lib/installed-packages.mjs";
import { verifyDesktopPatchAsset } from "../../scripts/lib/desktop-patches.mjs";
import { assertPinnedHarnessSource } from "../../scripts/lib/harness-source-pin.mjs";

const harnessRoot = resolve(import.meta.dirname, "..");
const desktopRoot = resolve(harnessRoot, "..");
const generatedRoot = join(desktopRoot, "target", "generated");
const lock = JSON.parse(await readFile(join(generatedRoot, "harness-lock.json"), "utf8"));
const toolchain = JSON.parse(await readFile(join(harnessRoot, "toolchain-lock.json"), "utf8"));

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

function packagePath(nodeModules, packageName) {
  return join(nodeModules, ...packageName.split("/"));
}

function targetPlatform(target) {
  return {
    "aarch64-apple-darwin": { os: "darwin", cpu: "arm64" },
    "x86_64-apple-darwin": { os: "darwin", cpu: "x64" },
    "x86_64-pc-windows-msvc": { os: "win32", cpu: "x64" },
    "x86_64-unknown-linux-gnu": { os: "linux", cpu: "x64" }
  }[target];
}

function supportsConstraint(constraint, value) {
  if (!Array.isArray(constraint) || constraint.length === 0) return true;
  if (constraint.includes(`!${value}`)) return false;
  const allowed = constraint.filter(item => !item.startsWith("!"));
  return allowed.length === 0 || allowed.includes(value);
}

async function verifyStaticMuslExecutables(root, moduleRoots, manifest, platform) {
  const manifestFiles = new Map(manifest.files.map(entry => [entry.path, entry]));
  const portablePlatform = `${platform.os}-${platform.cpu}`;
  const acceptedPlatforms = new Set([
    portablePlatform,
    ...(platform.os === "linux" ? [`${portablePlatform}-gnu`] : []),
    ...(platform.os === "win32" ? [`${portablePlatform}-msvc`] : [])
  ]);
  let declarations = 0;
  for (const item of await listInstalledPackages(moduleRoots)) {
    let prebuilds;
    try {
      prebuilds = JSON.parse(await readFile(join(item.directory, "prebuilds.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!Array.isArray(prebuilds.binaries)) {
      throw new Error(`native package has no binary declarations: ${item.manifest.name}`);
    }
    if (!acceptedPlatforms.has(prebuilds.platform)) {
      throw new Error(
        `native package platform mismatch: ${item.manifest.name} declares ${String(prebuilds.platform)}, expected one of ${[...acceptedPlatforms].join(", ")}`
      );
    }
    for (const binary of prebuilds.binaries) {
      if (binary.kind !== "static-musl") continue;
      declarations += 1;
      if (typeof binary.path !== "string" || binary.path.length === 0) {
        throw new Error(`native package has an invalid static-musl path: ${item.manifest.name}`);
      }
      const filename = resolve(item.directory, binary.path);
      const packageRelation = relative(item.directory, filename);
      if (!packageRelation || packageRelation === ".." || packageRelation.startsWith(`..${sep}`)) {
        throw new Error(`native package static-musl path escapes its package: ${item.manifest.name}`);
      }
      const info = await stat(filename);
      if (!info.isFile() || (info.mode & 0o111) === 0) {
        throw new Error(`native package static-musl launcher is not executable: ${item.manifest.name}/${binary.path}`);
      }
      const stagedPath = relative(root, filename).split(sep).join("/");
      const record = manifestFiles.get(stagedPath);
      if (!record || !Number.isInteger(record.mode) || (record.mode & 0o111) === 0) {
        throw new Error(`Harness manifest omits the executable mode for static-musl launcher: ${stagedPath}`);
      }
      if (process.platform === "linux") {
        const probe = spawnSync(filename, ["--probe"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000
        });
        if (probe.error || probe.signal) {
          throw new Error(`native package static-musl launcher cannot execute: ${item.manifest.name}/${binary.path}: ${probe.error?.message || probe.signal}`);
        }
        if (probe.status === 0) {
          if (!/^landlock: (?:fully enforced|partially enforced \(older ABI\))\n?$/u.test(probe.stdout)) {
            throw new Error(`native package static-musl launcher returned an invalid probe result: ${item.manifest.name}/${binary.path}`);
          }
        } else if (probe.status !== 125 || !/^landlock-run: /u.test(probe.stderr)) {
          throw new Error(`native package static-musl launcher probe failed unexpectedly: ${item.manifest.name}/${binary.path}`);
        }
      }
    }
  }
  if (platform.os === "linux" && declarations === 0) {
    throw new Error("Linux Harness contains no declared static-musl launcher");
  }
}

async function hashTree(directory) {
  const hash = createHash("sha256");
  async function visit(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const name = relative(directory, path).split(sep).join("/");
      const info = await lstat(path);
      if (info.isSymbolicLink()) hash.update(`L\0${name}\0${await readlink(path)}\0`);
      else if (info.isDirectory()) {
        hash.update(`D\0${name}\0`);
        await visit(path);
      } else if (info.isFile()) {
        hash.update(`F\0${name}\0${info.mode & 0o777}\0`);
        hash.update(await readFile(path));
      }
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

async function verifyPatch(moduleRoots, patch) {
  const lockEntry = `${patch.packageName}:${patch.id}`;
  if (!lock.patches?.some(entry => entry === lockEntry || entry.startsWith(`${lockEntry}:`))) {
    throw new Error(`harness lock is missing desktop patch ${lockEntry}`);
  }
  if (patch.file) await stat(join(harnessRoot, "patches", patch.file));
  const packageRoots = await findInstalledPackages(moduleRoots, patch.packageName);
  if (packageRoots.length === 0) throw new Error(`desktop patch target is absent: ${patch.packageName}`);
  for (const packageRoot of packageRoots) {
    const source = await readFile(join(packageRoot, ...patch.moduleFile.split("/")), "utf8");
    for (const marker of patch.markers) {
      if (!source.includes(marker)) {
        throw new Error(
          `desktop patch ${lockEntry} is absent from ${join(packageRoot, ...patch.moduleFile.split("/"))}: missing ${JSON.stringify(marker)}`
        );
      }
    }
  }
}

async function verifyPatches(nodeModules) {
  const cliModules = join(packagePath(nodeModules, lock.harness.packageName), "node_modules");
  for (const patch of toolchain.desktopPatches) await verifyPatch([cliModules, nodeModules], patch);
}

async function verifyFinalToolCallIdentity(nodeModules) {
  const packageRoots = await findInstalledPackages([nodeModules], "@earendil-works/pi-ai");
  if (packageRoots.length !== 1) {
    throw new Error(`expected one pi-ai package, found ${packageRoots.length}`);
  }
  const moduleUrl = pathToFileURL(join(packageRoots[0], "dist", "api", "openai-responses-shared.js")).href;
  const { processResponsesStream } = await import(moduleUrl);
  const providerEvents = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_stale",
        call_id: "call_stale",
        name: "read",
        arguments: JSON.stringify({ file_path: "/stale/path" }),
        namespace: "stale"
      }
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_final",
        call_id: "call_final",
        name: "glob",
        arguments: JSON.stringify({ pattern: "**/*.yml", path: "/workspace" })
      }
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "custom_tool_call",
        id: "ctc_stale",
        call_id: "custom_stale",
        name: "read",
        input: "stale input",
        namespace: "stale"
      }
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "custom_tool_call",
        id: "ctc_final",
        call_id: "custom_final",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch"
      }
    },
    {
      type: "response.completed",
      response: { id: "resp_final", status: "completed", output: [] }
    }
  ];
  async function* streamProviderEvents() {
    yield* providerEvents;
  }
  const emitted = [];
  const output = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "compatibility-test",
    model: "compatibility-test",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  };
  const model = {
    id: "compatibility-test",
    name: "Compatibility Test",
    api: "openai-responses",
    provider: "compatibility-test",
    input: ["text"],
    contextWindow: 1,
    maxTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  await processResponsesStream(streamProviderEvents(), output, { push: event => emitted.push(event) }, model);
  const calls = emitted.filter(event => event.type === "toolcall_end").map(event => event.toolCall);
  const [completed, custom] = calls;
  if (completed?.id !== "call_final|fc_final"
    || completed?.name !== "glob"
    || completed?.arguments?.pattern !== "**/*.yml"
    || "namespace" in completed) {
    throw new Error("pi-ai did not use the authoritative final tool-call identity");
  }
  if (calls.length !== 2
    || custom?.id !== "custom_final|ctc_final"
    || custom?.name !== "apply_patch"
    || custom?.arguments?.input !== "*** Begin Patch\n*** End Patch"
    || "namespace" in custom) {
    throw new Error("pi-ai did not use the authoritative final custom tool-call identity");
  }
}

async function verifyFollowModelSearch(nodeModules) {
  const packageRoots = await findInstalledPackages([nodeModules], "@deepseek-ai/dsh-web-search-follow-model");
  if (packageRoots.length !== 1) {
    throw new Error(`expected one follow-model search package, found ${packageRoots.length}`);
  }
  const moduleUrl = pathToFileURL(join(packageRoots[0], "index.js")).href;
  const { FollowModelSearchEngine } = await import(moduleUrl);
  let fetches = 0;
  const engine = new FollowModelSearchEngine({
    fetch: async (url, options) => {
      fetches += 1;
      if (new URL(url).href !== "https://provider.invalid/v1/web-search") {
        throw new Error(`follow-model search used an unexpected endpoint: ${url}`);
      }
      const request = JSON.parse(options.body);
      if (request.model !== "verification-model" || request.query !== "verification query") {
        throw new Error("follow-model search did not preserve the selected model route");
      }
      if (options.headers.authorization !== "Bearer verification-secret") {
        throw new Error("follow-model search did not inherit the selected Provider credential");
      }
      return new Response(JSON.stringify({
        content: "verification result",
        sources: [{ url: "https://source.invalid/result" }]
      }), { status: 200 });
    },
    resolveCredential: async ref => ref === "VERIFICATION_KEY" ? "verification-secret" : undefined
  });
  engine.registerRouteResolver(({ provider, model }) => provider === "verification-provider" ? {
    provider,
    model,
    endpoint: "https://provider.invalid/v1",
    credentialRef: "VERIFICATION_KEY",
    webSearch: { protocol: "dsh-web-search-v1", credential: "inherit" }
  } : undefined);
  const agent = {
    session: {
      requestHeader: () => ({ config: { provider: "verification-provider", model: "verification-model" } })
    }
  };
  const result = await engine.search(agent, { query: "verification query", maxResults: 1 });
  if (fetches !== 1 || result.sources?.[0]?.url !== "https://source.invalid/result") {
    throw new Error("follow-model search did not normalize the Provider response");
  }

  const unknown = new FollowModelSearchEngine({
    fetch: async () => { throw new Error("an unknown Provider must not be probed"); },
    resolveCredential: async () => undefined
  });
  try {
    await unknown.search(agent, { query: "verification query" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("does not support automatic web search") && !message.includes("DEEPSEEK_API_KEY")) return;
    throw new Error(`follow-model search guidance is not Provider-neutral: ${message}`);
  }
  throw new Error("follow-model search unexpectedly probed an undeclared Provider");
}

async function verifyPermissionPresetLocalization(nodeModules) {
  const packageRoots = await findInstalledPackages([nodeModules], "@deepseek-ai/dsh-client-ui-permission-presets");
  if (packageRoots.length !== 1) {
    throw new Error(`expected one permission preset package, found ${packageRoots.length}`);
  }
  const client = await readFile(join(packageRoots[0], "lib", "client.js"), "utf8");
  for (const marker of [
    '"preset.readOnly": "仅可查看"',
    '"preset.workspaceWrite": "工作区内修改"',
    '"preset.fullAccess": "完全权限"',
    "displayPermissionPreset(option.value, option.name, t)"
  ]) {
    if (!client.includes(marker)) {
      throw new Error(`permission preset localization is incomplete: missing ${JSON.stringify(marker)}`);
    }
  }
}

for (const field of ["sourceDateEpoch", "desktopVersion", "release", "harness", "node", "toolchain", "bundledPackages", "nativeAssets", "targets"]) {
  if (lock[field] === undefined) throw new Error(`harness lock is missing ${field}`);
}
if (lock.schemaVersion !== 3) throw new Error(`unsupported harness lock schema: ${lock.schemaVersion}`);
if (!(["local", "community", "stable"].includes(lock.release.channel))
  || typeof lock.release.sourcePinned !== "boolean") {
  throw new Error("harness lock has an invalid release profile");
}
if (lock.harness.commit.length !== 40) throw new Error("Harness commit must be a full SHA");
if (lock.release.sourcePinned) {
  assertPinnedHarnessSource({
    repository: lock.harness.sourceUrl,
    commit: lock.harness.commit
  }, toolchain.harnessSource);
}
if (new Set(lock.targets).size !== lock.targets.length) throw new Error("harness targets contain duplicates");
if (JSON.stringify(lock.desktopPatches) !== JSON.stringify(toolchain.desktopPatches)) {
  throw new Error("generated Harness desktop patch metadata does not match the toolchain lock");
}
for (const patch of toolchain.desktopPatches) {
  await verifyDesktopPatchAsset(join(harnessRoot, "patches"), patch);
}
for (const target of lock.targets) {
  if (!lock.nativeAssets[target]) throw new Error(`harness lock is missing native assets for ${target}`);
}
const pnpmLock = await readFile(join(harnessRoot, "pnpm-lock.yaml"), "utf8");
const harnessPackage = JSON.parse(await readFile(join(harnessRoot, "package.json"), "utf8"));
for (const [name, expected] of Object.entries(lock.bundledPackages)) {
  if (harnessPackage.dependencies?.[name] !== expected.version) {
    throw new Error(`harness package does not lock ${name}@${expected.version}`);
  }
  if (!pnpmLock.includes(`${name}@${expected.version}`) || !pnpmLock.includes(expected.integrity)) {
    throw new Error(`pnpm lock does not match bundled package ${name}@${expected.version}`);
  }
}
const prepared = join(generatedRoot, "harness", "prepared");
if (await hashTree(prepared) !== lock.harness.sha256) {
  throw new Error("generated Harness checksum does not match harness-lock.json");
}
await verifyPatches(join(prepared, "node_modules"));
await verifyFinalToolCallIdentity(join(prepared, "node_modules"));
await verifyFollowModelSearch(join(prepared, "node_modules"));
await verifyPermissionPresetLocalization(join(prepared, "node_modules"));

const requested = process.argv[2] || hostTarget();
if (requested) {
  const root = join(harnessRoot, "staging", requested);
  const nativeAssets = lock.nativeAssets[requested];
  const stagedNodeModules = join(root, "node_modules");
  const stagedModuleRoots = [
    stagedNodeModules,
    join(packagePath(stagedNodeModules, lock.harness.packageName), "node_modules")
  ];
  const platform = targetPlatform(requested);
  if (!platform) throw new Error(`target platform profile is missing for ${requested}`);
  for (const item of await listInstalledPackages(stagedModuleRoots)) {
    if (!supportsConstraint(item.manifest.os, platform.os)
      || !supportsConstraint(item.manifest.cpu, platform.cpu)) {
      throw new Error(`harness contains incompatible package for ${requested}: ${item.manifest.name}`);
    }
  }
  const manifest = JSON.parse(await readFile(join(root, "harness-manifest.json"), "utf8"));
  if (await readFile(join(root, "harness-lock.json"), "utf8") !== await readFile(join(generatedRoot, "harness-lock.json"), "utf8")) {
    throw new Error("staged Harness lock does not exactly match the generated lock");
  }
  for (const patch of lock.desktopPatches) {
    await verifyDesktopPatchAsset(join(root, "toolchain", "desktop-patches"), patch);
  }
  if (manifest.schemaVersion !== 2) throw new Error(`unsupported Harness manifest schema: ${manifest.schemaVersion}`);
  if (manifest.target !== requested) throw new Error(`manifest target mismatch: ${manifest.target}`);
  if (manifest.generatedAt !== new Date(lock.sourceDateEpoch * 1_000).toISOString()) {
    throw new Error(`manifest timestamp is not reproducible: ${manifest.generatedAt}`);
  }
  if (manifest.node.archiveSha256 !== lock.node.artifacts[requested]?.sha256) {
    throw new Error(`Node source archive mismatch for ${requested}`);
  }
  if (manifest.node.version !== toolchain.node.version || manifest.node.moduleAbi !== toolchain.node.moduleAbi) {
    throw new Error(`Node version or ABI mismatch in Harness manifest for ${requested}`);
  }
  const developmentFile = manifest.files.find(entry =>
    /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/u.test(entry.path)
      || /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(entry.path));
  if (developmentFile) {
    throw new Error(`harness production closure contains development test file: ${developmentFile.path}`);
  }
  for (const [name, expected] of Object.entries(lock.bundledPackages)) {
    const installed = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
    if (installed.version !== expected.version) {
      throw new Error(`staged Harness contains ${name}@${installed.version}, expected ${expected.version}`);
    }
  }
  const nodePtyPackages = await findInstalledPackages(stagedModuleRoots, "node-pty");
  if (nodePtyPackages.length === 0) throw new Error("staged Harness does not contain node-pty");
  for (const packageRoot of nodePtyPackages) {
    const prebuilds = (await readdir(join(packageRoot, "prebuilds"), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    if (prebuilds.length !== 1 || prebuilds[0] !== nativeAssets.nodePtyPrebuild) {
      throw new Error(`node-pty contains non-target prebuilds: ${prebuilds.join(", ")}`);
    }
  }

  const allKoffiPackages = [...new Set(Object.values(lock.nativeAssets).map(item => item.koffiPackage))];
  for (const packageName of allKoffiPackages) {
    const packageRoots = await findInstalledPackages(stagedModuleRoots, `@koromix/${packageName}`);
    if (packageName !== nativeAssets.koffiPackage && packageRoots.length > 0) {
      throw new Error(`harness contains non-target Koffi package: ${packageName}`);
    }
    if (packageName === nativeAssets.koffiPackage && packageRoots.length === 0) {
      throw new Error(`harness is missing target Koffi package: ${packageName}`);
    }
    for (const packageRoot of packageRoots) {
      const triplets = (await readdir(packageRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
      if (triplets.length !== 1 || triplets[0] !== nativeAssets.koffiTriplet) {
        throw new Error(`Koffi contains non-target native triplets: ${triplets.join(", ")}`);
      }
      await stat(join(packageRoot, nativeAssets.koffiTriplet, "koffi.node"));
    }
  }
  for (const entry of manifest.files) {
    const filename = join(root, entry.path);
    const info = await stat(filename);
    if (platform.os === "win32") {
      if (Object.hasOwn(entry, "mode")) throw new Error(`Windows Harness manifest contains a Unix mode: ${entry.path}`);
    } else if (!Number.isInteger(entry.mode) || entry.mode !== (info.mode & 0o777)) {
      throw new Error(`mode mismatch: ${entry.path}`);
    }
    const actual = createHash("sha256").update(await readFile(filename)).digest("hex");
    if (actual !== entry.sha256) throw new Error(`checksum mismatch: ${entry.path}`);
  }
  await verifyStaticMuslExecutables(root, stagedModuleRoots, manifest, platform);
  const inventoryRoots = [
    stagedNodeModules,
    join(root, "toolchain", "node", "npm"),
    join(root, "toolchain", "node", "npm", "node_modules")
  ];
  const expectedInventory = await packageInventory(inventoryRoots);
  expectedInventory.push({ name: "Node.js", version: toolchain.node.version, license: toolchain.node.license });
  expectedInventory.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const declaredInventory = JSON.parse(await readFile(join(root, "licenses.json"), "utf8"));
  if (JSON.stringify(declaredInventory) !== JSON.stringify(expectedInventory)) {
    throw new Error("Harness license inventory does not exactly match installed packages");
  }
  const sbom = JSON.parse(await readFile(join(root, "sbom.spdx.json"), "utf8"));
  const expectedNamespace = `https://deepseek-desktop.local/${lock.desktopVersion}/sbom/${requested}/${lock.harness.commit}`;
  const sbomInventory = sbom.packages?.map(item => ({
    name: item.name,
    version: item.versionInfo,
    license: item.licenseDeclared
  }));
  if (sbom.spdxVersion !== "SPDX-2.3"
    || sbom.documentNamespace !== expectedNamespace
    || manifest.packageCount !== expectedInventory.length
    || JSON.stringify(sbomInventory) !== JSON.stringify(expectedInventory)
    || sbom.packages.some(item => item.licenseConcluded !== item.licenseDeclared)) {
    throw new Error("harness SPDX inventory does not match the manifest");
  }
  const suffix = requested === "x86_64-pc-windows-msvc" ? ".exe" : "";
  const sidecar = join(desktopRoot, "src-tauri", "binaries", `node-${requested}${suffix}`);
  const sidecarSha256 = createHash("sha256").update(await readFile(sidecar)).digest("hex");
  if (sidecarSha256 !== manifest.node.sha256) throw new Error("Node sidecar checksum does not match the harness manifest");
  const sidecarIdentity = spawnSync(sidecar, ["-p", "JSON.stringify({version:process.versions.node,moduleAbi:process.versions.modules})"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (sidecarIdentity.error) throw sidecarIdentity.error;
  if (sidecarIdentity.status !== 0) {
    throw new Error(`Node sidecar identity check failed: ${(sidecarIdentity.stderr || sidecarIdentity.stdout).trim()}`);
  }
  const actualNode = JSON.parse(sidecarIdentity.stdout.trim());
  if (actualNode.version !== toolchain.node.version || actualNode.moduleAbi !== toolchain.node.moduleAbi) {
    throw new Error(`Node sidecar is ${actualNode.version} ABI ${actualNode.moduleAbi}, expected ${toolchain.node.version} ABI ${toolchain.node.moduleAbi}`);
  }
  const buildToolchain = join(root, "toolchain", "node");
  const npmCli = join(buildToolchain, "npm", "bin", "npm-cli.js");
  const npmManifest = JSON.parse(await readFile(join(buildToolchain, "npm", "package.json"), "utf8"));
  const nodeApiHeaders = requested === "x86_64-pc-windows-msvc" ? [] : [
    "js_native_api.h",
    "js_native_api_types.h",
    "node_api.h",
    "node_api_types.h"
  ];
  await Promise.all([
    ...nodeApiHeaders.map(header => stat(join(buildToolchain, "include", "node", header))),
    stat(npmCli),
    stat(join(root, "licenses", "npm-LICENSE.txt"))
  ]);
  if (nodeApiHeaders.length > 0) {
    const stagedHeaders = (await readdir(join(buildToolchain, "include", "node"))).sort();
    if (JSON.stringify(stagedHeaders) !== JSON.stringify(nodeApiHeaders)) {
      throw new Error(`bundled Node-API headers are not minimal: ${stagedHeaders.join(", ")}`);
    }
  } else if (manifest.files.some(file => file.path.startsWith("toolchain/node/include/"))) {
    throw new Error("Windows Harness carries unused Node-API headers");
  }
  for (const header of nodeApiHeaders) {
    if (!manifest.files.some(file => file.path === `toolchain/node/include/node/${header}`)) {
      throw new Error(`Harness manifest omits bundled Node-API header: ${header}`);
    }
  }
  const npmIdentity = spawnSync(sidecar, [npmCli, "--version"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (npmIdentity.error) throw npmIdentity.error;
  if (npmIdentity.status !== 0) {
    throw new Error(`bundled npm identity check failed: ${(npmIdentity.stderr || npmIdentity.stdout).trim()}`);
  }
  if (npmManifest.name !== "npm"
    || npmIdentity.stdout.trim() !== npmManifest.version
    || manifest.node.npmVersion !== npmManifest.version
    || npmManifest.version !== toolchain.toolchain?.npm) {
    throw new Error("bundled npm does not match the verified Node distribution metadata");
  }
  await verifyPatches(join(root, "node_modules"));
  console.log(`harness manifest verified: ${requested}, ${manifest.files.length} files`);
}
