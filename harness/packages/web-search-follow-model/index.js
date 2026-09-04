import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";

const PROVIDER_ID = "follow-model";
const DEFAULT_TIMEOUT_MS = 55_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_FIELDS = 16;
const PROTOCOL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const REQUEST_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const DEFAULT_PROTOCOL_BY_MODEL_API = new Map([
  ["openai-responses", "openai-responses-web-search"],
  ["openai-completions", "openai-chat-completions-search"],
  ["anthropic-messages", "anthropic-messages-web-search"],
]);

const messages = {
  "en-US": {
    routeMissing: "The current model route is unavailable, so web search cannot follow it.",
    capabilityMissing: "The current model API protocol does not support automatic web search. Normal chat remains available.",
    protocolUnavailable: "The current model Provider declares a web search protocol that is unavailable in this Harness.",
    credentialMissing: "The current model Provider credential is not configured. Save that Provider's API key in Models settings.",
    requestCanceled: "The current model Provider web search request was canceled. Normal chat remains available.",
    requestTimedOut: "The current model Provider web search request timed out. Do not retry it automatically in this turn; normal chat remains available.",
    requestFailed: "The current model Provider web search request failed.",
    responseInvalid: "The current model Provider returned an invalid web search response.",
    searchNotPerformed: "The Provider did not return evidence of web search. Its model answer is not a search result.",
    searchDisabled: "Web search is disabled in Desktop settings. Normal chat and web fetch remain available.",
  },
  "zh-CN": {
    routeMissing: "当前会话没有可用的模型路由，无法跟随当前模型联网搜索。",
    capabilityMissing: "当前模型的 API 协议暂不支持自动联网搜索，正常对话仍可继续。",
    protocolUnavailable: "当前模型提供方声明的联网搜索协议在此 Harness 中不可用。",
    credentialMissing: "当前模型提供方的凭据尚未配置，请在模型设置中保存该提供方的 API 密钥。",
    requestCanceled: "当前模型提供方的联网搜索请求已取消，正常对话仍可继续。",
    requestTimedOut: "当前模型提供方的联网搜索请求超时。本轮不要自动重试，正常对话仍可继续。",
    requestFailed: "当前模型提供方的联网搜索请求失败。",
    responseInvalid: "当前模型提供方返回了无法解析的联网搜索结果。",
    searchNotPerformed: "提供方未返回联网搜索执行证据，不能将普通模型回答作为搜索结果。",
    searchDisabled: "已在桌面版设置中禁用联网搜索，正常对话和网页抓取仍可继续。",
  },
  "zh-TW": {
    routeMissing: "目前工作階段沒有可用的模型路由，無法跟隨目前模型進行聯網搜尋。",
    capabilityMissing: "目前模型的 API 協定暫不支援自動聯網搜尋，正常對話仍可繼續。",
    protocolUnavailable: "目前模型提供方宣告的聯網搜尋協定在此 Harness 中無法使用。",
    credentialMissing: "目前模型提供方的憑據尚未設定，請在模型設定中儲存該提供方的 API 金鑰。",
    requestCanceled: "目前模型提供方的聯網搜尋請求已取消，正常對話仍可繼續。",
    requestTimedOut: "目前模型提供方的聯網搜尋請求逾時。本輪請勿自動重試，正常對話仍可繼續。",
    requestFailed: "目前模型提供方的聯網搜尋請求失敗。",
    responseInvalid: "目前模型提供方傳回了無法解析的聯網搜尋結果。",
    searchNotPerformed: "提供方未傳回聯網搜尋執行證據，不能將一般模型回答作為搜尋結果。",
    searchDisabled: "已在桌面版設定中停用聯網搜尋，一般對話和網頁擷取仍可繼續。",
  },
};

const requestFieldValue = z.union([z.string(), z.number(), z.boolean()]);
const capabilitySchema = z.object({
  protocol: z.string().required(),
  credential: z.union(["inherit"]).default("inherit"),
  endpointPath: z.string(),
  requestFields: z.dict(requestFieldValue),
});

export const WEB_SEARCH_CAPABILITY_SCHEMA = capabilitySchema;

function fail(message, code, cause) {
  throw new WebError(message, code, cause === undefined ? undefined : { cause });
}

