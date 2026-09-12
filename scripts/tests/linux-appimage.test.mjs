import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { prepareLinuxAppImageLdd } from "../lib/linux-appimage.mjs";

const ORIGINAL_BYTES = "fixture";
const PATCHED_BYTES = `${ORIGINAL_BYTES}:patched`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "deepseek-linux-appimage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const muslSystemNodeSource = join(root, "staging", "official", "musl", "system.node");
  const muslSystemNode = join(root, "AppDir With Spaces", "official", "musl", "system.node");
  const probeRecord = join(root, "probe.txt");
  const readelfRecord = join(root, "readelf.txt");
  const patchelfRecord = join(root, "patchelf.txt");
  const fakeLdd = join(root, "fake-ldd.mjs");
  const fakeReadelf = join(root, "fake-readelf.mjs");
  const fakePatchelf = join(root, "fake-patchelf.mjs");
  await mkdir(dirname(muslSystemNodeSource), { recursive: true });
  await mkdir(dirname(muslSystemNode), { recursive: true });
  await writeFile(muslSystemNode, ORIGINAL_BYTES);
  await writeFile(muslSystemNodeSource, ORIGINAL_BYTES);
  await writeFile(fakeLdd, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(probeRecord)}, JSON.stringify({ args: process.argv.slice(2), ld: process.env.LD_LIBRARY_PATH || "" }) + "\\n");`,
    'if (process.argv.at(-1) === "--ordinary") { process.stdout.write("delegated\\n"); process.exit(23); }',
    'process.exit(99);'
  ].join("\n"));
  await writeFile(fakeReadelf, [
    'import { appendFileSync } from "node:fs";',
    'import { basename } from "node:path";',
    `appendFileSync(${JSON.stringify(readelfRecord)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    'const patched = basename(process.argv.at(-1)) === "patched-system.node";',
    'if (patched && process.env.FAKE_READELF_PATCHED_RPATH) process.stdout.write(" 0x000000000000000f (RPATH) Library rpath: [$ORIGIN]\\n");',
    'else if (patched && !process.env.FAKE_READELF_PATCHED_NO_RUNPATH) process.stdout.write(" 0x000000000000001d (RUNPATH) Library runpath: [$ORIGIN]\\n");',
    'if (!patched && process.env.FAKE_READELF_SOURCE_RUNPATH) process.stdout.write(" 0x000000000000001d (RUNPATH) Library runpath: [$ORIGIN]\\n");',
    'process.stdout.write(" 0x0000000000000001 (NEEDED) Shared library: [libc.so]\\n");',
    'if ((!patched && process.env.FAKE_READELF_SOURCE_EXTRA) || (patched && process.env.FAKE_READELF_PATCHED_EXTRA)) process.stdout.write(" 0x0000000000000001 (NEEDED) Shared library: [libfuture.so]\\n");'
  ].join("\n"));
  await writeFile(fakePatchelf, [
    'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(patchelfRecord)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    'if (process.env.FAKE_PATCHELF_FAIL) process.exit(42);',
    'const target = process.argv.at(-1);',
    'writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from(":patched")]));'
  ].join("\n"));
  return {
    root,
    muslSystemNode,
    muslSystemNodeSource,
    probeRecord,
    readelfRecord,
    patchelfRecord,
    fakeLdd,
    fakeReadelf,
    fakePatchelf
  };
}

async function prepare(item, environment = process.env, overrides = {}) {
  return prepareLinuxAppImageLdd({
    platform: "linux",
    environment,
    muslSystemNode: item.muslSystemNode,
    muslSystemNodeSource: item.muslSystemNodeSource,
    realLdd: process.execPath,
    realLddArguments: [item.fakeLdd],
    readelf: process.execPath,
    readelfArguments: [item.fakeReadelf],
    patchelf: process.execPath,
    patchelfArguments: [item.fakePatchelf],
    temporaryRoot: item.root,
    ...overrides
  });
}

