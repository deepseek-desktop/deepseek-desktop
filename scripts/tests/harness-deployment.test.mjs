import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanArtifactPaths } from "../lib/artifact-scan.mjs";
import {
  deployHarnessClosure,
  findCliPackage,
  findWorkspacePackages,
  mergeDesktopClosure,
  pruneNativeBuildIntermediates,
  sanitizeBuildPaths
} from "../lib/harness-deployment.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-deployment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function packageAt(root, name, manifest = {}) {
  const directory = join(root, ...name.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  return directory;
}

test("desktop closure includes transitive dependencies but preserves the new Harness core", async t => {
  const root = await fixture(t);
  const desktop = join(root, "desktop");
  const candidate = join(root, "candidate");
  const from = join(desktop, "node_modules");
  const to = join(candidate, "node_modules");
  await packageAt(from, "desktop", { dependencies: { yaml: "1", extension: "1" } });
  await packageAt(from, "yaml", { dependencies: { parser: "1" } });
  await packageAt(from, "parser");
  await packageAt(from, "extension", { peerDependencies: { core: "1" }, optionalDependencies: { absent: "1" } });
  await packageAt(from, "core");
  await packageAt(from, "unrelated");
  await packageAt(to, "core", { version: "2.0.0" });
  const copied = await mergeDesktopClosure(desktop, candidate, ["desktop"]);
  assert.deepEqual(copied.sort(), ["desktop", "extension", "parser", "yaml"]);
  assert.equal(JSON.parse(await readFile(join(to, "core/package.json"))).version, "2.0.0");
  await assert.rejects(readFile(join(to, "unrelated/package.json")), { code: "ENOENT" });
});

test("missing candidate peer fails instead of copying an old core", async t => {
  const root = await fixture(t);
  await packageAt(join(root, "old/node_modules"), "desktop", { peerDependencies: { core: "1" } });
  await packageAt(join(root, "old/node_modules"), "core");
  await assert.rejects(mergeDesktopClosure(join(root, "old"), join(root, "new"), ["desktop"]), /Candidate Harness peer is missing: core/);
});

test("desktop client and its Harness dependencies survive replacement and reject incomplete candidates", async t => {
  const root = await fixture(t);
  const old = join(root, "old");
  const next = join(root, "next");
  const extension = await packageAt(join(old, "node_modules"), "extension", {
    exports: { "./client": "./client.js" },
    dsh: { client: { inject: ["settings-ui"] }, desktop: { harnessPackages: ["agent"] } }
  });
  await assert.rejects(mergeDesktopClosure(old, next, ["extension"]), /extension dependency is missing: agent/);
  await packageAt(join(next, "node_modules"), "agent");
  await assert.rejects(mergeDesktopClosure(old, next, ["extension"]), /Desktop client entry is missing/);
  await writeFile(join(extension, "client.js"), "independent-settings");
  await assert.rejects(mergeDesktopClosure(old, next, ["extension"]), /client dependency is missing: settings-ui/);
  await packageAt(join(next, "node_modules"), "settings-ui");
  await mergeDesktopClosure(old, next, ["extension"]);
  assert.equal(await readFile(join(next, "node_modules/extension/client.js"), "utf8"), "independent-settings");
  await writeFile(join(next, "settings.yaml"), "user-choice");
  await mergeDesktopClosure(old, next, ["extension"]);
  assert.equal(await readFile(join(next, "settings.yaml"), "utf8"), "user-choice");
  const before = JSON.parse(await readFile(join(next, "desktop-extensions.json")));
  await writeFile(join(extension, "client.js"), "new-desktop-settings");
  await mergeDesktopClosure(old, next, ["extension"]);
  const after = JSON.parse(await readFile(join(next, "desktop-extensions.json")));
  assert.notEqual(after.packages[0].sha256, before.packages[0].sha256);
  assert.equal(after.packages[0].client, "./client.js");
  assert.equal(after.packages[0].version, "1.0.0");
  assert.equal(await readFile(join(next, "node_modules/extension/client.js"), "utf8"), "new-desktop-settings");
});

