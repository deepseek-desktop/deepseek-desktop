import { access, chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";

const WRAPPER_TARGET = "DEEPSEEK_DESKTOP_LDD_MUSL_SYSTEM_NODE";
const WRAPPER_LIBC = "DEEPSEEK_DESKTOP_LDD_MUSL_LIBC";
const WRAPPER_REAL_LDD = "DEEPSEEK_DESKTOP_REAL_LDD";
const WRAPPER_REAL_LDD_ARGS = "DEEPSEEK_DESKTOP_REAL_LDD_ARGS";

const wrapperSource = `#!/usr/bin/env node
const { dirname, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const target = process.env.${WRAPPER_TARGET};
const libc = process.env.${WRAPPER_LIBC};
const realLdd = process.env.${WRAPPER_REAL_LDD};
const realLddArgs = JSON.parse(process.env.${WRAPPER_REAL_LDD_ARGS} || "[]");
const args = process.argv.slice(2);
const requested = args.length === 1 ? resolve(args[0]) : "";

function fail(message, result) {
  const detail = [result?.stderr, result?.stdout].map(value => value?.trim()).filter(Boolean).join("; ");
  process.stderr.write(\`deepseek-desktop ldd wrapper: \${message}\${detail ? \`: \${detail}\` : ""}\\n\`);
  process.exit(125);
}

if (requested === target) {
  const probe = spawnSync(realLdd, [...realLddArgs, ...args], {
    encoding: "utf8",
    env: { ...process.env, LD_LIBRARY_PATH: dirname(libc) },
    stdio: "pipe"
  });
  if (probe.error) fail(\`failed to probe official musl system.node: \${probe.error.message}\`);
  if (probe.status !== 0) fail(\`real ldd exited with code \${String(probe.status)} for official musl system.node\`, probe);
  if (probe.stderr.trim()) fail("real ldd wrote unexpected stderr for official musl system.node", probe);

  const lines = probe.stdout.split(/\\r?\\n/u).map(value => value.trim()).filter(Boolean);
  const match = lines.length === 1
    ? /^libc\\.so\\s+=>\\s+(.+?)\\s+\\(0x[0-9a-f]+\\)$/iu.exec(lines[0])
    : null;
  if (!match || resolve(match[1]) !== resolve(libc)) {
    fail(\`official musl system.node dependencies changed; expected only libc.so => \${libc}\`, probe);
  }
  process.exit(0);
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

/**
 * linuxdeploy asks the host ldd to inspect every ELF resource in the AppDir.
 * The official Harness also carries a musl Node-API binary whose unversioned
 * libc.so dependency cannot be inspected with Ubuntu's default search path.
 * Probe that one exact file against musl, hide the verified libc dependency
 * from linuxdeploy, and delegate every other ldd call unchanged.
 */
export async function prepareLinuxAppImageLdd({
  platform = process.platform,
  environment = process.env,
  muslSystemNode,
  muslLibc = "/usr/lib/x86_64-linux-musl/libc.so",
  realLdd,
  realLddArguments = [],
  temporaryRoot = tmpdir()
} = {}) {
  if (platform !== "linux") {
    return { environment: {}, cleanup: async () => {} };
  }
  if (!muslSystemNode || !isAbsolute(muslSystemNode)) {
    throw new Error("Linux AppImage packaging requires an absolute official musl system.node path");
  }
  if (!isAbsolute(muslLibc)) {
    throw new Error("Linux AppImage packaging requires an absolute musl libc path");
  }
  await access(muslLibc, constants.R_OK);
  const delegatedLdd = realLdd
    ? await realpath(resolve(realLdd))
    : await findExecutable("ldd", environment.PATH);
  const directory = await mkdtemp(join(temporaryRoot, "deepseek-appimage-ldd-"));
  const wrapperPath = join(directory, "ldd");
  try {
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
    environment: {
      PATH: path,
      [WRAPPER_TARGET]: resolve(muslSystemNode),
      [WRAPPER_LIBC]: resolve(muslLibc),
      [WRAPPER_REAL_LDD]: delegatedLdd,
      [WRAPPER_REAL_LDD_ARGS]: JSON.stringify(realLddArguments)
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}
