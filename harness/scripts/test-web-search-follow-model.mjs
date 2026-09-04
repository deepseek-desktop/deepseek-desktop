import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const desktopRoot = resolve(import.meta.dirname, "..", "..");
const preparedRoot = resolve(desktopRoot, "target/generated/harness/prepared");
const moduleUrl = pathToFileURL(resolve(
  preparedRoot,
  "node_modules/@deepseek-ai/dsh-web-search-follow-model/index.js"
)).href;
const { FollowModelSearchEngine } = await import(moduleUrl);
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

test("prepared Harness carries the extended outer budget without a duplicate Provider search control", async () => {
  const [bundle, modelsSettingsUi, pluginsSettingsUi] = await Promise.all([
    readFile(resolve(preparedRoot, "node_modules/deepseek-desktop-bundle/cordis.patch.yml"), "utf8"),
    readFile(resolve(preparedRoot, "node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js"), "utf8"),
    readFile(resolve(preparedRoot, "node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js"), "utf8")
  ]);
  assert.match(bundle, /searchTimeoutMs:\s*100000/u);
  assert.doesNotMatch(modelsSettingsUi, /webSearchProtocol|WEB_SEARCH_PROTOCOLS/u);
  assert.match(pluginsSettingsUi, /webSearchModeFollowModel:\s*"Follow current model"/u);
  assert.match(pluginsSettingsUi, /webSearchModeFollowModel:\s*"跟随当前模型"/u);
  assert.match(pluginsSettingsUi, /webSearchModeFollowModel:\s*"跟隨目前模型"/u);
  assert.doesNotMatch(pluginsSettingsUi, /current model \(default\)|当前模型（默认）|目前模型（預設）/u);
});

test("unset search capability automatically follows the active model API protocol", async t => {
  const cases = [
    {
      apiProtocol: "openai-responses",
      expectedPath: "/api/responses",
      response: {
        output_text: "responses answer",
        output: [{ content: [{ annotations: [{ url_citation: { url: "https://sources.test/responses" } }] }] }]
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
        output: [{ content: [{ annotations: [{ url_citation: { url: "https://sources.test/responses", title: "Responses" } }] }] }]
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
