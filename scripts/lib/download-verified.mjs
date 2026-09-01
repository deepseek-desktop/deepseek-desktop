import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function hashFile(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function downloadVerified(url, destination, expectedSha256, options = {}) {
  const {
    attempts = 5,
    timeoutMs = 60_000,
    fetchImpl = fetch,
    sleep = delay,
    onRetry = ({ attempt, error, waitMs }) => {
      console.warn(`download attempt ${attempt} failed for ${url}; retrying in ${waitMs}ms: ${error.message}`);
    }
  } = options;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("download attempts must be a positive integer");

  try {
    if (await hashFile(destination) === expectedSha256) return;
  } catch {}

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await rm(temporary, { force: true });
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        const error = new Error(`could not download ${url}: HTTP ${response.status}`);
        error.retryable = retryableStatus(response.status);
        throw error;
      }
      await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
      const actual = await hashFile(temporary);
      if (actual !== expectedSha256) {
        const error = new Error(`download checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
        error.retryable = false;
        throw error;
      }
      await rm(destination, { force: true });
      await rename(temporary, destination);
      return;
    } catch (error) {
      await rm(temporary, { force: true });
      const canRetry = error.retryable !== false && attempt < attempts;
      if (!canRetry) throw error;
      const waitMs = Math.min(1_000 * (2 ** (attempt - 1)), 8_000);
      onRetry({ attempt, error, waitMs });
      await sleep(waitMs);
    }
  }
}
