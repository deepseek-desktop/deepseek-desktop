import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export async function publishFilesystem({ release, stagingDirectory, options, controllerRoot }) {
  const destinationRoot = resolve(options.destination || join(controllerRoot, "published"));
  const destination = join(destinationRoot, release.tag);
  try {
    await stat(destination);
    throw new Error(`filesystem release destination already exists: ${destination}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(destinationRoot, { recursive: true });
  const temporary = join(destinationRoot, `.${basename(destination)}.${process.pid}.tmp`);
  await rm(temporary, { recursive: true, force: true });
  try {
    await cp(stagingDirectory, temporary, { recursive: true, errorOnExist: true });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { provider: "filesystem", location: destination };
}
