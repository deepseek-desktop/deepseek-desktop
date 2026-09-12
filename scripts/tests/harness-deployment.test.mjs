import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanArtifactPaths } from "../lib/artifact-scan.mjs";
import {
  deployHarnessClosure,
  findCliPackage,
  findWorkspacePackages,
  mergeDesktopClosure,
  patchBrowserJsonIntrinsics,
  pruneNativeBuildIntermediates,
  sanitizeBuildPaths,
  selectHarnessPackageClosure,
  verifyHarnessPackageLock
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

test("browser JSON intrinsic correction is scoped and idempotent in candidate deployment", async t => {
  const root = await fixture(t);
  const old = 'Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`';
  for (const [name, entry] of [["dsh-util-values", "index.js"], ["dsh-client-ui-chat", "client.js"], ["dsh-web-search-deepseek", "index.js"]]) {
    const directory = await packageAt(join(root, "node_modules"), `@deepseek-ai/${name}`);
    await mkdir(join(directory, "lib"));
    await writeFile(join(directory, "lib", entry), old);
  }
  assert.equal((await patchBrowserJsonIntrinsics(root)).length, 2);
  assert.deepEqual(await patchBrowserJsonIntrinsics(root), []);
  assert.match(await readFile(join(root, "node_modules/@deepseek-ai/dsh-util-values/lib/index.js"), "utf8"), /name === "Array" \? Array : Object/);
  assert.equal(await readFile(join(root, "node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js"), "utf8"), old);
});

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
  await packageAt(join(root, "old/node_modules"), "desktop", { peerDependencies: { "@deepseek-ai/core": "1.0.0" } });
  await packageAt(join(root, "old/node_modules"), "@deepseek-ai/core");
  await assert.rejects(mergeDesktopClosure(join(root, "old"), join(root, "new"), ["desktop"]), /Candidate Harness peer is missing: @deepseek-ai\/core/);
});

test("Desktop extension peers reject old Harness versions and include declared external browser peers", async t => {
  const root = await fixture(t);
  const desktop = join(root, "desktop");
  const candidate = join(root, "candidate");
  await packageAt(join(desktop, "node_modules"), "extension", {
    peerDependencies: { "@deepseek-ai/core": "0.1.5-rc.2", react: "18.3.1" }
  });
  await packageAt(join(desktop, "node_modules"), "react", { version: "18.3.1" });
  await packageAt(join(candidate, "node_modules"), "@deepseek-ai/core", { version: "0.1.3-alpha.1" });
  await assert.rejects(mergeDesktopClosure(desktop, candidate, ["extension"]), /requires peer @deepseek-ai\/core@0.1.5-rc.2; candidate provides 0.1.3-alpha.1/);
  await packageAt(join(candidate, "node_modules"), "@deepseek-ai/core", { version: "0.1.5-rc.2" });
  await mergeDesktopClosure(desktop, candidate, ["extension"]);
  assert.equal(JSON.parse(await readFile(join(candidate, "node_modules/react/package.json"))).version, "18.3.1");
});

