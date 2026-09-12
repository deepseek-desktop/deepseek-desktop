import { CONFIG_KEYS } from "./build-config.mjs";

export function dockerConfigEnvironmentArgs(environment = process.env) {
  return CONFIG_KEYS
    .filter(key => environment[key] !== undefined)
    .flatMap(key => ["--env", key]);
}
