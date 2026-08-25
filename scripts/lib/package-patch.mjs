import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import process from "node:process";

function invokeGitApply(directory, patchFile, args) {
  return spawnSync("git", ["apply", "--no-index", ...args, patchFile], {
    cwd: directory,
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: dirname(directory),
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "0"
    }
  });
}

function assertCompleted(result) {
  if (result.error) throw result.error;
  return result.status === 0;
}

export function applyPackagePatch(directory, patchFile) {
  const forwardCheck = invokeGitApply(directory, patchFile, ["--check"]);
  if (assertCompleted(forwardCheck)) {
    const applyResult = invokeGitApply(directory, patchFile, []);
    if (!assertCompleted(applyResult)) {
      throw new Error(`failed to apply ${patchFile}: ${applyResult.stderr || applyResult.stdout}`);
    }
    return "applied";
  }

  const reverseCheck = invokeGitApply(directory, patchFile, ["--reverse", "--check"]);
  if (assertCompleted(reverseCheck)) return "already-applied";

  throw new Error(`patch does not apply: ${patchFile}: ${forwardCheck.stderr || forwardCheck.stdout}`);
}
