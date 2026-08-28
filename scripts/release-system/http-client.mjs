import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const JSON_RESPONSE_LIMIT = 4 * 1024 * 1024;
const JSON_REQUEST_TIMEOUT_MS = 60_000;
const ARTIFACT_UPLOAD_TIMEOUT_MS = 30 * 60_000;

function requestModule(url) {
  return url.protocol === "https:" ? https : http;
}

async function parseResponse(response, limit = JSON_RESPONSE_LIMIT) {
  const declaredLength = Number(response.headers["content-length"] || 0);
  if (declaredLength > limit) {
    response.destroy();
    throw new Error(`release controller response exceeds ${limit} bytes`);
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of response) {
    received += chunk.length;
    if (received > limit) {
      response.destroy();
      throw new Error(`release controller response exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`release controller returned invalid JSON with status ${response.statusCode}`);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(body.error || `release controller returned HTTP ${response.statusCode}`);
  }
  return body;
}

function applyDeadline(request, timeoutMs, operation) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${operation} timeout must be a positive integer`);
  }
  const timer = setTimeout(() => {
    request.destroy(new Error(`${operation} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  request.once("close", () => clearTimeout(timer));
}

export function controllerUrl(base, path) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${path}`;
  url.search = "";
  return url;
}

export async function requestJson(base, path, {
  method = "GET",
  token = "",
  body = undefined,
  timeoutMs = JSON_REQUEST_TIMEOUT_MS,
  responseLimit = JSON_RESPONSE_LIMIT
} = {}) {
  const url = controllerUrl(base, path);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const request = requestModule(url).request(url, {
      method,
      headers: {
        accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    }, response => { parseResponse(response, responseLimit).then(resolve, reject); });
    applyDeadline(request, timeoutMs, "release controller request");
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export async function uploadArtifact(base, taskId, token, path, name, sha256, {
  timeoutMs = ARTIFACT_UPLOAD_TIMEOUT_MS,
  responseLimit = JSON_RESPONSE_LIMIT
} = {}) {
  const info = await stat(path);
  const url = controllerUrl(base, `/v1/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(name)}`);
  return new Promise((resolve, reject) => {
    const request = requestModule(url).request(url, {
      method: "PUT",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "content-length": info.size,
        "x-artifact-size": info.size,
        "x-artifact-sha256": sha256
      }
    }, response => { parseResponse(response, responseLimit).then(resolve, reject); });
    applyDeadline(request, timeoutMs, "release artifact upload");
    const stream = createReadStream(path);
    request.on("error", error => {
      stream.destroy();
      reject(error);
    });
    stream.on("error", error => request.destroy(error));
    stream.pipe(request);
  });
}
