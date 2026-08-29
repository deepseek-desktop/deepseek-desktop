import { relative, resolve } from "node:path";
import process from "node:process";

import { flag, option, options, parseArguments, requireOption } from "./release-system/common.mjs";
import { prepareRelease } from "./release-system/prepared-release.mjs";

const root = resolve(import.meta.dirname, "..");
const parsed = parseArguments(process.argv.slice(2));
const allowed = new Set(["tag", "channel", "signed", "cache-root", "target"]);
const unknown = [...parsed.options.keys()].filter(key => !allowed.has(key));
if (parsed.positionals.length > 0 || unknown.length > 0) {
  throw new Error(`unsupported release:prepare arguments: ${[...parsed.positionals, ...unknown.map(key => `--${key}`)].join(", ")}`);
}
const result = await prepareRelease({
  root,
  tag: requireOption(parsed, "tag"),
  channel: option(parsed, "channel", "community"),
  signed: flag(parsed, "signed"),
  targetIds: options(parsed, "target"),
  cacheRoot: resolve(option(parsed, "cache-root", `${root}/target/local-release/prepared`))
});
console.log(JSON.stringify({
  descriptor: result.descriptor,
  cacheDirectory: relative(root, result.directory).replaceAll("\\", "/"),
  cacheHit: result.cacheHit,
  timings: result.timings
}, null, 2));
