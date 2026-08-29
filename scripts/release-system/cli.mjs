import { hostname, tmpdir } from "node:os";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  assertNodeId,
  detectHostTarget,
  flag,
  option,
  options,
  parseArguments,
  redactError,
  requireOption,
  sha256File
} from "./common.mjs";
import { ReleaseControllerService } from "./controller-service.mjs";
import { cloneLockedSource } from "./git-source.mjs";
import { requestJson, uploadArtifact } from "./http-client.mjs";
import { ensureAdminToken, startReleaseServer } from "./http-server.mjs";
import { ReleaseStateStore } from "./state-store.mjs";
import { createReleasePlan } from "./release-plan.mjs";

const root = resolve(import.meta.dirname, "../..");
const defaultControllerRoot = join(root, "target", "release-controller");
const defaultControllerUrl = "http://127.0.0.1:47821";

function run(command, args, { cwd, env = process.env, shell = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const label = command.split(/[\\/]/u).at(-1) || "release command";
    console.log(`\n> ${label}`);
    const child = spawn(command, args, { cwd, env, shell, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} exited with code ${String(code)}`));
    });
  });
}

function isLoopback(host) {
  return new Set(["127.0.0.1", "::1", "localhost"]).has(host);
}

async function readToken(path, environmentName) {
  const fromEnvironment = process.env[environmentName]?.trim();
  if (fromEnvironment) return fromEnvironment;
  const token = (await readFile(path, "utf8")).trim();
  if (!token) throw new Error(`token file is empty: ${path}`);
  return token;
}

async function writeTicket(directory, targetId, ticket) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${targetId}.token`);
  await writeFile(path, `${ticket}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function parseTrustedNodes(values) {
  const mappings = new Map();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error("--trusted-node must use target-id=node-id syntax");
    }
    const targetId = value.slice(0, separator);
    if (mappings.has(targetId)) throw new Error(`duplicate trusted node mapping for ${targetId}`);
    mappings.set(targetId, assertNodeId(value.slice(separator + 1)));
  }
  return mappings;
}

async function controllerCommand(parsed) {
  const dataRoot = resolve(option(parsed, "data", defaultControllerRoot));
  const host = option(parsed, "host", "127.0.0.1");
  const port = Number(option(parsed, "port", "47821"));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be between 0 and 65535");
  const cert = option(parsed, "tls-cert");
  const key = option(parsed, "tls-key");
  if (Boolean(cert) !== Boolean(key)) throw new Error("--tls-cert and --tls-key must be provided together");
  if (!isLoopback(host) && !cert) {
    throw new Error("non-loopback release controllers require TLS; provide --tls-cert and --tls-key");
  }
  const store = new ReleaseStateStore(dataRoot);
  await store.initialize();
  const credentials = await ensureAdminToken(dataRoot, process.env.DISTRIBUTED_RELEASE_ADMIN_TOKEN || "");
  const service = new ReleaseControllerService({ store });
  const server = await startReleaseServer({
    service,
    host,
    port,
    adminToken: credentials.token,
    tls: cert ? { cert: resolve(cert), key: resolve(key) } : null
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Release controller listening at ${cert ? "https" : "http"}://${host}:${actualPort}`);
  console.log("Administrator token file created in the controller data directory.");
  console.log("Authorization values are never printed; distribute worker ticket files only to trusted nodes.");
  const close = signal => {
    console.log(`\nReceived ${signal}; stopping release controller.`);
    server.close(error => {
      if (error) console.error(redactError(error));
      process.exit(error ? 1 : 0);
    });
  };
  process.once("SIGINT", () => close("SIGINT"));
  process.once("SIGTERM", () => close("SIGTERM"));
}

async function createCommand(parsed) {
  const controller = option(parsed, "controller", defaultControllerUrl);
  const adminTokenFile = resolve(option(parsed, "admin-token-file", join(defaultControllerRoot, "admin-token")));
  const adminToken = await readToken(adminTokenFile, "DISTRIBUTED_RELEASE_ADMIN_TOKEN");
  const tag = requireOption(parsed, "tag");
  const channel = option(parsed, "channel", "community");
  const signed = flag(parsed, "signed");
  const trustedNodes = parseTrustedNodes(options(parsed, "trusted-node"));
  const preparedDescriptorPath = option(parsed, "prepared-descriptor");
  const prepared = preparedDescriptorPath
    ? JSON.parse(await readFile(resolve(preparedDescriptorPath), "utf8"))
    : null;
  const input = await createReleasePlan({
    root,
    tag,
    channel,
    signed,
    sourceRepository: option(parsed, "source"),
    productName: option(parsed, "product-name", "DeepSeek Desktop"),
    requestedTargetIds: options(parsed, "target"),
    trustedNodes,
    prepared
  });
  const result = await requestJson(controller, "/v1/releases", {
    method: "POST",
    token: adminToken,
    body: input
  });
  const ticketDirectory = resolve(option(parsed, "ticket-dir", join(root, "target", "release-tickets", result.release.id)));
  console.log(`Created distributed release ${result.release.id} for ${tag}.`);
  console.log(`Controller status: ${controller}/v1/releases/${result.release.id}`);
  for (const targetId of input.targets.map(target => target.id)) {
    await writeTicket(ticketDirectory, targetId, result.tickets[targetId]);
    console.log(`${targetId} worker ticket created.`);
  }
  console.log("Transfer each ticket file to its configured trusted node through a private channel.");
}

async function statusCommand(parsed) {
  const controller = option(parsed, "controller", defaultControllerUrl);
  const releaseId = requireOption(parsed, "release");
  const adminToken = await readToken(
    resolve(option(parsed, "admin-token-file", join(defaultControllerRoot, "admin-token"))),
    "DISTRIBUTED_RELEASE_ADMIN_TOKEN"
  );
  const result = await requestJson(controller, `/v1/releases/${encodeURIComponent(releaseId)}`, { token: adminToken });
  console.log(JSON.stringify(result.release, null, 2));
}

async function retryCommand(parsed) {
  const controller = option(parsed, "controller", defaultControllerUrl);
  const releaseId = requireOption(parsed, "release");
  const targetId = requireOption(parsed, "target");
  const adminToken = await readToken(
    resolve(option(parsed, "admin-token-file", join(defaultControllerRoot, "admin-token"))),
    "DISTRIBUTED_RELEASE_ADMIN_TOKEN"
  );
  const result = await requestJson(controller, `/v1/releases/${encodeURIComponent(releaseId)}/tasks/${encodeURIComponent(targetId)}/retry`, {
    method: "POST",
    token: adminToken,
    body: {}
  });
  const ticketDirectory = resolve(option(parsed, "ticket-dir", join(root, "target", "release-tickets", releaseId)));
  await writeTicket(ticketDirectory, targetId, result.ticket);
  console.log(`Reset ${targetId}; replacement one-time ticket created.`);
}

async function publishCommand(parsed) {
  const controller = option(parsed, "controller", defaultControllerUrl);
  const releaseId = requireOption(parsed, "release");
  const adminToken = await readToken(
    resolve(option(parsed, "admin-token-file", join(defaultControllerRoot, "admin-token"))),
    "DISTRIBUTED_RELEASE_ADMIN_TOKEN"
  );
  const provider = option(parsed, "provider", "filesystem");
  const body = { provider };
  if (provider === "filesystem") body.destination = option(parsed, "destination");
  if (provider === "github") {
    body.repository = requireOption(parsed, "repository");
    body.notes = option(parsed, "notes");
  }
  const result = await requestJson(controller, `/v1/releases/${encodeURIComponent(releaseId)}/publish`, {
    method: "POST",
    token: adminToken,
    body
  });
  console.log(`Published through ${result.provider}.`);
  console.log(`Assets: ${(result.assets || []).join(", ")}`);
}

function defaultNodeId(targetId) {
  const normalizedHost = hostname().replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^[^A-Za-z0-9]+/u, "");
  return assertNodeId(`${normalizedHost || "worker"}.${targetId}`);
}

