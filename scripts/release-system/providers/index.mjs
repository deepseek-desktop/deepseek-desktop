import { publishFilesystem } from "./filesystem.mjs";
import { publishGitHub } from "./github.mjs";

const providers = new Map([
  ["filesystem", publishFilesystem],
  ["github", publishGitHub]
]);

export async function publishWithProvider(context) {
  const name = context.options.provider || "filesystem";
  const provider = providers.get(name);
  if (!provider) throw new Error(`unsupported release provider ${name}; available providers: ${[...providers.keys()].join(", ")}`);
  return provider(context);
}
