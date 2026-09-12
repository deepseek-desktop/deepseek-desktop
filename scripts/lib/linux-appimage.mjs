import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";

const WRAPPER_TARGET = "DEEPSEEK_DESKTOP_LDD_MUSL_SYSTEM_NODE";
const WRAPPER_EXPECTED_SHA256 = "DEEPSEEK_DESKTOP_LDD_MUSL_SYSTEM_NODE_SHA256";
const WRAPPER_IDENTITY_MARKER = "DEEPSEEK_DESKTOP_LDD_MUSL_IDENTITY_MARKER";
const WRAPPER_DIAGNOSTIC = "DEEPSEEK_DESKTOP_LDD_DIAGNOSTIC";
const WRAPPER_REAL_LDD = "DEEPSEEK_DESKTOP_REAL_LDD";
const WRAPPER_REAL_LDD_ARGS = "DEEPSEEK_DESKTOP_REAL_LDD_ARGS";
const WRAPPER_PATCHED_SHA256 = "DEEPSEEK_DESKTOP_LDD_MUSL_PATCHED_SHA256";

const wrapperSource = `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { appendFileSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const target = process.env.${WRAPPER_TARGET};
const expectedSha256 = process.env.${WRAPPER_EXPECTED_SHA256};
const patchedSha256 = process.env.${WRAPPER_PATCHED_SHA256};
const identityMarker = process.env.${WRAPPER_IDENTITY_MARKER};
const diagnosticPath = process.env.${WRAPPER_DIAGNOSTIC};
const realLdd = process.env.${WRAPPER_REAL_LDD};
const realLddArgs = JSON.parse(process.env.${WRAPPER_REAL_LDD_ARGS} || "[]");
const args = process.argv.slice(2);
const requested = args.length === 1 ? resolve(args[0]) : "";
const resolvedTarget = resolve(target);
const canonical = value => {
  try { return realpathSync.native(value); } catch { return value; }
};
const matchesTarget = requested && (
  requested === resolvedTarget || canonical(requested) === canonical(resolvedTarget)
);

function fail(message) {
  const line = \`deepseek-desktop ldd wrapper: \${message}\`;
  try { appendFileSync(diagnosticPath, \`\${line}\\n\`); } catch {}
  process.stderr.write(\`\${line}\\n\`);
  process.exit(125);
}

if (matchesTarget) {
  let actualSha256;
  try {
    actualSha256 = createHash("sha256").update(readFileSync(requested)).digest("hex");
  } catch (error) {
    fail(\`cannot read the staged official musl system.node: \${error instanceof Error ? error.message : String(error)}\`);
  }
  if (actualSha256 === expectedSha256) {
    let state;
    try {
      writeFileSync(identityMarker, \`original \${expectedSha256}\\n\`, { flag: "wx", mode: 0o600 });
      state = \`original \${expectedSha256}\`;
    } catch (error) {
      if (error?.code !== "EEXIST") fail(\`cannot record the verified musl identity: \${error instanceof Error ? error.message : String(error)}\`);
      try {
        state = readFileSync(identityMarker, "utf8").trim();
      } catch (readError) {
        fail(\`cannot read the verified musl identity: \${readError instanceof Error ? readError.message : String(readError)}\`);
      }
    }
    if (state === \`patched \${patchedSha256}\`) fail("official musl system.node reverted after its patched copy was observed");
    if (state !== \`original \${expectedSha256}\`) fail("verified musl identity marker changed");
    process.exit(0);
  }

  if (actualSha256 === patchedSha256) {
    let state;
    try {
      state = readFileSync(identityMarker, "utf8").trim();
    } catch {
      fail("official musl system.node reached the patched state before its original copy was observed");
    }
    if (state === \`original \${expectedSha256}\`) {
      try {
        writeFileSync(identityMarker, \`patched \${patchedSha256}\\n\`, { mode: 0o600 });
      } catch (error) {
        fail(\`cannot record the patched musl identity: \${error instanceof Error ? error.message : String(error)}\`);
      }
    } else if (state !== \`patched \${patchedSha256}\`) {
      fail("verified musl identity marker changed");
    }
    process.exit(0);
  }

  fail(\`official musl system.node byte identity mismatch; expected original sha256 \${expectedSha256} or patched sha256 \${patchedSha256}, received \${actualSha256}\`);
}

const delegated = spawnSync(realLdd, [...realLddArgs, ...args], {
  env: process.env,
  stdio: "inherit"
});
if (delegated.error) fail(\`failed to delegate to real ldd: \${delegated.error.message}\`);
if (delegated.signal) process.kill(process.pid, delegated.signal);
process.exit(delegated.status ?? 125);
`;