function preparedEnvironment(plan, preparedRoot) {
  if (!plan.prepared || !preparedRoot) return {};
  return {
    DEEPSEEK_DESKTOP_PREPARED_ROOT: preparedRoot,
    DEEPSEEK_DESKTOP_PREPARED_DESCRIPTOR: JSON.stringify(plan.prepared),
    DEEPSEEK_DESKTOP_RELEASE_PLAN: JSON.stringify({
      tag: plan.tag,
      version: plan.version,
      channel: plan.channel,
      signed: plan.signed,
      source: plan.source,
      runtime: plan.runtime
    })
  };
}

async function runNativePackage(checkout, plan, preparedRoot = "") {
  const script = plan.channel === "community" ? "package:community" : "desktop:package";
  const command = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const env = {
    ...process.env,
    DESKTOP_APP_VERSION: plan.version,
    RUNTIME_REPOSITORY: plan.runtime.repository,
    RUNTIME_REF: plan.runtime.commit,
    RELEASE_CHANNEL: plan.channel,
    RELEASE_SIGNED: String(plan.signed),
    ...preparedEnvironment(plan, preparedRoot)
  };
  delete env.DISTRIBUTED_RELEASE_ADMIN_TOKEN;
  delete env.DISTRIBUTED_RELEASE_WORKER_TOKEN;
  delete env.DISTRIBUTED_RELEASE_GITHUB_TOKEN;
  await run(command, [`pnpm@11.7.0`, script], { cwd: checkout, env, shell: process.platform === "win32" });
}

