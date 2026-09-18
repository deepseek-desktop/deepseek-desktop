# ADR-023：本机端点的联网搜索能力按探测发现

## 状态

已采用。扩展 [ADR-017](adr-017-independent-search-coexistence.md) 的「搜索能力属于端点」原则，不改变其余决策。

## 背景

`endpointSearchCapability()` 用一张硬编码 origin 白名单（DeepSeek 官方、Alibaba MaaS）判断端点是否自带搜索能力。本机推理服务不在其中，于是「跟随当前模型」对它们只能落到从聊天协议推断的 `openai-responses-web-search`，向 `{baseURL}/responses` 发带 `tools:[{type:"web_search"}]` 的请求。

实测 oMLX 0.6.4：该内置工具不被执行 —— 其 OpenAPI 对 Anthropic 服务端工具写明 “oMLX cannot execute these locally … dropped before inference”，而 `/v1/responses` 实测返回里没有 `web_search_call`，模型自答「I don't have a web search」。但它**另有**一个可用的搜索端点 `POST /v1/web/search`（`{"query"}` → `{"ok","provider","results":[{title,url,snippet}]}`，实测由 ddgs 提供，无需密钥）。

联网搜索插件的核心价值是零配置即可用，因此不能要求用户去填端点地址；把这类端点加进产品名白名单同样不可持续。

## 决策

- 对 loopback 端点做一次能力探测：`HEAD {origin}/v1/web/search`，返回 404 以外即判定该路由存在，声明 `{ protocol: "plain-web-search", credential: "none", endpointPath: "/v1/web/search" }`。
- 探测的是**端点形状**而非产品身份。任何提供同样接口的本机服务都自动获得该能力，不维护型号白名单。
- 只探测 loopback。第三方端点绝不接收用户未请求的流量。
- 结果按 origin 缓存：命中 5 分钟，未命中或探测异常 30 秒（服务可能仍在启动，不能长期写死为不支持）。
- 新增 `plain-web-search` 协议：端点即完整搜索 URL，POST `{query}`，来源从 `results` / `sources` / `citations` / `search_results` 任一数组读取；`ok === false` 或零来源判为未执行搜索。
- 新增 `credential: "none"` 能力策略。免密钥端点不再被强制的非空凭据校验挡下，声明后完全不触碰凭据平面。
- 白名单声明优先于探测；探测只填补白名单留下的空缺。

## 理由与边界

`HEAD` 是最省的存在性判定：不执行搜索、不加载模型、不消耗 token，且 405（方法不允许）与 404（路由不存在）足以区分。相比之下，`GET /v1/models` 之类的指纹识别既要匹配厂商字段，又答不出我们真正关心的问题。

失败一律退回「无搜索能力」，与既有行为一致，绝不阻塞对话。缓存使 `resolveRoute()` 的每次搜索不必重复往返。

本决策不声称任何本机服务的搜索质量或可用性已验收，也不改变云端端点的既有路由。`/v1/web/search` 的路径取自 oMLX 的实现，其他形状的本机搜索接口仍需由受信任扩展通过 `registerRouteResolver` / `registerProtocol` 显式声明。
