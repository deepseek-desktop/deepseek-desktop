import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const desktopRoot = resolve(import.meta.dirname, "..", "..");
const preparedRoot = resolve(desktopRoot, process.env.DEEPSEEK_DESKTOP_TEST_HARNESS_DIR || "target/generated/harness/prepared");
const moduleUrl = pathToFileURL(resolve(
  preparedRoot,
  "node_modules/@deepseek-ai/dsh-web-search-follow-model/index.js"
)).href;
const selectionUrl = pathToFileURL(resolve(
  preparedRoot,
  "node_modules/@deepseek-ai/dsh-web-search-follow-model/selection.js"
)).href;
const { default: FollowModelWebSearch, FollowModelSearchEngine, declaredSearchRoutes, resolveConfiguredRoutes } = await import(moduleUrl);
const { default: WebSearchSelection, validateSelection } = await import(selectionUrl);
const secretA = "secret-a-for-test";
const secretB = "secret-b-for-test";

function agent(provider = "provider-a", model = "model-a") {
  return { session: { requestHeader: () => ({ config: { provider, model } }) } };
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function createEngine({ routes, fetchImpl, credentials = { PROVIDER_A_KEY: secretA, PROVIDER_B_KEY: secretB }, timeoutMs }) {
  const resolvedRefs = [];
  const engine = new FollowModelSearchEngine({
    fetch: fetchImpl,
    resolveCredential: async ref => {
      resolvedRefs.push(ref);
      return credentials[ref];
    },
    timeoutMs
  });
  engine.registerRouteResolver(({ provider, model }) => routes[`${provider}/${model}`]);
  return { engine, resolvedRefs };
}

async function eventually(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("public Agent context routes concurrent WebRuntime searches without replacing the official provider", async t => {
  const require = createRequire(moduleUrl);
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const { Context, Service } = await load("@deepseek-ai/cordis");
  const { default: AgentRegistry } = await load("@deepseek-ai/dsh-agent");
  const { default: WebRuntime } = await load("@deepseek-ai/dsh-web");
  const officialPlugin = await load("@deepseek-ai/dsh-web-search-deepseek");
  const { default: SettingsProvider } = await load("@deepseek-ai/dsh-settings");
  class MemorySettings extends SettingsProvider {
    get writable() { return true; }
    async load() { return {}; }
    async persist() {}
  }
  class Credentials extends Service {
    constructor(ctx) { super(ctx, "credentials"); }
    async resolve(ref) { return { value: ref === "PROVIDER_A_KEY" ? secretA : secretB }; }
  }
  class Models extends Service {
    constructor(ctx) { super(ctx, "llm"); }
    listProviders() { return [{ id: "provider-a" }, { id: "provider-b" }]; }
    listConfigurableProviders() { return this.listProviders().map(({ id }) => ({ provider: id, settingsNs: "llm-pi-ai", settingsPath: ["providers", id] })); }
  }
  class SearchSelection extends Service {
    constructor(ctx) {
      super(ctx, "webSearchSelection");
      this.searchEnabled = true;
    }
  }
  const observed = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    const body = JSON.parse(options.body);
    observed.push([new URL(url).hostname, body.model, options.headers.authorization]);
    assert.equal(body.tool_choice, "auto");
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    return jsonResponse({ output_text: body.model, output: [{ type: "web_search_call", status: "completed" }] });
  });
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(WebRuntime, { searchProvider: "follow-model" });
  await ctx.plugin(MemorySettings);
  await ctx.plugin(Credentials);
  await ctx.plugin(Models);
  await ctx.plugin(SearchSelection);
  const { default: z } = await load("@deepseek-ai/schemastery");
  ctx.settings.register("llm-pi-ai", z.any(), { base: { providers: {
    "provider-a": { baseURL: "https://provider-a.test/v1", api: "openai-responses", apiKeyEnv: "PROVIDER_A_KEY" },
    "provider-b": { baseURL: "https://provider-b.test/v1", api: "openai-responses", apiKeyEnv: "PROVIDER_B_KEY" }
  } } });
  const official = await ctx.plugin(officialPlugin, { apiKey: "official-fixture-key" });
  await ctx.plugin(FollowModelWebSearch);
  assert.ok(ctx.settings.describe().some(section => section.ns === "web-search-deepseek"));
  const first = agent();
  const second = agent("provider-b", "model-b");
  await Promise.all([first, second].map(current => ctx.agents.withInitiator(current, () => ctx.web.search({ query: "search" }))));
  assert.deepEqual(observed.sort(), [
    ["provider-a.test", "model-a", `Bearer ${secretA}`], ["provider-b.test", "model-b", `Bearer ${secretB}`]
  ]);
  first.session.requestHeader = () => ({ config: { provider: "provider-b", model: "model-c" } });
  await ctx.agents.withInitiator(first, () => ctx.web.search({ query: "model switched" }));
  assert.deepEqual(observed.at(-1), ["provider-b.test", "model-c", `Bearer ${secretB}`]);
  await assert.rejects(ctx.web.search({ query: "outside an agent" }), { code: "WEB_FOLLOW_MODEL_ROUTE_MISSING" });
  await official.dispose();
  await ctx.agents.withInitiator(first, () => ctx.web.search({ query: "official disabled" }));
  assert.equal(observed.length, 4);
  ctx.webSearchSelection.searchEnabled = false;
  await assert.rejects(
    ctx.agents.withInitiator(first, () => ctx.web.search({ query: "desktop disabled" })),
    { code: "WEB_FOLLOW_MODEL_DISABLED" },
  );
  assert.equal(observed.length, 4);
});

