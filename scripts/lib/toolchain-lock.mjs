import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

// Rustup cannot safely install into the same private toolchain from two commands.
export async function acquireToolchainLock(root, timeoutMs = 30 * 60_000) {
  await mkdir(root, { recursive: true });
  const directory = join(root, ".rust-command-lock");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(directory);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(await readFile(join(directory, "pid"), "utf8").catch(() => ""));
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); } catch (error) {
          if (error.code === "ESRCH") throw new Error(`Rust toolchain lock owner has exited; remove ${directory} after checking for remaining build processes`);
        }
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the Rust toolchain lock");
      await setTimeout(250);
    }
  }
  try { await writeFile(join(directory, "pid"), String(process.pid)); } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return () => rm(directory, { recursive: true, force: true });
}