async function runContainerPackage(checkout, plan, image, preparedRoot = "") {
  if (process.platform !== "linux") throw new Error("--container-image is supported only by Linux workers");
  const script = plan.channel === "community" ? "package:community" : "desktop:package";
  const environment = [
    `DESKTOP_APP_VERSION=${plan.version}`,
    `RUNTIME_REPOSITORY=${plan.runtime.repository}`,
    `RUNTIME_REF=${plan.runtime.commit}`,
    `RELEASE_CHANNEL=${plan.channel}`,
    `RELEASE_SIGNED=${String(plan.signed)}`,
    ...Object.entries(preparedEnvironment(plan, preparedRoot)).map(([key, value]) => `${key}=${value}`)
  ];
  const args = ["run", "--rm", "--volume", `${checkout}:/workspace`, "--workdir", "/workspace"];
  for (const value of environment) args.push("--env", value);
  args.push(image, "bash", "-lc", `corepack pnpm@11.7.0 ${script}`);
  await run("docker", args, { cwd: checkout });
}

async function workerCommand(parsed) {
  const target = await detectHostTarget();
  const nodeId = assertNodeId(option(parsed, "node-id", process.env.DISTRIBUTED_RELEASE_NODE_ID || defaultNodeId(target.id)));
  if (flag(parsed, "identify")) {
    console.log(JSON.stringify({ nodeId, targetId: target.id, platform: process.platform, architecture: process.arch }, null, 2));
    return;
  }
  const controller = option(parsed, "controller", defaultControllerUrl);
  const tokenFileValue = option(parsed, "token-file");
  const tokenFile = tokenFileValue ? resolve(tokenFileValue) : "";
  const tokenFromStdin = flag(parsed, "token-stdin")
    ? (await new Promise((resolvePromise, reject) => {
      const chunks = [];
      process.stdin.on("data", chunk => chunks.push(chunk));
      process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8").trim()));
      process.stdin.on("error", reject);
    }))
    : "";
  const ticket = process.env.DISTRIBUTED_RELEASE_WORKER_TOKEN?.trim()
    || (tokenFile ? (await readFile(tokenFile, "utf8")).trim() : "")
    || tokenFromStdin;
  if (!ticket) throw new Error("worker requires --token-file, --token-stdin, or DISTRIBUTED_RELEASE_WORKER_TOKEN");
  const claim = await requestJson(controller, "/v1/worker/claim", {
    method: "POST",
    body: {
      ticket,
      targetId: target.id,
      nodeId,
      host: { platform: process.platform, architecture: process.arch, hostname: hostname() }
    }
  });
  if (tokenFile) await rm(tokenFile, { force: true });
  const task = claim.plan.tasks.find(candidate => candidate.id === claim.taskId);
  if (!task || task.targetId !== target.id || task.triple !== target.triple) {
    throw new Error("claimed task does not match detected worker target");
  }
  const workRoot = resolve(option(parsed, "work-root", join(tmpdir(), "deepseek-desktop-release-worker")));
  const preparedRoot = option(parsed, "prepared-root") ? resolve(option(parsed, "prepared-root")) : "";
  const checkout = join(workRoot, claim.taskId, "source");
  const keepWork = flag(parsed, "keep-work");
  try {
    await rm(dirname(checkout), { recursive: true, force: true });
    await mkdir(dirname(checkout), { recursive: true });
    await requestJson(controller, `/v1/tasks/${encodeURIComponent(claim.taskId)}/status`, {
      method: "POST",
      token: claim.lease,
      body: { status: "building" }
    });
    await cloneLockedSource({
      repository: claim.plan.source.repository,
      sourceBundle: option(parsed, "source-bundle"),
      tag: claim.plan.tag,
      commit: claim.plan.source.commit,
      destination: checkout
    });
    const lock = JSON.parse(await readFile(join(checkout, "runtime", "toolchain-lock.json"), "utf8"));
    if (
      lock.runtimeSource?.repository !== claim.plan.runtime.repository
      || lock.runtimeSource?.ref !== claim.plan.runtime.ref
      || lock.runtimeSource?.commit !== claim.plan.runtime.commit
    ) {
      throw new Error("worker source Runtime lock does not match release plan");
    }
    const containerImage = option(parsed, "container-image");
    if (containerImage) {
      if (!target.optionalContainer) throw new Error(`target ${target.id} does not support container packaging`);
      await runContainerPackage(checkout, claim.plan, containerImage, preparedRoot);
    } else {
      await runNativePackage(checkout, claim.plan, preparedRoot);
    }
    const outputDirectory = join(checkout, "release", claim.plan.version, target.triple);
    const entries = (await readdir(outputDirectory, { withFileTypes: true })).filter(entry => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) throw new Error("desktop package command produced no release artifacts");
    await requestJson(controller, `/v1/tasks/${encodeURIComponent(claim.taskId)}/status`, {
      method: "POST",
      token: claim.lease,
      body: { status: "uploading" }
    });
    for (const entry of entries) {
      const path = join(outputDirectory, entry.name);
      await uploadArtifact(controller, claim.taskId, claim.lease, path, entry.name, await sha256File(path));
      console.log(`Uploaded ${entry.name}`);
    }
    const completed = await requestJson(controller, `/v1/tasks/${encodeURIComponent(claim.taskId)}/complete`, {
      method: "POST",
      token: claim.lease,
      body: {}
    });
    console.log(`Completed ${target.id}; release status is ${completed.release.status}.`);
  } catch (error) {
    try {
      await requestJson(controller, `/v1/tasks/${encodeURIComponent(claim.taskId)}/status`, {
        method: "POST",
        token: claim.lease,
        body: { status: "failed", message: redactError(error) }
      });
    } catch (reportError) {
      console.error(`Failed to report worker error: ${redactError(reportError)}`);
    }
    throw error;
  } finally {
    if (!keepWork) await rm(dirname(checkout), { recursive: true, force: true });
  }
}

const commands = new Map([
  ["controller", controllerCommand],
  ["create", createCommand],
  ["status", statusCommand],
  ["retry", retryCommand],
  ["publish", publishCommand],
  ["worker", workerCommand]
]);

const [commandName, ...argv] = process.argv.slice(2);
const command = commands.get(commandName);
if (!command) {
  console.error(`Usage: node scripts/release-system/cli.mjs <${[...commands.keys()].join("|")}> [options]`);
  process.exit(1);
}

try {
  await command(parseArguments(argv));
} catch (error) {
  console.error(redactError(error));
  process.exit(1);
}