async function findExecutable(name, pathValue) {
  for (const entry of (pathValue || "").split(":").filter(Boolean)) {
    const candidate = join(entry, name);
    try {
      await access(candidate, constants.X_OK);
      return realpath(candidate);
    } catch {
      // Continue searching the original PATH.
    }
  }
  throw new Error(`Linux AppImage packaging requires ${name} on PATH`);
}

function verifyMuslDynamicState({
  file,
  label,
  environment,
  executable,
  readelfArguments,
  expectedRunpaths
}) {
  const result = spawnSync(executable, [...readelfArguments, "--dynamic", "--wide", file], {
    encoding: "utf8",
    env: { ...environment, LC_ALL: "C" },
    stdio: "pipe"
  });
  if (result.error) {
    throw new Error(`failed to inspect ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`readelf exited with code ${String(result.status)} for ${label}`);
  }
  if (result.stderr.trim()) {
    throw new Error(`readelf wrote unexpected stderr for ${label}`);
  }
  const dependencies = [...result.stdout.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/gu)]
    .map(match => match[1]);
  if (dependencies.length !== 1 || dependencies[0] !== "libc.so") {
    throw new Error(`${label} dependencies changed: ${JSON.stringify(dependencies)}`);
  }
  const runpaths = [...result.stdout.matchAll(/\(RUNPATH\)\s+Library runpath: \[([^\]]*)\]/gu)]
    .map(match => match[1]);
  const rpaths = [...result.stdout.matchAll(/\(RPATH\)\s+Library rpath: \[([^\]]*)\]/gu)]
    .map(match => match[1]);
  if (JSON.stringify(runpaths) !== JSON.stringify(expectedRunpaths) || rpaths.length !== 0) {
    throw new Error(`${label} dynamic paths changed: runpath=${JSON.stringify(runpaths)}, rpath=${JSON.stringify(rpaths)}`);
  }
}

/**
 * linuxdeploy asks the host ldd to inspect every ELF resource in the AppDir.
 * The official Harness also carries a musl Node-API binary that glibc ldd
 * cannot inspect reliably. Harness verification has already authenticated the
 * staged platform package. Precompute the exact result of the selected
 * patchelf, require linuxdeploy to use that executable, and accept only those
 * two byte identities in monotonic order. Delegate every other ldd call.
 */
export async function prepareLinuxAppImageLdd({
  platform = process.platform,
  environment = process.env,
  muslSystemNode,
  muslSystemNodeSource,
  realLdd,
  realLddArguments = [],
  readelf,
  readelfArguments = [],
  patchelf,
  patchelfArguments = [],
  temporaryRoot = tmpdir(),
  log = console.error
} = {}) {
  if (platform !== "linux") {
    return {
      environment: {},
      verifyFinal: async () => "",
      reportFailure: async () => "",
      cleanup: async () => {}
    };
  }
  if (!muslSystemNode || !isAbsolute(muslSystemNode)) {
    throw new Error("Linux AppImage packaging requires an absolute official musl system.node path");
  }
  if (!muslSystemNodeSource || !isAbsolute(muslSystemNodeSource)) {
    throw new Error("Linux AppImage packaging requires an absolute verified musl system.node source path");
  }
  await access(muslSystemNodeSource, constants.R_OK);
  const readelfExecutable = readelf
    ? await realpath(resolve(readelf))
    : await findExecutable("readelf", environment.PATH);
  verifyMuslDynamicState({
    file: muslSystemNodeSource,
    label: "official musl system.node",
    environment,
    executable: readelfExecutable,
    readelfArguments,
    expectedRunpaths: []
  });
  const sourceBytes = await readFile(muslSystemNodeSource);
  const expectedSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const delegatedLdd = realLdd
    ? await realpath(resolve(realLdd))
    : await findExecutable("ldd", environment.PATH);
  const patchelfExecutable = patchelf
    ? await realpath(resolve(patchelf))
    : await findExecutable("patchelf", environment.PATH);
  const directory = await mkdtemp(join(temporaryRoot, "deepseek-appimage-ldd-"));
  const wrapperPath = join(directory, "ldd");
  const identityMarker = join(directory, "identity.sha256");
  const diagnosticPath = join(directory, "diagnostic.log");
  const patchedProbe = join(directory, "patched-system.node");
  let patchedSha256;
  try {
    await writeFile(patchedProbe, sourceBytes, { mode: 0o755 });
    const patched = spawnSync(
      patchelfExecutable,
      [...patchelfArguments, "--set-rpath", "$ORIGIN", patchedProbe],
      {
        encoding: "utf8",
        env: { ...environment, LC_ALL: "C" },
        stdio: "pipe"
      }
    );
    if (patched.error) throw new Error(`failed to precompute the patched musl module: ${patched.error.message}`);
    if (patched.signal) throw new Error(`patchelf received signal ${patched.signal} while precomputing the musl module`);
    if (patched.status !== 0) {
      throw new Error(`patchelf exited with code ${String(patched.status)} while precomputing the musl module`);
    }
    if (patched.stdout.trim() || patched.stderr.trim()) {
      throw new Error("patchelf wrote unexpected output while precomputing the musl module");
    }
    verifyMuslDynamicState({
      file: patchedProbe,
      label: "precomputed post-patchelf musl system.node",
      environment,
      executable: readelfExecutable,
      readelfArguments,
      expectedRunpaths: ["$ORIGIN"]
    });
    patchedSha256 = createHash("sha256").update(await readFile(patchedProbe)).digest("hex");
    if (patchedSha256 === expectedSha256) {
      throw new Error("patchelf did not change the official musl system.node byte identity");
    }
    await rm(patchedProbe, { force: true });
    await writeFile(wrapperPath, wrapperSource);
    await chmod(wrapperPath, 0o755);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const existingPath = (environment.PATH || "").split(":").filter(Boolean);
  const nodeDirectory = dirname(process.execPath);
  const path = [directory, nodeDirectory, ...existingPath]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(":");
  return {
    directory,
    wrapperPath,
    identityMarker,
    environment: {
      PATH: path,
      NO_STRIP: "1",
      PATCHELF: patchelfExecutable,
      [WRAPPER_TARGET]: resolve(muslSystemNode),
      [WRAPPER_EXPECTED_SHA256]: expectedSha256,
      [WRAPPER_PATCHED_SHA256]: patchedSha256,
      [WRAPPER_IDENTITY_MARKER]: identityMarker,
      [WRAPPER_DIAGNOSTIC]: diagnosticPath,
      [WRAPPER_REAL_LDD]: delegatedLdd,
      [WRAPPER_REAL_LDD_ARGS]: JSON.stringify(realLddArguments)
    },
    verifyFinal: async () => {
      const actualSha256 = createHash("sha256").update(await readFile(muslSystemNode)).digest("hex");
      if (actualSha256 !== patchedSha256) {
        throw new Error(`final official musl system.node identity mismatch: expected sha256 ${patchedSha256}, received ${actualSha256}`);
      }
      const state = (await readFile(identityMarker, "utf8")).trim();
      if (state !== `patched ${patchedSha256}`) {
        throw new Error(`final official musl system.node state mismatch: ${JSON.stringify(state)}`);
      }
      return actualSha256;
    },
    reportFailure: async () => {
      let diagnostic = "";
      try {
        diagnostic = (await readFile(diagnosticPath, "utf8")).trim();
      } catch (error) {
        if (error?.code !== "ENOENT") {
          log(`Linux AppImage ldd diagnostics could not be read (${error?.code || "unknown error"})`);
        }
      }
      if (diagnostic) log(`Linux AppImage ldd diagnostics:\n${diagnostic}`);
      return diagnostic;
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}
