import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { downloadVerified } from "../lib/download-verified.mjs";

const root = resolve(import.meta.dirname, "../..");
const temporaryRoot = join(root, "target");
const content = Buffer.from("verified download\n");
const checksum = createHash("sha256").update(content).digest("hex");

async function temporaryDirectory(prefix) {
  await mkdir(temporaryRoot, { recursive: true });
  return mkdtemp(join(temporaryRoot, prefix));
}

test("verified downloads retry transient failures without changing integrity checks", async () => {
  const directory = await temporaryDirectory("download-verified-test-");
  const destination = join(directory, "node.tar.gz");
  let requests = 0;
  const retries = [];

  try {
    await downloadVerified("https://downloads.example/node.tar.gz", destination, checksum, {
      attempts: 3,
      timeoutMs: 1_000,
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) throw new TypeError("fetch failed");
        return new Response(content, { status: 200 });
      },
      sleep: async () => {},
      onRetry: retry => retries.push(retry)
    });

    assert.equal(requests, 2);
    assert.equal(retries.length, 1);
    assert.deepEqual(await readFile(destination), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified downloads do not retry permanent HTTP or checksum failures", async () => {
  const directory = await temporaryDirectory("download-verified-reject-test-");
  const destination = join(directory, "node.tar.gz");
  let requests = 0;

  try {
    await assert.rejects(
      downloadVerified("https://downloads.example/missing.tar.gz", destination, checksum, {
        attempts: 3,
        fetchImpl: async () => {
          requests += 1;
          return new Response("missing", { status: 404 });
        },
        sleep: async () => {}
      }),
      /HTTP 404/u
    );
    assert.equal(requests, 1);

    await assert.rejects(
      downloadVerified("https://downloads.example/tampered.tar.gz", destination, checksum, {
        attempts: 3,
        fetchImpl: async () => {
          requests += 1;
          return new Response("tampered", { status: 200 });
        },
        sleep: async () => {}
      }),
      /checksum mismatch/u
    );
    assert.equal(requests, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified downloads reuse a valid cached file", async () => {
  const directory = await temporaryDirectory("download-verified-cache-test-");
  const destination = join(directory, "node.tar.gz");

  try {
    await writeFile(destination, content);
    await downloadVerified("https://downloads.example/node.tar.gz", destination, checksum, {
      fetchImpl: async () => {
        throw new Error("cache should avoid network access");
      }
    });
    assert.deepEqual(await readFile(destination), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
