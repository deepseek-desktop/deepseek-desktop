import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { atomicWriteJson } from "./common.mjs";

const initialState = Object.freeze({ schemaVersion: 1, releases: {} });

export class ReleaseStateStore {
  #queue = Promise.resolve();

  constructor(root) {
    this.root = resolve(root);
    this.statePath = join(this.root, "state.json");
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    try {
      await this.read();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await atomicWriteJson(this.statePath, initialState);
    }
  }

  async read() {
    const state = JSON.parse(await readFile(this.statePath, "utf8"));
    if (state.schemaVersion !== 1 || typeof state.releases !== "object" || !state.releases) {
      throw new Error("unsupported release controller state");
    }
    return state;
  }

  async transaction(mutator) {
    const operation = this.#queue.then(async () => {
      const state = await this.read();
      const result = await mutator(state);
      await atomicWriteJson(this.statePath, state);
      return result;
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}
