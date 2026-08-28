import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

function requestModule(url) {
  return url.protocol === "https:" ? https : http;
}

async function parseResponse(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
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

export function controllerUrl(base, path) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${path}`;
  url.search = "";
  return url;
}

export async function requestJson(base, path, { method = "GET", token = "", body = undefined } = {}) {
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
    }, response => { parseResponse(response).then(resolve, reject); });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export async function uploadArtifact(base, taskId, token, path, name, sha256) {
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
    }, response => { parseResponse(response).then(resolve, reject); });
    request.on("error", reject);
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.pipe(request);
  });
}
