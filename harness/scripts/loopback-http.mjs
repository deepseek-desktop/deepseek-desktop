import { request } from "node:http";

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"]);

function parseLoopbackUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error(`loopback smoke only accepts http://127.0.0.1:<port>, got ${url.origin}`);
  }
  return url;
}

export function requestLoopback(value, { headers = {}, timeoutMs = 2_000, bodyLimit = DEFAULT_BODY_LIMIT } = {}) {
  const url = parseLoopbackUrl(value);
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const requestHandle = request(url, {
      method: "GET",
      headers,
      timeout: timeoutMs
    }, response => {
      const chunks = [];
      let length = 0;
      response.on("data", chunk => {
        length += chunk.length;
        if (length > bodyLimit) {
          const error = new Error(`loopback response exceeds ${bodyLimit} bytes`);
          response.destroy();
          requestHandle.destroy();
          rejectOnce(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", rejectOnce);
      response.on("end", () => resolveOnce({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    requestHandle.on("timeout", () => {
      const error = new Error(`loopback request timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      requestHandle.destroy(error);
    });
    requestHandle.on("error", rejectOnce);
    requestHandle.end();
  });
}

export async function waitForLoopback(value, {
  child,
  headers = {},
  timeoutMs = 10_000,
  requestTimeoutMs = 2_000,
  retryDelayMs = 100
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`harness exited before its loopback endpoint accepted requests (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`);
    }
    try {
      return await requestLoopback(value, { headers, timeoutMs: requestTimeoutMs });
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_CODES.has(error?.code)) throw error;
      await new Promise(resolveDelay => setTimeout(resolveDelay, retryDelayMs));
    }
  }
  throw new Error(`harness loopback endpoint did not become ready within ${timeoutMs}ms: ${lastError?.message || "unknown error"}`, {
    cause: lastError
  });
}
