import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { prepareLinuxAppImageLdd } from "../lib/linux-appimage.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "deepseek-linux-appimage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const muslLibc = join(root, "x86_64-linux-musl", "libc.so");
  const muslSystemNode = join(root, "AppDir", "official", "musl", "system.node");
  const probeRecord = join(root, "probe.txt");
  const fakeLdd = join(root, "fake-ldd.mjs");
  await mkdir(dirname(muslLibc), { recursive: true });
  await mkdir(dirname(muslSystemNode), { recursive: true });
  await writeFile(muslLibc, "fixture");
  await writeFile(muslSystemNode, "fixture");
  await writeFile(fakeLdd, [
    'import { appendFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `appendFileSync(${JSON.stringify(probeRecord)}, JSON.stringify({ args: process.argv.slice(2), ld: process.env.LD_LIBRARY_PATH || "" }) + "\\n");`,
    'if (process.argv.at(-1) === "--ordinary") { process.stdout.write("delegated\\n"); process.exit(23); }',
    'process.stdout.write(`libc.so => ${join(process.env.LD_LIBRARY_PATH, "libc.so")} (0x00000001)\\n`);',
    'if (process.env.FAKE_LDD_EXTRA) process.stdout.write("libfuture.so => /future/libfuture.so (0x00000002)\\n");'
  ].join("\n"));
  return { root, muslLibc, muslSystemNode, probeRecord, fakeLdd };
}

async function prepare(item, environment = process.env) {
  return prepareLinuxAppImageLdd({
    platform: "linux",
    environment,
    muslSystemNode: item.muslSystemNode,
    muslLibc: item.muslLibc,
    realLdd: process.execPath,
    realLddArguments: [item.fakeLdd],
    temporaryRoot: item.root
  });
}

function invoke(prepared, args, environment = process.env) {
  return spawnSync(process.execPath, [prepared.wrapperPath, ...args], {
    encoding: "utf8",
    env: { ...environment, ...prepared.environment }
  });
}

test("the Linux ldd wrapper hides only the verified official musl dependency", async t => {
  const item = await fixture(t);
  const prepared = await prepare(item);
  t.after(prepared.cleanup);

  const result = invoke(prepared, [item.muslSystemNode]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const record = JSON.parse((await readFile(item.probeRecord, "utf8")).trim());
  assert.deepEqual(record, { args: [item.muslSystemNode], ld: dirname(item.muslLibc) });
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

test("the Linux ldd wrapper fails closed when the official musl dependencies change", async t => {
  const item = await fixture(t);
  const environment = { ...process.env, FAKE_LDD_EXTRA: "1" };
  const prepared = await prepare(item, environment);
  t.after(prepared.cleanup);

  const result = invoke(prepared, [item.muslSystemNode], environment);
  assert.equal(result.status, 125);
  assert.match(result.stderr, /dependencies changed/u);
});

test("the Linux ldd wrapper is removed after cleanup", async t => {
  const item = await fixture(t);
  const prepared = await prepare(item);
  await prepared.cleanup();
  await assert.rejects(access(prepared.wrapperPath), { code: "ENOENT" });
});

test("non-Linux packaging does not create an ldd wrapper", async () => {
  const result = await prepareLinuxAppImageLdd({ platform: "darwin" });
  assert.deepEqual(result.environment, {});
  await result.cleanup();
});