test("desktop client and its Harness dependencies survive replacement and reject incomplete candidates", async t => {
  const root = await fixture(t);
  const old = join(root, "old");
  const next = join(root, "next");
  const extension = await packageAt(join(old, "node_modules"), "extension", {
    exports: { "./client": "./client.js" },
    peerDependencies: { "@deepseek-ai/agent": "1.0.0" },
    dsh: { client: { platform: "web", inject: ["settings-ui"] } }
  });
  await assert.rejects(mergeDesktopClosure(old, next, ["extension"]), /peer is missing: @deepseek-ai\/agent/);
  await packageAt(join(next, "node_modules"), "@deepseek-ai/agent");
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

test("production package selection includes peers and only compatible optional native packages", () => {
  const packages = new Map([
    ["cli", { manifest: { name: "cli", dependencies: { service: "*" }, devDependencies: { electron: "*" } } }],
    ["service", { manifest: { name: "service", peerDependencies: { peer: "*" }, optionalDependencies: { darwin: "*", linux: "*" } } }],
    ["peer", { manifest: { name: "peer", peerDependencies: { service: "*" } } }],
    ["darwin", { manifest: { name: "darwin", os: ["darwin"], cpu: ["arm64"] } }],
    ["linux", { manifest: { name: "linux", os: ["linux"], cpu: ["x64"] } }]
  ]);
  const closure = selectHarnessPackageClosure(packages, ["cli"], { platform: "darwin", arch: "arm64" });
  assert.deepEqual(closure.packages.map(item => item.manifest.name), ["cli", "darwin", "peer", "service"]);
  assert.deepEqual(closure.excluded, { "service>linux": "-" });
  assert.throws(() => selectHarnessPackageClosure(packages, ["linux"], { platform: "darwin", arch: "arm64" }), /does not support/);
  packages.get("service").manifest.dependencies = { "@deepseek-ai/missing": "1" };
  assert.throws(() => selectHarnessPackageClosure(packages, ["cli"]), /unpacked internal package/);
});

test("runtime lock rejects registry core copies even alongside the expected local tarball", () => {
  const packages = [{ name: "@deepseek-ai/cli", version: "1.0.0", file: "cli-1.0.0.tgz" }];
  const lock = { importers: { ".": { dependencies: { "@deepseek-ai/cli": {
    specifier: "file:packages/cli-1.0.0.tgz", version: "file:packages/cli-1.0.0.tgz"
  } } } }, packages: { "@deepseek-ai/cli@file:packages/cli-1.0.0.tgz": {} } };
  assert.doesNotThrow(() => verifyHarnessPackageLock(lock, packages));
  lock.importers["."].dependencies["@deepseek-ai/cli"].specifier = "file:./packages/cli-1.0.0.tgz";
  assert.doesNotThrow(() => verifyHarnessPackageLock(lock, packages));
  lock.packages["@deepseek-ai/cli@1.0.0"] = {};
  assert.throws(() => verifyHarnessPackageLock(lock, packages), /external core package/);
  delete lock.packages["@deepseek-ai/cli@1.0.0"];
  lock.importers["."].dependencies["@deepseek-ai/cli"].version = "1.0.0";
  assert.throws(() => verifyHarnessPackageLock(lock, packages), /outside its local package set/);
});

test("production deployment installs packed files and preserves source inputs without a Python workspace", async t => {
  const root = await fixture(t);
  const source = join(root, "source");
  const destination = join(root, "deployment");
  const cliDirectory = await packageAt(source, "apps/cli", { name: "cli", bin: { dsh: "lib/custom.js" }, dependencies: { vendor: "1.0.0" }, peerDependencies: { peer: "*" }, files: ["lib"] });
  await mkdir(join(cliDirectory, "lib"));
  await writeFile(join(cliDirectory, "lib/custom.js"), "export default 1;\n");
  await writeFile(join(cliDirectory, "unpublished-source.ts"), "must not ship\n");
  // A tiny JSON-only YAML implementation keeps this orchestration fixture independent
  // of the real upstream install. JSON is valid YAML; production uses CLI's js-yaml.
  const parser = await packageAt(join(cliDirectory, "node_modules"), "js-yaml", { main: "index.cjs" });
  await writeFile(join(parser, "index.cjs"), "module.exports = { load: JSON.parse, dump: JSON.stringify };\n");
  await packageAt(join(cliDirectory, "node_modules"), "vendor");
  const peer = await packageAt(source, "packages/peer", { name: "peer" });
  await writeFile(join(peer, "index.js"), "export default 1;");
  const lock = join(source, "pnpm-lock.yaml");
  await writeFile(lock, "original lock\n");
  await mkdir(join(source, "patches"));
  await writeFile(join(source, "patches/vendor.patch"), "selected runtime patch\n");
  await writeFile(join(source, "patches/electron.patch"), "unrelated desktop patch\n");
  await writeFile(join(source, "pnpm-workspace.yaml"), JSON.stringify({ packages: ["apps/*", "packages/*"], allowBuilds: {},
    patchedDependencies: { "vendor@1.0.0": "patches/vendor.patch", "electron@1.0.0": "patches/electron.patch" } }));
  const original = await readFile(join(cliDirectory, "package.json"), "utf8");
  const packages = await findWorkspacePackages(source);
  const cli = findCliPackage(packages);
  assert.equal(cli.entry, "lib/custom.js");
  const calls = [];
  function tar(args) {
    const result = spawnSync("tar", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const runtime = await deployHarnessClosure(source, packages, cli, destination, async (args, cwd) => {
    calls.push({ args, cwd });
    if (args.includes("pack")) {
      const output = args.at(-1);
      for (const item of packages.values()) {
        const tree = join(root, "packed", item.manifest.name);
        await mkdir(join(tree, "package"), { recursive: true });
        await cp(join(item.directory, "package.json"), join(tree, "package/package.json"));
        const entry = item.manifest.name === "cli" ? "lib" : "index.js";
        await cp(join(item.directory, entry), join(tree, "package", entry), { recursive: true });
        tar(["-czf", join(output, `${item.manifest.name}-1.0.0.tgz`), "-C", tree, "package"]);
      }
    } else if (args.includes("--lockfile-only")) {
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      const settings = JSON.parse(await readFile(join(cwd, "pnpm-workspace.yaml"), "utf8"));
      assert.deepEqual(Object.keys(settings.patchedDependencies), ["vendor@1.0.0"]);
      assert.equal(await readFile(join(cwd, settings.patchedDependencies["vendor@1.0.0"]), "utf8"), "selected runtime patch\n");
      const dependencies = Object.fromEntries(Object.entries(manifest.dependencies).map(([name, specifier]) => [name, {
        specifier, version: specifier.replace("file:./", "file:")
      }]));
      await writeFile(join(cwd, "pnpm-lock.yaml"), JSON.stringify({ importers: { ".": { dependencies } }, packages: {} }));
    } else {
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      for (const [name, specifier] of Object.entries(manifest.dependencies)) {
        const installed = join(cwd, "node_modules", name);
        await mkdir(installed, { recursive: true });
        tar(["-xzf", join(cwd, specifier.slice(5)), "--strip-components=1", "-C", installed]);
      }
    }
  });
  assert.deepEqual(runtime.packages.map(item => item.name), ["cli", "peer"]);
  assert.deepEqual(runtime.upstreamPatches.map(item => item.package), ["vendor@1.0.0"]);
  assert.ok(runtime.packages.every(item => item.integrity.startsWith("sha512-") && item.bytes > 0));
  assert.equal(await readFile(join(destination, "node_modules/peer/index.js"), "utf8"), "export default 1;");
  await assert.rejects(readFile(join(destination, "node_modules/cli/unpublished-source.ts")), { code: "ENOENT" });
  assert.equal(await readFile(join(cliDirectory, "package.json"), "utf8"), original);
  assert.equal(await readFile(lock, "utf8"), "original lock\n");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].cwd, source);
  assert.notEqual(calls[1].cwd, source);
  assert.deepEqual(calls[2].args, ["install", "--prod", "--frozen-lockfile", "--trust-lockfile"]);
  await assert.rejects(deployHarnessClosure(source, packages, cli, destination, () => { throw new Error("pnpm failed"); }), /pnpm failed/);
  assert.equal(await readFile(join(cliDirectory, "package.json"), "utf8"), original);
  assert.equal(await readFile(lock, "utf8"), "original lock\n");
  assert.equal(await readFile(join(destination, "node_modules/peer/index.js"), "utf8"), "export default 1;");
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