test("public Settings and Loader APIs apply independent, disabled and restored search routing live", async () => {
  const require = createRequire(moduleUrl);
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const { Context } = await load("@deepseek-ai/cordis");
  const { default: Loader } = await load("@deepseek-ai/cordis-plugin-loader");
  const { default: WebRuntime } = await load("@deepseek-ai/dsh-web");
  const { default: SettingsProvider } = await load("@deepseek-ai/dsh-settings");
  class MemorySettings extends SettingsProvider {
    get writable() { return true; }
    async load() { return {}; }
    async persist() {}
  }
  class GuardedWebRuntime extends WebRuntime {
    constructor(ctx, config) {
      super(ctx, config);
      if (config.searchProvider === "broken-apply") throw new Error("fixture rejects this Provider");
    }
  }
  const ctx = new Context();
  try {
    await ctx.plugin(Loader);
    await ctx.plugin(MemorySettings);
    await ctx.plugin(WebSearchSelection);
    assert.ok(ctx.settings.describe().some(section => section.ns === "web-search-follow-model"));
    ctx.loader.builtins["guarded-web"] = GuardedWebRuntime;
    await ctx.loader.create({
      id: "web",
      name: "cordis:guarded-web",
      inject: ["webSearchSelection"],
      config: {
        searchProvider: { __jsExpr: "ctx.get('webSearchSelection').searchProvider" },
        fetchProvider: "http",
      },
    });
    const calls = [];
    await ctx.plugin({
      inject: ["web", "webSearchSelection"],
      apply(current) {
        current.web.registerSearchProvider({
          id: "follow-model",
          available: () => true,
          search: async () => {
            if (!current.webSearchSelection.searchEnabled) {
              const error = new Error("disabled by Desktop settings");
              error.code = "WEB_FOLLOW_MODEL_DISABLED";
              throw error;
            }
            return { content: "follow", sources: [] };
          },
        });
        current.web.registerSearchProvider({ id: "fixture-independent", available: () => true, search: async () => ({ content: "independent", sources: [] }) });
        calls.push(current.web);
      },
    });
    assert.equal((await ctx.web.search({ query: "default" })).content, "follow");

    await ctx.settings.update("web-search-follow-model", { mode: "independent", independentProvider: "fixture-independent" });
    await eventually(() => ctx.get("webSearchSelection").searchProvider === "fixture-independent" && calls.length >= 2,
      "independent Provider selection did not reload WebRuntime");
    assert.equal((await ctx.web.search({ query: "independent" })).content, "independent");
    assert.equal([...ctx.loader.entries()].find(entry => entry.options.id === "web")?.options.config.searchProvider, "fixture-independent");

    const callsBeforeDisable = calls.length;
    await ctx.settings.update("web-search-follow-model", { mode: "disabled" });
    await eventually(() => ctx.get("webSearchSelection").searchEnabled === false
      && ctx.get("webSearchSelection").searchProvider === "follow-model"
      && ctx.web !== undefined
      && calls.length > callsBeforeDisable,
      "disabling search did not restore the guarded follow-model route");
    await assert.rejects(ctx.web.search({ query: "disabled" }), { code: "WEB_FOLLOW_MODEL_DISABLED" });

    await ctx.settings.replace("web-search-follow-model", {});
    await eventually(() => ctx.get("webSearchSelection").searchProvider === "follow-model" && ctx.get("webSearchSelection").searchEnabled === true,
      "restoring defaults did not re-enable follow-model routing");
    assert.equal((await ctx.web.search({ query: "restored" })).content, "follow");

    assert.throws(() => validateSelection({ mode: "independent", independentProvider: "follow-model" }));
    await assert.rejects(ctx.settings.update("web-search-follow-model", {
      mode: "independent", independentProvider: "bad provider",
    }));

    await ctx.settings.update("web-search-follow-model", { mode: "independent", independentProvider: "broken-apply" });
    await eventually(() => ctx.settings.describe().find(section => section.ns === "web-search-follow-model")?.value?.mode === "follow-model",
      "failed live routing did not restore the previous persisted selection");
    assert.equal(ctx.get("webSearchSelection").searchProvider, "follow-model");
    assert.equal((await ctx.web.search({ query: "after rollback" })).content, "follow");
  } finally {
    await ctx.fiber.dispose();
  }
});