function invoke(prepared, args, environment = process.env) {
  return spawnSync(process.execPath, [prepared.wrapperPath, ...args], {
    encoding: "utf8",
    env: { ...environment, ...prepared.environment }
  });
}

test("the Linux ldd wrapper establishes the exact original identity", async t => {
  const item = await fixture(t);
  const prepared = await prepare(item);
  t.after(prepared.cleanup);

  const result = invoke(prepared, [item.muslSystemNode]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal((await readFile(prepared.identityMarker, "utf8")).split(" ")[0], "original");
  await assert.rejects(readFile(item.probeRecord, "utf8"), { code: "ENOENT" });
  assert.equal(prepared.environment.NO_STRIP, "1");
  assert.equal(prepared.environment.PATCHELF, await realpath(process.execPath));
  const patchelfArgs = JSON.parse((await readFile(item.patchelfRecord, "utf8")).trim());
  assert.deepEqual(patchelfArgs.slice(0, 2), ["--set-rpath", "$ORIGIN"]);
  assert.match(patchelfArgs[2], /patched-system\.node$/u);
  const inspections = (await readFile(item.readelfRecord, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(inspections.length, 2);
  assert.equal(inspections[0].at(-1), item.muslSystemNodeSource);
  assert.match(inspections[1].at(-1), /patched-system\.node$/u);
});

test("the Linux ldd wrapper accepts only the precomputed patched identity", async t => {
  const item = await fixture(t);
  const prepared = await prepare(item);
  t.after(prepared.cleanup);

  assert.equal(invoke(prepared, [item.muslSystemNode]).status, 0);
  await writeFile(item.muslSystemNode, PATCHED_BYTES);
  const patched = invoke(prepared, [item.muslSystemNode]);
  assert.equal(patched.status, 0, patched.stderr);
  assert.equal((await readFile(prepared.identityMarker, "utf8")).split(" ")[0], "patched");
  assert.match(await prepared.verifyFinal(), /^[0-9a-f]{64}$/u);
});

test("the Linux ldd wrapper rejects unknown bytes even after original identity", async t => {
  const item = await fixture(t);
  const messages = [];
  const prepared = await prepare(item, process.env, { log: value => messages.push(value) });
  t.after(prepared.cleanup);

  assert.equal(invoke(prepared, [item.muslSystemNode]).status, 0);
  await writeFile(item.muslSystemNode, `${PATCHED_BYTES}:tampered`);
  const result = invoke(prepared, [item.muslSystemNode]);
  assert.equal(result.status, 125);
  assert.match(result.stderr, /byte identity mismatch/u);
  assert.match(await prepared.reportFailure(), /byte identity mismatch/u);
  assert.match(messages[0], /Linux AppImage ldd diagnostics/u);
});

test("the Linux ldd wrapper enforces monotonic original to patched order", async t => {
  const item = await fixture(t);
  const prepared = await prepare(item);
  t.after(prepared.cleanup);

  await writeFile(item.muslSystemNode, PATCHED_BYTES);
  const premature = invoke(prepared, [item.muslSystemNode]);
  assert.equal(premature.status, 125);
  assert.match(premature.stderr, /before its original copy was observed/u);

  await writeFile(item.muslSystemNode, ORIGINAL_BYTES);
  assert.equal(invoke(prepared, [item.muslSystemNode]).status, 0);
  await writeFile(item.muslSystemNode, PATCHED_BYTES);
  assert.equal(invoke(prepared, [item.muslSystemNode]).status, 0);
  await writeFile(item.muslSystemNode, ORIGINAL_BYTES);
  const reverted = invoke(prepared, [item.muslSystemNode]);
  assert.equal(reverted.status, 125);
  assert.match(reverted.stderr, /reverted/u);
});

test("the Linux ldd wrapper rejects a changed identity marker", async t => {
  const item = await fixture(t);
  const prepared = await prepare(item);
  t.after(prepared.cleanup);

  assert.equal(invoke(prepared, [item.muslSystemNode]).status, 0);
  await writeFile(prepared.identityMarker, "changed\n");
  await writeFile(item.muslSystemNode, PATCHED_BYTES);
  const result = invoke(prepared, [item.muslSystemNode]);
  assert.equal(result.status, 125);
  assert.match(result.stderr, /identity marker changed/u);
});

test("the Linux ldd wrapper delegates every non-target invocation unchanged", async t => {
  const item = await fixture(t);
  const environment = { ...process.env, LD_LIBRARY_PATH: "/existing" };
  const prepared = await prepare(item, environment);
  t.after(prepared.cleanup);

  const result = invoke(prepared, ["--ordinary"], environment);
  assert.equal(result.status, 23);
  assert.equal(result.stdout, "delegated\n");
  const record = JSON.parse((await readFile(item.probeRecord, "utf8")).trim());
  assert.deepEqual(record, { args: ["--ordinary"], ld: "/existing" });
});

test("the Linux ldd wrapper recognizes a canonical target behind a symlinked cache path", async t => {
  const item = await fixture(t);
  const linkedAppDir = join(item.root, "linked AppDir");
  await symlink(join(item.root, "AppDir With Spaces"), linkedAppDir, "dir");
  const linkedSystemNode = join(linkedAppDir, "official", "musl", "system.node");
  const prepared = await prepare(item, process.env, { muslSystemNode: linkedSystemNode });
  t.after(prepared.cleanup);

  const result = invoke(prepared, [await realpath(item.muslSystemNode)]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(prepared.identityMarker, "utf8")).split(" ")[0], "original");
  await assert.rejects(readFile(item.probeRecord, "utf8"), { code: "ENOENT" });
});

test("Linux AppImage preparation rejects source dependency or path drift", async t => {
  const item = await fixture(t);
  await assert.rejects(
    prepare(item, { ...process.env, FAKE_READELF_SOURCE_EXTRA: "1" }),
    /dependencies changed.*libfuture\.so/u
  );
  await assert.rejects(
    prepare(item, { ...process.env, FAKE_READELF_SOURCE_RUNPATH: "1" }),
    /dynamic paths changed/u
  );
});

test("Linux AppImage preparation rejects patched dependency, RUNPATH, or RPATH drift", async t => {
  const item = await fixture(t);
  await assert.rejects(
    prepare(item, { ...process.env, FAKE_READELF_PATCHED_EXTRA: "1" }),
    /dependencies changed.*libfuture\.so/u
  );
  await assert.rejects(
    prepare(item, { ...process.env, FAKE_READELF_PATCHED_NO_RUNPATH: "1" }),
    /dynamic paths changed/u
  );
  await assert.rejects(
    prepare(item, { ...process.env, FAKE_READELF_PATCHED_RPATH: "1" }),
    /dynamic paths changed.*rpath/u
  );
});

test("Linux AppImage preparation rejects patchelf failure", async t => {
  const item = await fixture(t);
  await assert.rejects(
    prepare(item, { ...process.env, FAKE_PATCHELF_FAIL: "1" }),
    /patchelf exited with code 42/u
  );
});

test("final verification rejects an incomplete linuxdeploy transition", async t => {
  const item = await fixture(t);
  const prepared = await prepare(item);
  t.after(prepared.cleanup);

  assert.equal(invoke(prepared, [item.muslSystemNode]).status, 0);
  await assert.rejects(prepared.verifyFinal(), /final official musl system\.node identity mismatch/u);
});

test("the Linux ldd wrapper is removed after cleanup", async t => {
  const item = await fixture(t);
  const prepared = await prepare(item);
  await prepared.cleanup();
  await assert.rejects(access(prepared.wrapperPath), { code: "ENOENT" });
});

test("non-Linux packaging has no AppImage tool side effects", async () => {
  const result = await prepareLinuxAppImageLdd({ platform: "darwin" });
  assert.deepEqual(result.environment, {});
  assert.equal(await result.verifyFinal(), "");
  assert.equal(await result.reportFailure(), "");
  await result.cleanup();
});
