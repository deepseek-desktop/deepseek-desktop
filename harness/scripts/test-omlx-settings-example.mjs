import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const examplePath = resolve(root, "docs/examples/omlx-qwen38.settings.yaml");
const adapterPath = resolve(
  root,
  "target/generated/harness/prepared/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"
);

await access(adapterPath);
const { Config } = await import(pathToFileURL(adapterPath).href);
const example = parse(await readFile(examplePath, "utf8"));
const resolved = Config(example["llm-pi-ai"]);
const provider = resolved.providers.omlx;
const model = provider.models[0];

assert.equal(provider.api, "openai-completions");
assert.equal(provider.baseURL, "http://127.0.0.1:8888/v1");
assert.equal(provider.streamIdleTimeoutMs, 900_000);
assert.equal(provider.reasoning, "medium");
assert.equal(provider.compat.thinkingFormat, "chat-template");
assert.equal(provider.compat.chatTemplateKwargs.enable_thinking.$var, "thinking.enabled");
assert.equal(provider.compat.chatTemplateKwargs.preserve_thinking, true);
assert.equal(provider.compat.chatTemplateKwargs.reasoning_effort.$var, "thinking.effort");
assert.equal(provider.compat.chatTemplateKwargs.reasoning_effort.omitWhenOff, true);
assert.deepEqual(
  {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    reasoningEfforts: model.reasoningEfforts
  },
  {
    id: "qwen3.8-27b-4bit",
    name: "Qwen3.8 27B",
    contextWindow: 131_072,
    maxTokens: 32_768,
    input: ["text"],
    reasoningEfforts: { off: null, low: "low", medium: "medium", xhigh: "xhigh" }
  }
);
assert.deepEqual(example["agent-default-model"], {
  provider: "omlx",
  model: "qwen3.8-27b-4bit"
});

console.log("oMLX Qwen3.8 settings example matches the staged Harness schema");