test("native DeepSeek route uses its public connection resolver without borrowing official search settings", async () => {
  let value = { apiKeyEnv: "MODEL_KEY" };
  const ctx = {
    get(name) { return name === "llm" ? {
      listProviders: () => [{ id: "deepseek-official" }],
      listConfigurableProviders: () => [{ provider: "deepseek-official", settingsNs: "llm-deepseek", settingsPath: [] }]
    } : undefined; },
    settings: { describe: () => [{ ns: "llm-deepseek", value }, { ns: "web-search-deepseek", value: { apiKeyEnv: "DO_NOT_USE" } }] }
  };
  const routes = await resolveConfiguredRoutes(ctx, { provider: "deepseek-official", model: "deepseek-v4-pro" });
  assert.equal(routes[0].credentialRef, "MODEL_KEY");
  assert.equal(routes[0].webSearch.endpointPath, "/anthropic/v1");
  value = { baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "MODEL_KEY" };
  assert.equal((await resolveConfiguredRoutes(ctx, { provider: "deepseek-official", model: "deepseek-v4-pro" }))[0].webSearch.endpointPath, "/anthropic/v1");
  value = { baseURL: "https://custom.test", apiKeyEnv: "CUSTOM_KEY" };
  assert.deepEqual(await resolveConfiguredRoutes(ctx, { provider: "deepseek-official", model: "custom" }), []);
});

test("ignored search requests and server tool errors are not accepted as successful search", async () => {
  for (const apiProtocol of ["openai-responses", "openai-completions", "anthropic-messages"]) {
    const { engine } = createEngine({ routes: { "provider-a/model-a": {
      provider: "provider-a", model: "model-a", endpoint: "https://provider-a.test", credentialRef: "PROVIDER_A_KEY", apiProtocol
    } }, fetchImpl: async () => jsonResponse({ output_text: "ordinary answer", choices: [{ message: { content: "ordinary answer" } }],
      content: [{ type: "text", text: "ordinary answer" }, { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }] }) });
    await assert.rejects(engine.search(agent(), { query: "search" }), { code: "WEB_FOLLOW_MODEL_SEARCH_NOT_PERFORMED" });
  }
});

