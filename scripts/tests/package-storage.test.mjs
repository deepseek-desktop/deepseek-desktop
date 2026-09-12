import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  reclaimHostedLinuxPackagingSpace,
  reportPackagingStorage,
  withHostedLinuxTauriDiagnostics
} from "../lib/package-storage.mjs";

function filesystemWith(bytes) {
  return async () => ({ bavail: BigInt(bytes), bsize: 1n });
}

test("hosted Linux packaging removes only verified transient build trees", async t => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-package-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const debug = join(root, "src-tauri", "target", "debug");
  const sync = join(root, "target", "harness-sync");
  const source = join(sync, "source");
  const staging = join(root, "harness", "staging");
  await Promise.all([
    mkdir(debug, { recursive: true }),
    mkdir(source, { recursive: true }),
    mkdir(staging, { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(debug, "object"), "debug"),
    writeFile(join(source, "upstream"), "source"),
    writeFile(join(staging, "runtime"), "staging")
  ]);
  const messages = [];
  let sample = 0;
  const result = await reclaimHostedLinuxPackagingSpace({
    projectRoot: root,
    platform: "linux",
    environment: { GITHUB_ACTIONS: "true" },
    readFilesystem: async () => ({ bavail: sample++ === 0 ? 4n : 10n, bsize: 1024n }),
    log: value => messages.push(value)
  });

  assert.equal(result.performed, true);
  await assert.rejects(access(debug), { code: "ENOENT" });
  await assert.rejects(access(sync), { code: "ENOENT" });
  await access(join(staging, "runtime"));
  assert.match(messages[0], /reclaimed/u);
  assert.deepEqual(result.removed, [debug, sync]);
});

test("local and non-Linux packaging keep build trees", async () => {
  const calls = [];
  const base = {
    projectRoot: "/absolute/project",
    remove: async (...args) => calls.push(args)
  };
  assert.deepEqual(await reclaimHostedLinuxPackagingSpace({
    ...base,
    platform: "linux",
    environment: {}
  }), { performed: false, removed: [] });
  assert.deepEqual(await reclaimHostedLinuxPackagingSpace({
    ...base,
    platform: "darwin",
    environment: { GITHUB_ACTIONS: "true" }
  }), { performed: false, removed: [] });
  assert.deepEqual(calls, []);
});

test("packaging storage diagnostics report available bytes and measurement errors", async () => {
  const messages = [];
  await reportPackagingStorage({
    projectRoot: "/absolute/project",
    label: "before build",
    readFilesystem: filesystemWith(2 * 1024 ** 3),
    log: value => messages.push(value)
  });
  await reportPackagingStorage({
    projectRoot: "/absolute/project",
    label: "after failure",
    readFilesystem: async () => { throw new Error("unavailable"); },
    log: value => messages.push(value)
  });
  assert.equal(messages[0], "before build: 2.00 GiB available on the packaging filesystem");
  assert.equal(messages[1], "after failure: unable to measure packaging filesystem: unavailable");
});

test("hosted Linux enables Tauri diagnostics without mutating the base arguments", () => {
  const arguments_ = ["tauri", "build"];
  assert.deepEqual(withHostedLinuxTauriDiagnostics(arguments_, {
    platform: "linux",
    environment: { GITHUB_ACTIONS: "true" }
  }), ["tauri", "build", "--verbose"]);
  assert.deepEqual(withHostedLinuxTauriDiagnostics(arguments_, {
    platform: "linux",
    environment: {}
  }), arguments_);
  assert.deepEqual(arguments_, ["tauri", "build"]);
});

test("packaging storage cleanup requires an absolute root", async () => {
  await assert.rejects(
    reclaimHostedLinuxPackagingSpace({ projectRoot: "relative", platform: "linux", environment: { GITHUB_ACTIONS: "true" } }),
    /absolute project root/u
  );
});
