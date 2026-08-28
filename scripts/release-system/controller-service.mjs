import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertCommit,
  assertNodeId,
  assertSourceRepository,
  createId,
  createOpaqueToken,
  loadTargets,
  publicRelease,
  resolveInside,
  safeArtifactName,
  sha256File,
  tokenDigest
} from "./common.mjs";
import { resolveRemoteTag } from "./git-source.mjs";
import { publishWithProvider } from "./providers/index.mjs";
import { scanArtifactPaths } from "../lib/artifact-scan.mjs";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const shaPattern = /^[0-9a-f]{64}$/u;
const textLeakPatterns = [
  { pattern: /(?:^|[\\/])\.env(?:[.\\/]|$)/imu, label: ".env path" },
  { pattern: /\/Users\/[^/\s]+\//u, label: "macOS home path" },
  { pattern: /[A-Za-z]:\\Users\\[^\\\s]+\\/u, label: "Windows home path" },
  { pattern: /\/home\/[^/\s]+\//u, label: "Linux home path" },
  { pattern: /\bsk-[A-Za-z0-9._-]{12,}\b/u, label: "API key" },
  { pattern: /(?:token|password|secret)\s*[=:]\s*["']?[A-Za-z0-9._-]{16,}/iu, label: "secret value" }
];

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function futureIso(clock, milliseconds) {
  return new Date(clock() + milliseconds).toISOString();
}

function assertVersion(version) {
  const value = version.trim();
  if (!semverPattern.test(value)) throw new Error("release version must be valid SemVer without a v prefix");
  return value;
}

function assertChannel(channel) {
  if (!new Set(["local", "community", "stable"]).has(channel)) throw new Error(`unsupported release channel ${channel}`);
  return channel;
}

function assertLease(task, token, clock) {
  if (!token || task.leaseDigest !== tokenDigest(token)) throw new Error("invalid task lease");
  if (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= clock()) throw new Error("task lease has expired");
  if (!new Set(["claimed", "building", "uploading"]).has(task.status)) throw new Error(`task is not active: ${task.status}`);
}

function findTask(state, taskId) {
  for (const release of Object.values(state.releases)) {
    const task = release.tasks.find(candidate => candidate.id === taskId);
    if (task) return { release, task };
  }
  throw new Error(`unknown release task ${taskId}`);
}

function parseChecksums(text) {
  const checksums = new Map();
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64})\s{2}([^/\\]+)$/u.exec(line.trim());
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    if (checksums.has(match[2])) throw new Error(`duplicate SHA256SUMS entry ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function scanTextArtifact(name, text) {
  for (const leak of textLeakPatterns) {
    if (leak.pattern.test(text)) throw new Error(`${name} contains forbidden ${leak.label}`);
  }
}

export class ReleaseControllerService {
  constructor({ store, clock = Date.now, verifyRemoteTag = resolveRemoteTag, ticketTtlMs = 30 * 60_000, leaseTtlMs = 6 * 60 * 60_000 }) {
    this.store = store;
    this.clock = clock;
    this.verifyRemoteTag = verifyRemoteTag;
    this.ticketTtlMs = ticketTtlMs;
    this.leaseTtlMs = leaseTtlMs;
  }

  async createRelease(input) {
    const { byId } = await loadTargets();
    const repository = assertSourceRepository(input.source?.repository || "");
    const tag = input.source?.tag?.trim();
    if (!tag) throw new Error("release source tag is required");
    const desktopCommit = assertCommit(input.source?.commit || "", "desktop commit");
    const remoteCommit = await this.verifyRemoteTag(repository, tag);
    if (remoteCommit !== desktopCommit) throw new Error(`source tag ${tag} resolves to ${remoteCommit}, expected ${desktopCommit}`);
    const runtimeRepository = assertSourceRepository(input.runtime?.repository || "");
    const runtimeCommit = assertCommit(input.runtime?.commit || "", "runtime commit");
    const runtimeRef = input.runtime?.ref?.trim();
    if (!runtimeRef) throw new Error("runtime ref is required for a distributed release");
    const version = assertVersion(input.version || "");
    if (tag !== version && tag !== `v${version}`) throw new Error(`release tag ${tag} does not match version ${version}`);
    const channel = assertChannel(input.channel || "community");
    const signed = input.signed === true;
    if (channel === "community" && signed) throw new Error("community release cannot claim trusted publisher signing");
    if (channel === "stable" && !signed) throw new Error("stable release must be marked signed");
    const requestedTargets = input.targets;
    if (!Array.isArray(requestedTargets) || requestedTargets.length === 0) throw new Error("at least one release target is required");
    const seen = new Set();
    const normalizedTargets = requestedTargets.map(requested => {
      const target = byId.get(requested.id);
      if (!target) throw new Error(`unknown release target ${String(requested.id)}`);
      if (seen.has(target.id)) throw new Error(`duplicate release target ${target.id}`);
      seen.add(target.id);
      const trustedNodeId = requested.trustedNodeId ? assertNodeId(requested.trustedNodeId) : "";
      if (channel !== "local" && !trustedNodeId) {
        throw new Error(`${channel} release target ${target.id} must be bound to a trusted node id`);
      }
      return { target, trustedNodeId };
    });
    const releaseId = createId(`release-${version.replace(/[^A-Za-z0-9.-]/gu, "-")}`);
    const createdAt = nowIso(this.clock);
    const tickets = {};
    const tasks = normalizedTargets.map(({ target, trustedNodeId }) => {
      const ticket = createOpaqueToken();
      tickets[target.id] = ticket;
      return {
        id: createId(`task-${target.id}`),
        targetId: target.id,
        triple: target.triple,
        trustedNodeId,
        status: "waiting",
        ticketDigest: tokenDigest(ticket),
        ticketExpiresAt: futureIso(this.clock, this.ticketTtlMs),
        leaseDigest: null,
        leaseExpiresAt: null,
        node: null,
        artifacts: {},
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
        error: null
      };
    });
    const release = {
      id: releaseId,
      schemaVersion: 1,
      productName: input.productName?.trim() || "DeepSeek Desktop",
      version,
      tag,
      channel,
      signed,
      source: { repository, commit: desktopCommit },
      runtime: { repository: runtimeRepository, ref: runtimeRef, commit: runtimeCommit },
      status: "waiting",
      createdAt,
      updatedAt: createdAt,
      tasks,
      publication: null
    };
    await this.store.transaction(state => {
      if (Object.values(state.releases).some(candidate => candidate.tag === tag)) {
        throw new Error(`release tag ${tag} already exists in controller state`);
      }
      state.releases[releaseId] = release;
    });
    return { release: publicRelease(release), tickets };
  }

  async getRelease(releaseId) {
    const state = await this.store.read();
    const release = state.releases[releaseId];
    if (!release) throw new Error(`unknown release ${releaseId}`);
    return publicRelease(release);
  }

  async claimTask({ ticket, targetId, nodeId, host }) {
    const digest = tokenDigest(ticket || "");
    const normalizedNodeId = assertNodeId(nodeId || "");
    return this.store.transaction(state => {
      for (const release of Object.values(state.releases)) {
        const task = release.tasks.find(candidate => candidate.ticketDigest === digest);
        if (!task) continue;
        if (task.status !== "waiting") throw new Error("worker ticket has already been used");
        if (Date.parse(task.ticketExpiresAt) <= this.clock()) throw new Error("worker ticket has expired");
        if (task.targetId !== targetId) throw new Error(`worker ticket is bound to ${task.targetId}, not ${targetId}`);
        if (task.trustedNodeId && task.trustedNodeId !== normalizedNodeId) {
          throw new Error(`worker ticket is bound to trusted node ${task.trustedNodeId}`);
        }
        const lease = createOpaqueToken();
        task.ticketDigest = null;
        task.status = "claimed";
        task.leaseDigest = tokenDigest(lease);
        task.leaseExpiresAt = futureIso(this.clock, this.leaseTtlMs);
        task.node = {
          id: normalizedNodeId,
          platform: host?.platform || "unknown",
          architecture: host?.architecture || "unknown",
          hostname: host?.hostname || "unknown"
        };
        task.attempts += 1;
        task.updatedAt = nowIso(this.clock);
        release.status = "building";
        release.updatedAt = task.updatedAt;
        return { releaseId: release.id, taskId: task.id, lease, leaseExpiresAt: task.leaseExpiresAt, plan: publicRelease(release) };
      }
      throw new Error("invalid or unknown worker ticket");
    });
  }

  async updateTask(taskId, lease, { status, message = "" }) {
    if (!new Set(["building", "uploading", "failed"]).has(status)) throw new Error(`unsupported worker status ${status}`);
    return this.store.transaction(state => {
      const { release, task } = findTask(state, taskId);
      assertLease(task, lease, this.clock);
      task.status = status;
      task.updatedAt = nowIso(this.clock);
      task.error = status === "failed" ? message.slice(0, 2000) : null;
      if (status === "failed") {
        task.leaseDigest = null;
        task.leaseExpiresAt = null;
        release.status = "failed";
      }
      release.updatedAt = task.updatedAt;
      return publicRelease(release);
    });
  }

  async authorizeUpload(taskId, lease, name, declaredSha256, declaredSize) {
    const state = await this.store.read();
    const { release, task } = findTask(state, taskId);
    assertLease(task, lease, this.clock);
    const artifactName = safeArtifactName(name);
    if (!shaPattern.test(declaredSha256)) throw new Error("artifact upload requires a lowercase SHA-256 digest");
    if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > 2 * 1024 * 1024 * 1024) {
      throw new Error("artifact upload size is invalid or exceeds 2 GiB");
    }
    const directory = resolveInside(this.store.root, "incoming", release.id, task.targetId);
    await mkdir(directory, { recursive: true });
    return { releaseId: release.id, task, name: artifactName, directory };
  }

  async recordArtifact(taskId, lease, artifact) {
    return this.store.transaction(state => {
      const { release, task } = findTask(state, taskId);
      assertLease(task, lease, this.clock);
      if (task.artifacts[artifact.name]) throw new Error(`artifact ${artifact.name} was already uploaded`);
      task.artifacts[artifact.name] = {
        sha256: artifact.sha256,
        size: artifact.size,
        receivedAt: nowIso(this.clock)
      };
      task.status = "uploading";
      task.updatedAt = nowIso(this.clock);
      release.updatedAt = task.updatedAt;
      return publicRelease(release);
    });
  }

  async completeTask(taskId, lease) {
    const { byId } = await loadTargets();
    return this.store.transaction(async state => {
      const { release, task } = findTask(state, taskId);
      assertLease(task, lease, this.clock);
      const target = byId.get(task.targetId);
      const names = Object.keys(task.artifacts).sort();
      const installers = names.filter(name => target.installerExtensions.some(extension => name.endsWith(extension)));
      if (installers.length !== target.installerCount) {
        throw new Error(`target ${target.id} requires ${target.installerCount} installer artifacts, received ${installers.length}`);
      }
      const buildInfoName = `BUILD-INFO.${target.triple}.json`;
      const requiredNames = new Set([...installers, buildInfoName, "SHA256SUMS"]);
      const unexpected = names.filter(name => !requiredNames.has(name));
      if (unexpected.length > 0 || names.length !== requiredNames.size) {
        throw new Error(`target ${target.id} uploaded an unexpected artifact set: ${names.join(", ")}`);
      }
      const directory = resolveInside(this.store.root, "incoming", release.id, task.targetId);
      const buildInfoText = await readFile(join(directory, buildInfoName), "utf8");
      const checksumText = await readFile(join(directory, "SHA256SUMS"), "utf8");
      scanTextArtifact(buildInfoName, buildInfoText);
      scanTextArtifact("SHA256SUMS", checksumText);
      await scanArtifactPaths(installers.map(name => join(directory, name)));
      const buildInfo = JSON.parse(buildInfoText);
      if (buildInfo.application?.version !== release.version) throw new Error("BUILD-INFO application version does not match release plan");
      if (buildInfo.desktop?.commit !== release.source.commit || buildInfo.desktop?.dirty !== false) {
        throw new Error("BUILD-INFO desktop source is dirty or does not match release plan");
      }
      if (buildInfo.harness?.repository !== release.runtime.repository || buildInfo.harness?.commit !== release.runtime.commit) {
        throw new Error("BUILD-INFO Runtime source does not match release plan");
      }
      if (buildInfo.target !== target.triple || buildInfo.channel !== release.channel || buildInfo.signed !== release.signed) {
        throw new Error("BUILD-INFO target or release channel does not match release plan");
      }
      if (buildInfo.artifactAudit?.schemaVersion !== 1
        || buildInfo.artifactAudit?.scannerVersion !== 1
        || !Number.isSafeInteger(buildInfo.artifactAudit?.fileCount)
        || buildInfo.artifactAudit.fileCount <= 0
        || !Number.isSafeInteger(buildInfo.artifactAudit?.byteCount)
        || buildInfo.artifactAudit.byteCount <= 0) {
        throw new Error("BUILD-INFO is missing a valid artifact security audit");
      }
      const checksums = parseChecksums(checksumText);
      for (const name of [...installers, buildInfoName]) {
        if (checksums.get(name) !== task.artifacts[name].sha256) throw new Error(`SHA256SUMS does not match uploaded ${name}`);
      }
      if (checksums.size !== installers.length + 1) throw new Error("SHA256SUMS contains unexpected entries");
      task.status = "completed";
      task.leaseDigest = null;
      task.leaseExpiresAt = null;
      task.completedAt = nowIso(this.clock);
      task.updatedAt = task.completedAt;
      task.error = null;
      release.status = release.tasks.every(candidate => candidate.status === "completed") ? "ready" : "building";
      release.updatedAt = task.updatedAt;
      return publicRelease(release);
    });
  }

  async retryTask(releaseId, targetId) {
    const ticket = createOpaqueToken();
    const release = await this.store.transaction(state => {
      const candidate = state.releases[releaseId];
      if (!candidate) throw new Error(`unknown release ${releaseId}`);
      const task = candidate.tasks.find(value => value.targetId === targetId);
      if (!task) throw new Error(`release ${releaseId} does not include target ${targetId}`);
      const leaseExpired = task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) <= this.clock();
      if (!new Set(["failed", "waiting"]).has(task.status) && !leaseExpired) {
        throw new Error(`task ${targetId} cannot be retried while ${task.status}`);
      }
      task.status = "waiting";
      task.ticketDigest = tokenDigest(ticket);
      task.ticketExpiresAt = futureIso(this.clock, this.ticketTtlMs);
      task.leaseDigest = null;
      task.leaseExpiresAt = null;
      task.node = null;
      task.artifacts = {};
      task.error = null;
      task.updatedAt = nowIso(this.clock);
      candidate.status = candidate.tasks.some(value => value.status === "completed") ? "building" : "waiting";
      candidate.updatedAt = task.updatedAt;
      return publicRelease(candidate);
    });
    await rm(resolveInside(this.store.root, "incoming", releaseId, targetId), { recursive: true, force: true });
    return { release, ticket };
  }

  async publishRelease(releaseId, options = {}) {
    const release = await this.getRelease(releaseId);
    if (release.status !== "ready") {
      const waiting = release.tasks.filter(task => task.status !== "completed").map(task => `${task.targetId}:${task.status}`);
      throw new Error(`release is not ready; waiting for ${waiting.join(", ")}`);
    }
    const stagingDirectory = resolveInside(this.store.root, "publications", release.id, "staging");
    await rm(stagingDirectory, { recursive: true, force: true });
    await mkdir(stagingDirectory, { recursive: true });
    const publishedNames = new Set();
    const checksumLines = [];
    for (const task of release.tasks) {
      const sourceDirectory = resolveInside(this.store.root, "incoming", release.id, task.targetId);
      for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name === "SHA256SUMS" || entry.name.startsWith("BUILD-INFO.")) continue;
        const publishedName = entry.name.replaceAll(" ", ".");
        if (publishedNames.has(publishedName)) throw new Error(`duplicate published artifact ${publishedName}`);
        publishedNames.add(publishedName);
        const source = join(sourceDirectory, entry.name);
        const destination = join(stagingDirectory, publishedName);
        await copyFile(source, destination);
        checksumLines.push(`${await sha256File(destination)}  ${publishedName}`);
      }
    }
    if (publishedNames.size === 0) throw new Error("release has no installer artifacts to publish");
    checksumLines.sort((left, right) => left.localeCompare(right));
    await writeFile(join(stagingDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
    const result = await publishWithProvider({ release, stagingDirectory, options, controllerRoot: this.store.root });
    await this.store.transaction(state => {
      const candidate = state.releases[releaseId];
      if (!candidate || candidate.status !== "ready") throw new Error("release state changed during publication");
      candidate.status = "published";
      candidate.publication = { ...result, publishedAt: nowIso(this.clock) };
      candidate.updatedAt = candidate.publication.publishedAt;
    });
    return { ...result, assets: [...publishedNames].sort(), sha256sums: join(stagingDirectory, "SHA256SUMS") };
  }
}