test("Responses supports thinking models and extracts completed server search sources without prose scraping", async () => {
  const { engine } = createEngine({ routes: { "provider-a/model-a": {
    provider: "provider-a", model: "model-a", endpoint: "https://provider-a.test/v1", credentialRef: "PROVIDER_A_KEY", apiProtocol: "openai-responses"
  } }, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.tool_choice, "auto");
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    assert.match(body.input, /Use the web search tool/u);
    assert.ok(body.input.endsWith("original query"));
    assert.equal(body.enable_thinking, undefined);
    return jsonResponse({ output: [
      { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: "https://sources.test/result" }] } },
      { type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://sources.test/page" } },
      { type: "web_search_call", status: "failed", action: { type: "search", sources: [{ url: "https://sources.test/failed" }] } },
      { type: "message", content: [{ type: "output_text", text: "Answer with an unverified https://sources.test/prose link.", annotations: [] }] }
    ] });
  } });
  const result = await engine.search(agent(), { query: "original query" });
  assert.deepEqual(result.sources.map(source => source.url), ["https://sources.test/result", "https://sources.test/page"]);
});

test("Harness provider settings own connection metadata; unknown model fields cannot repoint it", async () => {
  const sections = [{ value: { providers: {
    "provider-a": { baseURL: "https://provider-a.test/v1", apiKeyEnv: "PROVIDER_A_KEY", api: "openai-responses", models: [
      { id: "model-a", api: "openai-responses", baseURL: "https://provider-a.test/alternate" }
    ] },
    "provider-b": { baseURL: "https://provider-b.test/v1", apiKeyEnv: "PROVIDER_B_KEY", api: "openai-completions" }
  } } }];
  const observed = [];
  const engine = new FollowModelSearchEngine({
    resolveDeclaredRoute: selection => declaredSearchRoutes(sections, selection),
    resolveCredential: ref => ({ PROVIDER_A_KEY: secretA, PROVIDER_B_KEY: secretB })[ref],
    fetch: async (url, options) => {
      observed.push([String(url), options.headers.authorization]);
      return jsonResponse({ output_text: "answer", output: [{ type: "web_search_call", status: "completed" }], choices: [{ message: { content: "answer", citations: ["https://sources.test/result"] } }] });
    }
  });
  await engine.search(agent(), { query: "first" });
  await engine.search(agent("provider-b", "model-b"), { query: "second" });
  assert.deepEqual(observed, [
    ["https://provider-a.test/v1/responses", `Bearer ${secretA}`],
    ["https://provider-b.test/v1/chat/completions", `Bearer ${secretB}`]
  ]);
  await assert.rejects(engine.search(agent("unknown", "unknown"), { query: "no probe" }), { code: "WEB_FOLLOW_MODEL_CAPABILITY_MISSING" });
  assert.equal(observed.length, 2);
  engine.registerRouteResolver(selection => ({ ...selection, endpoint: "https://adapter.test/v1", apiProtocol: "openai-completions", credentialRef: "PROVIDER_A_KEY" }));
  await engine.search(agent(), { query: "adapter wins" });
  assert.equal(observed.at(-1)[0], "https://adapter.test/v1/chat/completions");
});