function locale() {
  const value = process.env.DEEPSEEK_DESKTOP_LOCALE;
  if (value?.toLowerCase().startsWith("zh-tw") || value?.toLowerCase().startsWith("zh-hk")) return "zh-TW";
  if (value?.toLowerCase().startsWith("zh")) return "zh-CN";
  return "en-US";
}

function copy(key) {
  return messages[locale()][key];
}

function activeRoute(agent) {
  const current = agent?.session?.requestHeader?.()?.config;
  const provider = current?.provider ?? agent?.options?.provider;
  const model = current?.model ?? agent?.options?.model;
  if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0) {
    fail(copy("routeMissing"), "WEB_FOLLOW_MODEL_ROUTE_MISSING");
  }
  return { provider, model };
}

function endpointUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    fail("The current Provider declares an invalid web search endpoint.", "WEB_FOLLOW_MODEL_ENDPOINT_INVALID", error);
  }
  if (url.username || url.password || url.hash) {
    fail("The current Provider web search endpoint contains disallowed URL components.", "WEB_FOLLOW_MODEL_ENDPOINT_INVALID");
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    fail("The current Provider web search endpoint must use HTTPS, except for loopback development endpoints.", "WEB_FOLLOW_MODEL_ENDPOINT_UNTRUSTED");
  }
  return url;
}

function requestUrl(base, suffix) {
  const url = endpointUrl(base);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url;
}

function capabilityEndpoint(base, endpointPath) {
  const endpoint = endpointUrl(base);
  if (endpointPath === undefined) return endpoint.href.replace(/\/+$/u, "");
  if (typeof endpointPath !== "string" || !endpointPath.startsWith("/") || endpointPath.includes("\\")) {
    fail("The web search capability declares an invalid endpoint path.", "WEB_FOLLOW_MODEL_CAPABILITY_INVALID");
  }
  endpoint.pathname = endpointPath;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.href.replace(/\/+$/u, "");
}

function safeSource(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value;
  if (typeof raw.url !== "string") return undefined;
  let url;
  try {
    url = new URL(raw.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return {
    url: url.href,
    ...typeof raw.title === "string" && raw.title.length > 0 ? { title: raw.title } : {},
    ...typeof raw.snippet === "string" && raw.snippet.length > 0 ? { snippet: raw.snippet } : {},
    ...typeof raw.publishedAt === "string" && raw.publishedAt.length > 0 ? { publishedAt: raw.publishedAt } : {},
  };
}

function uniqueSources(values) {
  const seen = new Set();
  const sources = [];
  for (const value of values) {
    const source = safeSource(value);
    if (source === undefined || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }
  return sources;
}

function constrainedFields(fields, reserved) {
  if (fields === undefined) return {};
  const entries = Object.entries(fields);
  if (entries.length > MAX_REQUEST_FIELDS) {
    fail(`The web search capability declares more than ${MAX_REQUEST_FIELDS} request extension fields.`, "WEB_FOLLOW_MODEL_CAPABILITY_INVALID");
  }
  const result = {};
  for (const [key, value] of entries) {
    if (!REQUEST_FIELD.test(key) || reserved.has(key)) {
      fail(`The web search capability declares disallowed request field "${key}".`, "WEB_FOLLOW_MODEL_CAPABILITY_INVALID");
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      fail(`The web search capability request field "${key}" is not a scalar.`, "WEB_FOLLOW_MODEL_CAPABILITY_INVALID");
    }
    if (typeof value === "string" && value.length > 1024) {
      fail(`The web search capability request field "${key}" is too long.`, "WEB_FOLLOW_MODEL_CAPABILITY_INVALID");
    }
    result[key] = value;
  }
  return result;
}

function responseText(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    fail("The web search response exceeded the safe size limit.", "WEB_FOLLOW_MODEL_RESPONSE_TOO_LARGE");
  }
  return response.text().then((text) => {
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      fail("The web search response exceeded the safe size limit.", "WEB_FOLLOW_MODEL_RESPONSE_TOO_LARGE");
    }
    return text;
  });
}

async function postJsonResponse(url, body, headers, signal, fetchImpl = fetch, allowEmpty = false, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: combined,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (timeout.aborted) fail(copy("requestTimedOut"), "WEB_FOLLOW_MODEL_TIMED_OUT", error);
    if (signal?.aborted || combined.aborted) fail(copy("requestCanceled"), "WEB_FOLLOW_MODEL_CANCELED", error);
    fail(copy("requestFailed"), "WEB_FOLLOW_MODEL_REQUEST_FAILED", error);
  }
  const text = await responseText(response);
  if (!response.ok) {
    fail(`The current Provider web search request failed with HTTP ${response.status}.`, "WEB_FOLLOW_MODEL_REQUEST_FAILED");
  }
  if (allowEmpty && text.length === 0) return { response, payload: undefined };
  try {
    return { response, payload: JSON.parse(text) };
  } catch (error) {
    fail(copy("responseInvalid"), "WEB_FOLLOW_MODEL_RESPONSE_INVALID", error);
  }
}