test("missing required desktop dependency fails preparation", async t => {
  const root = await fixture(t);
  await packageAt(join(root, "old/node_modules"), "desktop", { dependencies: { missing: "1" } });
  await assert.rejects(mergeDesktopClosure(join(root, "old"), join(root, "new"), ["desktop"]), /Desktop dependency is missing: missing/);
  await packageAt(join(root, "old/node_modules"), "optional-first", { optionalDependencies: { missing: "1" } });
  await assert.rejects(mergeDesktopClosure(join(root, "old"), join(root, "new"), ["optional-first", "desktop"]), /Desktop dependency is missing: missing/);
});

test("production deployment restores workspace peers and original input files", async t => {
  const root = await fixture(t);
  const source = join(root, "source");
  const destination = join(root, "deployment");
  await packageAt(source, "python/sdk-runtime", { name: "closure" });
  await packageAt(source, "apps/cli", { name: "cli", bin: { dsh: "lib/custom.js" } });
  const peer = await packageAt(source, "packages/peer", { name: "peer" });
  await writeFile(join(peer, "index.js"), "export default 1;");
  const lock = join(source, "pnpm-lock.yaml");
  await writeFile(lock, "original lock\n");
  const original = await readFile(join(source, "python/sdk-runtime/package.json"), "utf8");
  const packages = await findWorkspacePackages(source);
  const cli = findCliPackage(packages);
  assert.equal(cli.entry, "lib/custom.js");
  const calls = [];
  // The callback models pnpm's deployment, which can omit workspace peers.
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const restored = await deployHarnessClosure(source, packages, cli, destination, args => {
    calls.push(args);
    if (args.includes("deploy")) {
      mkdirSync(join(destination, "node_modules"), { recursive: true });
      writeFileSync(join(destination, "package.json"), JSON.stringify({ peerDependencies: { peer: "*" } }));
    }
  });
  assert.deepEqual(restored, ["peer"]);
  assert.equal(await readFile(join(destination, "node_modules/peer/index.js"), "utf8"), "export default 1;");
  assert.equal(await readFile(join(source, "python/sdk-runtime/package.json"), "utf8"), original);
  assert.equal(await readFile(lock, "utf8"), "original lock\n");
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes("--prod"));
  await assert.rejects(deployHarnessClosure(source, packages, cli, destination, () => { throw new Error("pnpm failed"); }), /pnpm failed/);
  assert.equal(await readFile(join(source, "python/sdk-runtime/package.json"), "utf8"), original);
  assert.equal(await readFile(lock, "utf8"), "original lock\n");
});

test("build path sanitization preserves binary offsets while shrinking text paths", async t => {
  const root = await fixture(t);
  const source = "/Users/example/a-long-build-root";
  const replacement = "/build";
  const cache = "/Users/example/Library/Caches/node-gyp";
  const cacheReplacement = "/user-home/cache";
  const textPath = join(root, "metadata.txt");
  const binaryPath = join(root, "native.node");
  await writeFile(textPath, `source=${source}\ncache=${cache}\n`);
  const binary = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]),
    Buffer.from(source),
    Buffer.from([0, 1, 2, 3, 4])
  ]);
  await writeFile(binaryPath, binary);

  const result = await sanitizeBuildPaths(root, [
    [source, replacement],
    [cache, cacheReplacement]
  ]);
  const sanitizedText = await readFile(textPath, "utf8");
  const sanitizedBinary = await readFile(binaryPath);
  assert.equal(sanitizedText, `source=${replacement}\ncache=${cacheReplacement}\n`);
  assert.equal(sanitizedBinary.length, binary.length);
  assert.equal(sanitizedBinary.includes(Buffer.from(source)), false);
  assert.equal(sanitizedBinary.subarray(5, 5 + replacement.length).toString(), replacement);
  assert.deepEqual([...sanitizedBinary.subarray(5 + replacement.length, 5 + source.length)], new Array(source.length - replacement.length).fill(0));
  assert.deepEqual(result, { rewrittenFiles: 2, replacementCount: 3, resignedFiles: 0 });
});

