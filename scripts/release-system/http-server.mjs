import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createOpaqueToken, redactError, resolveInside, tokenDigest } from "./common.mjs";

const jsonLimit = 1024 * 1024;

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > jsonLimit) throw new Error("request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function bearer(request) {
  const match = /^Bearer\s+(.+)$/iu.exec(request.headers.authorization || "");
  return match?.[1] || "";
}

function requireAdmin(request, adminDigest) {
  const token = bearer(request);
  if (!token || tokenDigest(token) !== adminDigest) {
    const error = new Error("administrator authentication failed");
    error.statusCode = 401;
    throw error;
  }
}

async function receiveArtifact(request, service, taskId, lease, name) {
  const declaredSha256 = String(request.headers["x-artifact-sha256"] || "").toLowerCase();
  const declaredSize = Number(request.headers["x-artifact-size"] || request.headers["content-length"] || 0);
  const authorized = await service.authorizeUpload(taskId, lease, name, declaredSha256, declaredSize);
  const destination = join(authorized.directory, authorized.name);
  try {
    await access(destination);
    throw new Error(`artifact ${authorized.name} already exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(authorized.directory, { recursive: true });
  const temporary = `${destination}.${process.pid}.upload`;
  await rm(temporary, { force: true });
  const hash = createHash("sha256");
  let size = 0;
  const verifier = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > declaredSize) {
        callback(new Error("artifact upload exceeds declared size"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(request, verifier, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    if (size !== declaredSize) throw new Error(`artifact size ${size} does not match declared ${declaredSize}`);
    const sha256 = hash.digest("hex");
    if (sha256 !== declaredSha256) throw new Error(`artifact SHA-256 ${sha256} does not match declared ${declaredSha256}`);
    await rename(temporary, destination);
    await service.recordArtifact(taskId, lease, { name: authorized.name, sha256, size });
    return { name: authorized.name, sha256, size };
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function ensureAdminToken(controllerRoot, configuredToken = "") {
  const tokenPath = resolveInside(controllerRoot, "admin-token");
  if (configuredToken.trim()) {
    await mkdir(controllerRoot, { recursive: true });
    await writeFile(tokenPath, `${configuredToken.trim()}\n`, { mode: 0o600 });
    return { token: configuredToken.trim(), tokenPath };
  }
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (token) return { token, tokenPath };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const token = createOpaqueToken();
  await mkdir(controllerRoot, { recursive: true });
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  return { token, tokenPath };
}

export async function startReleaseServer({ service, host = "127.0.0.1", port = 47821, adminToken, tls = null }) {
  const adminDigest = tokenDigest(adminToken);
  const handler = async (request, response) => {
    try {
      const url = new URL(request.url || "/", `${tls ? "https" : "http"}://${request.headers.host || "localhost"}`);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        sendJson(response, 200, { ok: true, service: "deepseek-desktop-release-controller", schemaVersion: 1 });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/releases") {
        requireAdmin(request, adminDigest);
        sendJson(response, 201, await service.createRelease(await readJson(request)));
        return;
      }
      const releaseMatch = /^\/v1\/releases\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && releaseMatch) {
        requireAdmin(request, adminDigest);
        sendJson(response, 200, { release: await service.getRelease(decodeURIComponent(releaseMatch[1])) });
        return;
      }
      const retryMatch = /^\/v1\/releases\/([^/]+)\/tasks\/([^/]+)\/retry$/u.exec(url.pathname);
      if (request.method === "POST" && retryMatch) {
        requireAdmin(request, adminDigest);
        sendJson(response, 200, await service.retryTask(decodeURIComponent(retryMatch[1]), decodeURIComponent(retryMatch[2])));
        return;
      }
      const publishMatch = /^\/v1\/releases\/([^/]+)\/publish$/u.exec(url.pathname);
      if (request.method === "POST" && publishMatch) {
        requireAdmin(request, adminDigest);
        sendJson(response, 200, await service.publishRelease(decodeURIComponent(publishMatch[1]), await readJson(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/worker/claim") {
        sendJson(response, 200, await service.claimTask(await readJson(request)));
        return;
      }
      const statusMatch = /^\/v1\/tasks\/([^/]+)\/status$/u.exec(url.pathname);
      if (request.method === "POST" && statusMatch) {
        sendJson(response, 200, { release: await service.updateTask(decodeURIComponent(statusMatch[1]), bearer(request), await readJson(request)) });
        return;
      }
      const uploadMatch = /^\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "PUT" && uploadMatch) {
        const artifact = await receiveArtifact(
          request,
          service,
          decodeURIComponent(uploadMatch[1]),
          bearer(request),
          decodeURIComponent(uploadMatch[2])
        );
        sendJson(response, 201, { artifact });
        return;
      }
      const completeMatch = /^\/v1\/tasks\/([^/]+)\/complete$/u.exec(url.pathname);
      if (request.method === "POST" && completeMatch) {
        sendJson(response, 200, { release: await service.completeTask(decodeURIComponent(completeMatch[1]), bearer(request)) });
        return;
      }
      sendJson(response, 404, { error: "route not found" });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      sendJson(response, status, { error: redactError(error) });
    }
  };
  let server;
  if (tls) {
    server = https.createServer({ cert: await readFile(tls.cert), key: await readFile(tls.key) }, handler);
  } else {
    server = http.createServer(handler);
  }
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