async function postJson(url, body, headers, signal, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return (await postJsonResponse(url, body, headers, signal, fetchImpl, false, timeoutMs)).payload;
}

function textContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (typeof item === "object" && item !== null && typeof item.text === "string") return [item.text];
      return [];
    }).join("\n");
  }
  return undefined;
}

function responseAnnotations(output) {
  const sources = [];
  for (const item of Array.isArray(output) ? output : []) {
    if (item?.type === "web_search_call" && item.status === "completed") {
      if (Array.isArray(item.action?.sources)) sources.push(...item.action.sources);
      if (["open_page", "find_in_page"].includes(item.action?.type) && typeof item.action.url === "string") {
        sources.push({ url: item.action.url });
      }
    }
    for (const block of Array.isArray(item?.content) ? item.content : []) {
      for (const annotation of Array.isArray(block?.annotations) ? block.annotations : []) {
        const citation = annotation?.url_citation ?? annotation;
        if (typeof citation?.url === "string") {
          sources.push({ url: citation.url, title: citation.title });
        }
      }
    }
  }
  return sources;
}

function genericSources(payload) {
  const candidates = [payload?.sources, payload?.citations, payload?.search_results, payload?.searchResults];
  const sources = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (typeof item === "string") sources.push({ url: item });
      else if (typeof item === "object" && item !== null) {
        sources.push({
          url: item.url ?? item.link,
          title: item.title ?? item.name,
          snippet: item.snippet ?? item.description ?? item.text,
          publishedAt: item.publishedAt ?? item.published_at ?? item.date,
        });
      }
    }
  }
  return sources;
}

function normalizedResult(content, sources, maxResults) {
  const normalized = uniqueSources(sources);
  const limited = maxResults === undefined ? normalized : normalized.slice(0, maxResults);
  return {
    ...typeof content === "string" && content.length > 0 ? { content } : {},
    sources: limited,
    truncated: limited.length < normalized.length,
  };
}

function bearerHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}` };
}

function mcpHeaders(credential, sessionId) {
  return {
    ...bearerHeaders(credential),
    accept: "application/json, text/event-stream",
    ...sessionId === undefined ? {} : { "mcp-session-id": sessionId },
  };
}

function mcpResult(payload, maxResults) {
  if (payload?.error !== undefined) fail(copy("requestFailed"), "WEB_FOLLOW_MODEL_REQUEST_FAILED");
  const result = payload?.result;
  if (result?.isError) fail(copy("requestFailed"), "WEB_FOLLOW_MODEL_REQUEST_FAILED");
  const structured = result?.structuredContent;
  const text = textContent(result?.content);
  let decoded;
  if (structured === undefined && typeof text === "string") {
    try { decoded = JSON.parse(text); } catch {}
  }
  const body = structured ?? decoded ?? result ?? {};
  return normalizedResult(body.content ?? (decoded === undefined ? text : undefined), genericSources(body), maxResults);
}

function builtInProtocols(fetchImpl, timeoutMs) {
  const requestJson = (url, body, headers, signal) => postJson(url, body, headers, signal, fetchImpl, timeoutMs);
  const requestJsonResponse = (url, body, headers, signal, allowEmpty = false) =>
    postJsonResponse(url, body, headers, signal, fetchImpl, allowEmpty, timeoutMs);
  return new Map([
    ["openai-responses-web-search", async ({ route, capability, credential, request, signal }) => {
      const payload = await requestJson(requestUrl(route.endpoint, "/responses"), {
        ...constrainedFields(capability.requestFields, new Set(["model", "input", "tools", "tool_choice"])),
        model: route.model,
        input: `Use the web search tool to search for the following query and cite the sources. Do not answer from memory.\n\n${request.query}`,
        tools: [{ type: "web_search" }],
        // Thinking models may reject forced tool choice; execution evidence below is mandatory.
        tool_choice: "auto",
      }, bearerHeaders(credential), signal);
      if (!payload.output?.some?.(item => item?.type === "web_search_call" && item.status === "completed")) {
        fail(copy("searchNotPerformed"), "WEB_FOLLOW_MODEL_SEARCH_NOT_PERFORMED");
      }
      const content = typeof payload.output_text === "string"
        ? payload.output_text
        : textContent(payload.output?.flatMap?.((item) => item?.content ?? []));
      return normalizedResult(content, [...responseAnnotations(payload.output), ...genericSources(payload)], request.maxResults);
    }],
    ["openai-chat-completions-search", async ({ route, capability, credential, request, signal }) => {
      const payload = await requestJson(requestUrl(route.endpoint, "/chat/completions"), {
        ...constrainedFields(capability.requestFields, new Set(["model", "messages", "stream", "web_search_options"])),
        model: route.model,
        messages: [{ role: "user", content: request.query }],
        stream: false,
        web_search_options: {},
      }, bearerHeaders(credential), signal);
      const message = payload?.choices?.[0]?.message;
      const sources = [
        ...responseAnnotations([{ content: [message] }]),
        ...genericSources(message),
        ...genericSources(payload),
      ];
      if (uniqueSources(sources).length === 0) fail(copy("searchNotPerformed"), "WEB_FOLLOW_MODEL_SEARCH_NOT_PERFORMED");
      return normalizedResult(textContent(message?.content), sources, request.maxResults);
    }],
    ["anthropic-messages-web-search", async ({ route, capability, credential, request, signal }) => {
      const payload = await requestJson(requestUrl(route.endpoint, "/messages"), {
        ...constrainedFields(capability.requestFields, new Set(["model", "messages", "tools", "max_tokens"])),
        model: route.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: request.query }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }, { "x-api-key": credential, "anthropic-version": "2023-06-01" }, signal);
      const blocks = Array.isArray(payload?.content) ? payload.content : [];
      if (!blocks.some(block => block?.type === "web_search_tool_result" && Array.isArray(block.content))) {
        fail(copy("searchNotPerformed"), "WEB_FOLLOW_MODEL_SEARCH_NOT_PERFORMED");
      }
      const sources = [];
      for (const block of blocks) {
        if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) sources.push(...block.content);
        if (Array.isArray(block?.citations)) sources.push(...block.citations);
      }
      return normalizedResult(textContent(blocks), [...sources, ...genericSources(payload)], request.maxResults);
    }],
    ["dsh-web-search-v1", async ({ route, capability, credential, request, signal }) => {
      const payload = await requestJson(requestUrl(route.endpoint, "/web-search"), {
        ...constrainedFields(capability.requestFields, new Set(["query", "maxResults", "model"])),
        query: request.query,
        ...request.maxResults === undefined ? {} : { maxResults: request.maxResults },
        model: route.model,
      }, bearerHeaders(credential), signal);
      return normalizedResult(payload?.content, payload?.sources ?? [], request.maxResults);
    }],
    ["mcp-web-search", async ({ route, capability, credential, request, signal }) => {
      const endpoint = endpointUrl(route.endpoint);
      const initialize = await requestJsonResponse(endpoint, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "dsh-web-search-follow-model", version: "1.0.0" },
        },
      }, mcpHeaders(credential), signal);
      const sessionId = initialize.response.headers.get("mcp-session-id") ?? undefined;
      await requestJsonResponse(endpoint, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }, mcpHeaders(credential, sessionId), signal, true);
      const listed = await requestJson(endpoint, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }, mcpHeaders(credential, sessionId), signal);
      const configuredName = capability.requestFields?.toolName;
      const toolName = typeof configuredName === "string" && configuredName.length > 0 ? configuredName : "web_search";
      if (!listed?.result?.tools?.some?.((tool) => tool?.name === toolName)) {
        fail(`The MCP endpoint does not advertise the declared web search tool "${toolName}".`, "WEB_FOLLOW_MODEL_CAPABILITY_MISSING");
      }
      const { toolName: _toolName, ...declaredFields } = capability.requestFields ?? {};
      const extension = constrainedFields(declaredFields, new Set(["query", "maxResults"]));
      const called = await requestJson(endpoint, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: {
            ...extension,
            query: request.query,
            ...request.maxResults === undefined ? {} : { maxResults: request.maxResults },
          },
        },
      }, mcpHeaders(credential, sessionId), signal);
      return mcpResult(called, request.maxResults);
    }],
  ]);
}

export class FollowModelSearchEngine {
  constructor(options = {}) {
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.resolveCredential = options.resolveCredential;
    this.resolveDeclaredRoute = options.resolveDeclaredRoute;
    this.protocols = builtInProtocols(this.fetch, this.timeoutMs);
    this.routeResolvers = new Set();
  }

  registerProtocol(id, adapter) {
    if (!PROTOCOL_ID.test(id)) fail(`Invalid web search protocol id "${id}".`, "WEB_FOLLOW_MODEL_PROTOCOL_INVALID");
    if (this.protocols.has(id)) fail(`Web search protocol "${id}" is already registered.`, "WEB_FOLLOW_MODEL_PROTOCOL_DUPLICATE");
    if (typeof adapter !== "function") fail(`Web search protocol "${id}" has no adapter.`, "WEB_FOLLOW_MODEL_PROTOCOL_INVALID");
    this.protocols.set(id, adapter);
    return () => this.protocols.delete(id);
  }

  registerRouteResolver(resolver) {
    if (typeof resolver !== "function") fail("A web search route resolver must be a function.", "WEB_FOLLOW_MODEL_ROUTE_RESOLVER_INVALID");
    this.routeResolvers.add(resolver);
    return () => this.routeResolvers.delete(resolver);
  }

  async resolveRoute(agent) {
    const selection = activeRoute(agent);
    const matches = [];
    for (const resolver of this.routeResolvers) {
      const match = await resolver(selection);
      if (match !== undefined && match !== null) matches.push(match);
    }
    if (matches.length === 0 && this.resolveDeclaredRoute) {
      matches.push(...await this.resolveDeclaredRoute(selection));
    }
    if (matches.length === 0) {
      fail(copy("capabilityMissing"), "WEB_FOLLOW_MODEL_CAPABILITY_MISSING");
    }
    if (matches.length > 1) {
      fail(`Multiple model adapters claimed Provider route "${selection.provider}".`, "WEB_FOLLOW_MODEL_ROUTE_AMBIGUOUS");
    }
    const route = matches[0];
    if (route.provider !== selection.provider || route.model !== selection.model) {
      fail("The model adapter returned a web search route for a different Provider or model.", "WEB_FOLLOW_MODEL_ROUTE_MISMATCH");
    }
    const inferredProtocol = DEFAULT_PROTOCOL_BY_MODEL_API.get(route.apiProtocol);
    if (route.webSearch === false) fail(copy("capabilityMissing"), "WEB_FOLLOW_MODEL_CAPABILITY_MISSING");
    const capability = route.webSearch ?? (inferredProtocol === undefined ? undefined : {
      protocol: inferredProtocol,
      credential: "inherit",
    });
    if (typeof route.endpoint !== "string" || route.endpoint.length === 0 || typeof capability?.protocol !== "string") {
      fail(`The current Provider "${selection.provider}" has an invalid web search capability declaration.`, "WEB_FOLLOW_MODEL_CAPABILITY_INVALID");
    }
    if ((capability.credential ?? "inherit") !== "inherit") {
      fail("The current Provider web search capability uses an unsupported credential policy.", "WEB_FOLLOW_MODEL_CAPABILITY_INVALID");
    }
    return {
      route: { ...route, endpoint: capabilityEndpoint(route.endpoint, capability.endpointPath) },
      capability,
    };
  }

  async search(agent, request, signal) {
    const { route, capability } = await this.resolveRoute(agent);
    const adapter = this.protocols.get(capability.protocol);
    if (adapter === undefined) {
      fail(copy("protocolUnavailable"), "WEB_FOLLOW_MODEL_PROTOCOL_UNAVAILABLE");
    }
    if (typeof route.credentialRef !== "string" || route.credentialRef.length === 0) {
      fail(copy("credentialMissing"), "WEB_FOLLOW_MODEL_CREDENTIAL_MISSING");
    }
    let credential;
    try {
      credential = await this.resolveCredential(credentialRef(route.credentialRef));
    } catch (error) {
      fail(copy("credentialMissing"), "WEB_FOLLOW_MODEL_CREDENTIAL_MISSING", error);
    }
    if (typeof credential !== "string" || credential.length === 0) {
      fail(copy("credentialMissing"), "WEB_FOLLOW_MODEL_CREDENTIAL_MISSING");
    }
    return adapter({ route, capability, credential, request, signal });
  }
}

function endpointSearchCapability(endpoint) {
  const url = endpointUrl(endpoint);
  const path = url.pathname.replace(/\/+$/u, "");
  // Search capability belongs to the endpoint, not the editable Provider id or its chat API.
  if (url.origin === "https://api.deepseek.com" && (path === "" || path === "/v1")) {
    return { protocol: "openai-responses-web-search", credential: "inherit" };
  }
  if (url.origin === "https://token-plan.cn-beijing.maas.aliyuncs.com" && path === "/compatible-mode/v1") {
    return { protocol: "openai-responses-web-search", credential: "inherit" };
  }
  return undefined;
}

export function declaredSearchRoutes(sections, selection) {
  return sections.flatMap(section => {
    const provider = section.value?.providers?.[selection.provider];
    if (!provider || typeof provider.baseURL !== "string" || typeof provider.apiKeyEnv !== "string") return [];
    const apiProtocol = provider.api;
    const webSearch = provider.capabilities?.webSearch ?? provider.webSearch ?? endpointSearchCapability(provider.baseURL);
    if (typeof apiProtocol !== "string" && webSearch === undefined) return [];
    return [{
      ...selection,
      endpoint: provider.baseURL,
      credentialRef: provider.apiKeyEnv,
      apiProtocol,
      webSearch,
    }];
  });
}

export async function resolveConfiguredRoutes(ctx, selection) {
  const llm = ctx.get("llm");
  if (!llm.listProviders().some(provider => provider.id === selection.provider)) return [];
  const addresses = llm.listConfigurableProviders().filter(entry => entry.provider === selection.provider);
  const sections = ctx.settings.describe();
  const matches = [];
  for (const address of addresses) {
    const section = sections.find(item => item.ns === address.settingsNs);
    if (!section) continue;
    if (address.settingsNs === "llm-deepseek" && selection.provider === "deepseek-official") {
      // Resolve the same launch snapshot as the model adapter, never the search plugin's credentials.
      const { resolveAdapterOptions } = await import("@deepseek-ai/dsh-llm-deepseek");
      const { launchEnvironmentOf } = await import("@deepseek-ai/dsh-launch-environment");
      const connection = resolveAdapterOptions(section.value, launchEnvironmentOf(ctx));
      const endpoint = endpointUrl(connection.baseURL);
      if (endpoint.origin !== "https://api.deepseek.com" || !["", "/v1"].includes(endpoint.pathname.replace(/\/+$/u, ""))) continue;
      matches.push({ ...selection, endpoint: connection.baseURL, credentialRef: connection.apiKeyEnv,
        webSearch: { protocol: "anthropic-messages-web-search", credential: "inherit", endpointPath: "/anthropic/v1" } });
    } else if (address.settingsNs === "llm-pi-ai") {
      matches.push(...declaredSearchRoutes([section], selection));
    }
  }
  return matches;
}

export default class FollowModelWebSearch extends Service {
  static inject = ["web", "agents", "credentials", "llm", "settings", "webSearchSelection"];

  constructor(ctx) {
    super(ctx, "webSearchProtocols");
    for (const [service, method] of [["agents", "currentInitiator"], ["llm", "listConfigurableProviders"], ["web", "registerSearchProvider"]]) {
      if (typeof ctx.get(service)?.[method] !== "function") {
        fail(`Harness extension API is incompatible: ${service}.${method}`, "WEB_FOLLOW_MODEL_HARNESS_INCOMPATIBLE");
      }
    }
    this.engine = new FollowModelSearchEngine({
      resolveCredential: async (ref) => (await ctx.get("credentials")?.resolve(ref))?.value,
      resolveDeclaredRoute: selection => resolveConfiguredRoutes(ctx, selection),
    });
    ctx.web.registerSearchProvider({
      id: PROVIDER_ID,
      available: () => true,
      search: async (request, signal) => {
        if (!ctx.webSearchSelection.searchEnabled) {
          fail(copy("searchDisabled"), "WEB_FOLLOW_MODEL_DISABLED");
        }
        return this.engine.search(ctx.agents.currentInitiator(), request, signal);
      },
    });
  }

  registerProtocol(id, adapter) {
    return this.engine.registerProtocol(id, adapter);
  }

  registerRouteResolver(resolver) {
    return this.engine.registerRouteResolver(resolver);
  }
}

export { PROVIDER_ID };