test("audited endpoints resolve search independently of omitted or chat-only API settings", async () => {
  const urls = ["https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "https://api.deepseek.com/v1"];
  const observed = [];
  for (const baseURL of urls) {
    for (const api of [undefined, "openai-completions", "openai-responses"]) {
      const provider = { baseURL, api, apiKeyEnv: "PROVIDER_A_KEY", models: [{ id: "model-a" }] };
      const sections = [{ value: { providers: { "provider-a": provider } } }];
      const engine = new FollowModelSearchEngine({
        resolveDeclaredRoute: selection => declaredSearchRoutes(sections, selection),
        resolveCredential: ref => { assert.equal(ref, "PROVIDER_A_KEY"); return secretA; },
        fetch: async (url, options) => {
          observed.push(String(url));
          assert.equal(options.headers.authorization, `Bearer ${secretA}`);
          assert.equal(JSON.parse(options.body).model, "model-a");
          return jsonResponse({ output_text: "searched", output: [{ type: "web_search_call", status: "completed" }] });
        }
      });
      await engine.search(agent(), { query: "search" });
      assert.equal(observed.at(-1), baseURL + "/responses");
      provider.webSearch = false;
      await assert.rejects(engine.search(agent(), { query: "disabled" }), { code: "WEB_FOLLOW_MODEL_CAPABILITY_MISSING" });
    }
  }
  assert.equal(observed.length, 6);
  for (const baseURL of ["https://api.deepseek.com.evil.test/v1", "https://api.deepseek.com/custom", "https://token-plan.cn-beijing.maas.aliyuncs.com/other"]) {
    assert.deepEqual(declaredSearchRoutes([{ value: { providers: { deepseek: { baseURL, apiKeyEnv: "PROVIDER_A_KEY" } } } }], { provider: "deepseek", model: "model-a" }), []);
  }
});

test("declared routes reject ambiguity and incomplete connection metadata", async () => {
  const selection = { provider: "provider-a", model: "model-a" };
  assert.deepEqual(declaredSearchRoutes([{ value: { providers: { "provider-a": { baseURL: "https://provider-a.test" } } } }], selection), []);
  const section = { value: { providers: { "provider-a": { baseURL: "https://provider-a.test", apiKeyEnv: "PROVIDER_A_KEY", api: "openai-responses" } } } };
  const engine = new FollowModelSearchEngine({ resolveDeclaredRoute: route => declaredSearchRoutes([section, section], route) });
  await assert.rejects(engine.resolveRoute(agent()), { code: "WEB_FOLLOW_MODEL_ROUTE_AMBIGUOUS" });
});

test("prepared Harness carries one public Provider selector without a duplicate model search control", async () => {
  const [bundle, modelsSettingsUi, pluginsSettingsUi] = await Promise.all([
    readFile(resolve(preparedRoot, "node_modules/deepseek-desktop-bundle/cordis.patch.yml"), "utf8"),
    readFile(resolve(preparedRoot, "node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js"), "utf8"),
    readFile(resolve(preparedRoot, "node_modules/@deepseek-ai/dsh-web-search-follow-model/client.js"), "utf8")
  ]);
  assert.match(bundle, /searchProvider:\s*!!js ctx\.get\('webSearchSelection'\)\.searchProvider/u);
  assert.doesNotMatch(bundle, /id:\s*tool-web/u);
  assert.doesNotMatch(modelsSettingsUi, /webSearchProtocol|WEB_SEARCH_PROTOCOLS/u);
  assert.match(pluginsSettingsUi, /"follow-model":\s*"Follow current model"/u);
  assert.match(pluginsSettingsUi, /"follow-model":\s*"跟随当前模型"/u);
  assert.match(pluginsSettingsUi, /"follow-model":\s*"跟隨目前模型"/u);
  assert.doesNotMatch(pluginsSettingsUi, /current model \(default\)|当前模型（默认）|目前模型（預設）/u);
  assert.match(modelsSettingsUi, /Supports image input/u);
  assert.match(modelsSettingsUi, /支持图片输入/u);
  assert.match(modelsSettingsUi, /inputModalities", event\.target\.checked \? \["text", "image"\] : \["text"\]/u);
  assert.match(modelsSettingsUi, /input: event\.target\.checked \? \["text", "image"\] : \["text"\]/u);
});

test("unset search capability automatically follows the active model API protocol", async t => {
  const cases = [
    {
      apiProtocol: "openai-responses",
      expectedPath: "/api/responses",
      response: {
        output_text: "responses answer",
        output: [{ type: "web_search_call", status: "completed" }, { content: [{ annotations: [{ url_citation: { url: "https://sources.test/responses" } }] }] }]
      }
    },
    {
      apiProtocol: "openai-completions",
      expectedPath: "/api/chat/completions",
      response: { choices: [{ message: { content: "chat answer", citations: [{ url: "https://sources.test/chat" }] } }] }
    },
    {
      apiProtocol: "anthropic-messages",
      expectedPath: "/api/messages",
      response: {
        content: [
          { type: "text", text: "messages answer" },
          { type: "web_search_tool_result", content: [{ url: "https://sources.test/messages" }] }
        ]
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.apiProtocol, async () => {
      let observed;
      const { engine, resolvedRefs } = createEngine({
        routes: {
          "provider-a/model-a": {
            provider: "provider-a",
            model: "model-a",
            endpoint: "https://provider-a.test/api",
            apiProtocol: item.apiProtocol,
            credentialRef: "PROVIDER_A_KEY"
          }
        },
        fetchImpl: async (url, options) => {
          observed = { url: new URL(url), options, body: JSON.parse(options.body) };
          return jsonResponse(item.response);
        }
      });
      const result = await engine.search(agent(), { query: "automatic search", maxResults: 1 });
      assert.equal(observed.url.pathname, item.expectedPath);
      const auth = observed.options.headers.authorization ?? observed.options.headers["x-api-key"];
      assert.equal(auth, item.apiProtocol === "anthropic-messages" ? secretA : `Bearer ${secretA}`);
      assert.equal(observed.body.model, "model-a");
      assert.deepEqual(resolvedRefs, ["PROVIDER_A_KEY"]);
      assert.equal(result.sources.length, 1);
    });
  }
});

test("standard protocols inherit the active model route and normalize sources", async t => {
  const cases = [
    {
      protocol: "openai-responses-web-search",
      expectedPath: "/api/responses",
      response: {
        output_text: "responses answer",
        output: [{ type: "web_search_call", status: "completed" }, { content: [{ annotations: [{ url_citation: { url: "https://sources.test/responses", title: "Responses" } }] }] }]
      }
    },
    {
      protocol: "openai-chat-completions-search",
      expectedPath: "/api/chat/completions",
      response: { choices: [{ message: { content: "chat answer", citations: [{ url: "https://sources.test/chat" }] } }] }
    },
    {
      protocol: "anthropic-messages-web-search",
      expectedPath: "/api/messages",
      response: {
        content: [
          { type: "text", text: "messages answer" },
          { type: "web_search_tool_result", content: [{ url: "https://sources.test/messages" }] }
        ]
      }
    },
    {
      protocol: "dsh-web-search-v1",
      expectedPath: "/api/web-search",
      response: { content: "dsh answer", sources: [{ url: "https://sources.test/dsh" }] }
    }
  ];

  for (const item of cases) {
    await t.test(item.protocol, async () => {
      let observed;
      const { engine, resolvedRefs } = createEngine({
        routes: {
          "provider-a/model-a": {
            provider: "provider-a",
            model: "model-a",
            endpoint: "https://provider-a.test/api",
            credentialRef: "PROVIDER_A_KEY",
            webSearch: { protocol: item.protocol, credential: "inherit" }
          }
        },
        fetchImpl: async (url, options) => {
          observed = { url: new URL(url), options, body: JSON.parse(options.body) };
          return jsonResponse(item.response);
        }
      });
      const result = await engine.search(agent(), { query: "harness search", maxResults: 1 });
      assert.equal(observed.url.pathname, item.expectedPath);
      const auth = observed.options.headers.authorization ?? observed.options.headers["x-api-key"];
      assert.equal(auth, item.protocol === "anthropic-messages-web-search" ? secretA : `Bearer ${secretA}`);
      assert.equal(observed.body.model, "model-a");
      assert.deepEqual(resolvedRefs, ["PROVIDER_A_KEY"]);
      assert.equal(result.sources.length, 1);
      assert.match(result.sources[0].url, /^https:\/\/sources\.test\//u);
    });
  }
});

test("MCP discovery calls only the declared tool and keeps one provider session", async () => {
  const calls = [];
  const { engine } = createEngine({
    routes: {
      "provider-a/model-a": {
        provider: "provider-a",
        model: "model-a",
        endpoint: "https://mcp-provider.test/mcp",
        credentialRef: "PROVIDER_A_KEY",
        webSearch: {
          protocol: "mcp-web-search",
          credential: "inherit",
          requestFields: { toolName: "search_docs", safeSearch: true }
        }
      }
    },
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      calls.push({ method: payload.method, headers: options.headers, payload });
      if (payload.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, 200, { "mcp-session-id": "session-a" });
      if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (payload.method === "tools/list") return jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search_docs" }] } });
      return jsonResponse({
        jsonrpc: "2.0",
        id: 3,
        result: { structuredContent: { content: "mcp answer", sources: [{ url: "https://sources.test/mcp" }] } }
      });
    }
  });
  const result = await engine.search(agent(), { query: "MCP search", maxResults: 2 });
  assert.deepEqual(calls.map(item => item.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.equal(calls[2].headers["mcp-session-id"], "session-a");
  assert.equal(calls[3].payload.params.name, "search_docs");
  assert.deepEqual(calls[3].payload.params.arguments, { safeSearch: true, query: "MCP search", maxResults: 2 });
  assert.equal(result.sources[0].url, "https://sources.test/mcp");
});

test("model switches and concurrent sessions never mix endpoints or credentials", async () => {
  const calls = [];
  const route = (provider, model, credentialRef) => ({
    provider,
    model,
    endpoint: `https://${provider}.test/v1`,
    credentialRef,
    webSearch: { protocol: "dsh-web-search-v1", credential: "inherit" }
  });
  const { engine } = createEngine({
    routes: {
      "provider-a/model-a": route("provider-a", "model-a", "PROVIDER_A_KEY"),
      "provider-b/model-b": route("provider-b", "model-b", "PROVIDER_B_KEY")
    },
    fetchImpl: async (url, options) => {
      const current = { host: new URL(url).host, authorization: options.headers.authorization, body: JSON.parse(options.body) };
      calls.push(current);
      return jsonResponse({ sources: [{ url: `https://sources.test/${current.body.model}` }] });
    }
  });
  const [first, second] = await Promise.all([
    engine.search(agent("provider-a", "model-a"), { query: "first" }),
    engine.search(agent("provider-b", "model-b"), { query: "second" })
  ]);
  assert.deepEqual(calls.map(call => [call.host, call.authorization, call.body.model]).sort(), [
    ["provider-a.test", `Bearer ${secretA}`, "model-a"],
    ["provider-b.test", `Bearer ${secretB}`, "model-b"]
  ]);
  assert.equal(first.sources[0].url, "https://sources.test/model-a");
  assert.equal(second.sources[0].url, "https://sources.test/model-b");
});

test("unknown capabilities and protocols fail without blind probes", async () => {
  let fetches = 0;
  const missing = createEngine({
    routes: {},
    fetchImpl: async () => { fetches += 1; return jsonResponse({}); }
  }).engine;
  await assert.rejects(missing.search(agent(), { query: "none" }), error =>
    /does not support automatic web search/u.test(error.message) && !/DEEPSEEK_API_KEY/u.test(error.message));

  const unavailable = createEngine({
    routes: {
      "provider-a/model-a": {
        provider: "provider-a",
        model: "model-a",
        endpoint: "https://provider-a.test/v1",
        credentialRef: "PROVIDER_A_KEY",
        webSearch: { protocol: "custom-search-protocol", credential: "inherit" }
      }
    },
    fetchImpl: async () => { fetches += 1; return jsonResponse({}); }
  }).engine;
  await assert.rejects(unavailable.search(agent(), { query: "unknown" }), /protocol that is unavailable/u);
  assert.equal(fetches, 0);
});

test("credential, endpoint, redirect, cancellation and invalid responses are fail-closed", async t => {
  const route = {
    provider: "provider-a",
    model: "model-a",
    endpoint: "https://provider-a.test/v1",
    credentialRef: "PROVIDER_A_KEY",
    webSearch: { protocol: "dsh-web-search-v1", credential: "inherit" }
  };
  await t.test("missing credential hides reference details", async () => {
    const engine = createEngine({ routes: { "provider-a/model-a": route }, credentials: {}, fetchImpl: async () => jsonResponse({}) }).engine;
    await assert.rejects(engine.search(agent(), { query: "missing" }), error => {
      assert.match(error.message, /credential is not configured/u);
      assert.doesNotMatch(error.message, /PROVIDER_A_KEY|secret/u);
      return true;
    });
  });
  await t.test("untrusted endpoint never reaches fetch", async () => {
    let fetches = 0;
    const engine = createEngine({
      routes: { "provider-a/model-a": { ...route, endpoint: "http://provider-a.test/v1" } },
      fetchImpl: async () => { fetches += 1; return jsonResponse({}); }
    }).engine;
    await assert.rejects(engine.search(agent(), { query: "untrusted" }), /must use HTTPS/u);
    assert.equal(fetches, 0);
  });
  await t.test("redirect body is not reflected", async () => {
    const engine = createEngine({
      routes: { "provider-a/model-a": route },
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, "error");
        return new Response("do-not-reflect-secret", { status: 302, headers: { location: "https://other.test" } });
      }
    }).engine;
    await assert.rejects(engine.search(agent(), { query: "redirect" }), error => {
      assert.match(error.message, /HTTP 302/u);
      assert.doesNotMatch(error.message, /do-not-reflect-secret/u);
      return true;
    });
  });
  await t.test("cancellation, timeout and malformed JSON are explicit", async () => {
    const controller = new AbortController();
    controller.abort();
    const canceled = createEngine({
      routes: { "provider-a/model-a": route },
      fetchImpl: async (_url, options) => {
        options.signal.throwIfAborted();
        return jsonResponse({});
      }
    }).engine;
    await assert.rejects(canceled.search(agent(), { query: "cancel" }, controller.signal), /was canceled/u);
    const timedOut = createEngine({
      routes: { "provider-a/model-a": route },
      timeoutMs: 10,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })
    }).engine;
    await assert.rejects(timedOut.search(agent(), { query: "timeout" }), /timed out/u);
    const malformed = createEngine({
      routes: { "provider-a/model-a": route },
      fetchImpl: async () => new Response("not-json", { status: 200 })
    }).engine;
    await assert.rejects(malformed.search(agent(), { query: "malformed" }), /invalid web search response/u);
  });
});

test("third-party protocols register without vendor branches", async () => {
  const { engine } = createEngine({
    routes: {
      "provider-a/model-a": {
        provider: "provider-a",
        model: "model-a",
        endpoint: "https://provider-a.test/v1",
        credentialRef: "PROVIDER_A_KEY",
        webSearch: { protocol: "partner-search-v1", credential: "inherit" }
      }
    },
    fetchImpl: async () => { throw new Error("custom adapter must own transport"); }
  });
  const dispose = engine.registerProtocol("partner-search-v1", async ({ route, credential, request }) => ({
    content: `${route.model}:${request.query}:${credential.length}`,
    sources: [{ url: "https://sources.test/partner" }]
  }));
  const result = await engine.search(agent(), { query: "extension" });
  assert.equal(result.content, `model-a:extension:${secretA.length}`);
  dispose();
  await assert.rejects(engine.search(agent(), { query: "extension" }), /protocol that is unavailable/u);
});