test("build path sanitization bounds longer replacements inside binaries", async t => {
  const root = await fixture(t);
  const source = "C:\\d";
  const replacement = "/deepseek-desktop";
  const textPath = join(root, "metadata.txt");
  const binaryPath = join(root, "native.node");
  await writeFile(textPath, `source=${source}\n`);
  const binary = Buffer.concat([
    Buffer.from([0x4d, 0x5a, 0]),
    Buffer.from(source),
    Buffer.from([0, 1, 2, 3, 4])
  ]);
  await writeFile(binaryPath, binary);

  const result = await sanitizeBuildPaths(root, [[source, replacement]]);
  const sanitizedText = await readFile(textPath, "utf8");
  const sanitizedBinary = await readFile(binaryPath);
  assert.equal(sanitizedText, `source=${replacement}\n`);
  assert.equal(sanitizedBinary.length, binary.length);
  assert.equal(sanitizedBinary.includes(Buffer.from(source)), false);
  assert.equal(sanitizedBinary.subarray(3, 6).toString(), "/de");
  assert.equal(sanitizedBinary[6], 0);
  assert.deepEqual(result, { rewrittenFiles: 2, replacementCount: 2, resignedFiles: 0 });
});

test("Windows UTF-16 build paths are removed without changing binary offsets", async t => {
  const root = await fixture(t);
  const path = join(root, "native.node");
  const source = root.replaceAll("/", "\\");
  const bytes = Buffer.concat([Buffer.from([0x4d, 0x5a, 0]), Buffer.from(`${source}\\fs_ext.pdb`, "utf16le"), Buffer.from([0, 0, 0x12, 0x34])]);
  await writeFile(path, bytes);
  await assert.rejects(scanArtifactPaths([path], { forbiddenRoots: [root] }), /local path/u);
  await sanitizeBuildPaths(root, [[source, "/build"]]);
  await scanArtifactPaths([path], { forbiddenRoots: [root] });
  const sanitized = await readFile(path);
  assert.equal(sanitized.length, bytes.length);
  assert.deepEqual(sanitized.subarray(3 + source.length * 2), bytes.subarray(3 + source.length * 2));
  assert.equal(sanitized.subarray(3, 15).toString("utf16le"), "/build");
});

test("node-gyp build trees keep only the loadable addon", async t => {
  // The Windows release job for v1.0.32 and v1.0.33 failed on fs_ext.iobj, but the
  // whole gyp build tree carries absolute build paths: config.gypi, the generated
  // makefiles and the .deps dependency records. None of it is read at runtime.
  const root = await fixture(t);
  const build = join(root, "node_modules", "fs-ext", "build");
  await mkdir(join(build, "Release", ".deps", "Release"), { recursive: true });
  await mkdir(join(build, "Release", "obj.target", "fs_ext"), { recursive: true });
  await writeFile(join(build, "config.gypi"), "{ 'variables': { 'nodedir': '/abs/path' } }");
  await writeFile(join(build, "Makefile"), "# absolute paths live here");
  await writeFile(join(build, "fs_ext.target.mk"), "# more absolute paths");
  await writeFile(join(build, "Release", "fs_ext.node"), "addon");
  await writeFile(join(build, "Release", "fs_ext.iobj"), "C:/d/harness/staging");
  await writeFile(join(build, "Release", ".deps", "Release", "fs_ext.node.d"), "dep record");
  await writeFile(join(build, "Release", "obj.target", "fs_ext", "fs-ext.o"), "object");

  // A hand-written source tree that merely lives under "build" must be untouched.
  const plain = join(root, "node_modules", "other", "build");
  await mkdir(join(plain, "Release"), { recursive: true });
  await writeFile(join(plain, "index.js"), "keep");
  await writeFile(join(plain, "Release", "notes.txt"), "keep");

  const removed = await pruneNativeBuildIntermediates(root);

  assert.deepEqual(removed, [
    "node_modules/fs-ext/build/Makefile",
    "node_modules/fs-ext/build/Release/.deps/",
    "node_modules/fs-ext/build/Release/fs_ext.iobj",
    "node_modules/fs-ext/build/Release/obj.target/",
    "node_modules/fs-ext/build/config.gypi",
    "node_modules/fs-ext/build/fs_ext.target.mk"
  ]);
  assert.equal(await readFile(join(build, "Release", "fs_ext.node"), "utf8"), "addon");
  assert.equal(await readFile(join(plain, "index.js"), "utf8"), "keep");
  assert.equal(await readFile(join(plain, "Release", "notes.txt"), "utf8"), "keep");
});
