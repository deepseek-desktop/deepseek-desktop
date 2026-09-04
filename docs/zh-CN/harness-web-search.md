# 跟随当前模型的联网搜索

Desktop 独立管理 `@deepseek-ai/dsh-web-search-follow-model`，与 Harness 官方的 `@deepseek-ai/dsh-web-search-deepseek` 共存。官方插件的源码、名称、设置界面和配置保持原样，Desktop 不再强制禁用它，也不会覆盖用户手动禁用它的选择。

**启用插件不等于选择搜索 Provider。** Desktop 装配配置以 `web.searchProvider: follow-model` 明确选择独立扩展；官方 Provider 可以同时注册，不会重复注册 `web_search` 工具或产生自动选择歧义。

## 使用

普通用户仍按原流程添加模型提供方、地址、密钥和模型，不需要选择联网搜索协议或重复填写密钥。设置 → 插件中的“联网搜索（跟随模型）”是独立设置卡片，默认显示“跟随当前模型”，也可选择“禁用联网搜索”。保存与恢复默认只修改 `web-search-follow-model` 命名空间，不改写官方卡片。

搜索读取 Harness 公开的当前 Agent 上下文和该会话的实际模型路由。切换模型后，下一次搜索跟随新模型；并发会话不共享端点、模型或凭据快照。凭据通过原有凭据服务按次解析，不复制到新的搜索配置中。

需要单独使用官方或其他搜索 Provider 的高级用户，应通过 Harness 原有 `web.searchProvider` 配置明确选择它。旧扩展配置中的 `independent` 模式会明确提示改用该公开接口，不再调用修改过的 Harness 私有派发方法，也不会静默换服务。

## 自动匹配与边界

通用模型配置由公开的模型提供方目录定位到 `llm-pi-ai` 设置，读取提供方实际配置的地址、API 协议和凭据引用；模型条目中的未知连接字段不会改变搜索端点。

已验证的 DeepSeek 官方端点（`https://api.deepseek.com`、其 `/v1` 路径）及 Alibaba MaaS Token Plan 端点（`https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`）自动使用 Responses 搜索。即使聊天配置选择 Chat Completions，或内置提供方未填写 API 协议，也无需增加搜索配置。匹配依据是准确的端点，不是可编辑的提供方名称；仍使用当前会话模型及其凭据，成功仍需真实搜索证据。

其他显式声明协议的通用提供方按以下规则选择：

| 模型 API | 搜索协议 | 成功所需证据 |
| --- | --- | --- |
| `openai-responses` | Responses `web_search` 工具 | 已完成的 `web_search_call` |
| `openai-completions` | Chat Completions `web_search_options` | 结构化 HTTP(S) 引用来源 |
| `anthropic-messages` | Messages 原生搜索工具 | 非错误的 `web_search_tool_result` |

自动匹配只是选择请求协议，不保证任意兼容服务都支持联网搜索。忽略搜索参数、只返回普通模型回答或返回搜索工具错误时，会明确失败，不会把回答当作实时搜索结果，也不会改用其他提供方。

Responses 使用 `web_search` 与自动工具选择，避免强制选择与思考模型冲突；搜索成功仍必须具有已完成的服务端搜索调用。来源从结构化引用、搜索动作的 `sources` 以及已完成的打开/查找页面动作提取，不从普通回答中猜测来源。对应协议说明：[DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)、[百炼 Responses](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)。

原生 DeepSeek 模型使用上游公开的 `resolveAdapterOptions` 和启动环境快照解析当前模型凭据。只有该适配器的标准官方连接使用已审计的 `/anthropic/v1` 搜索端点；改变原生连接地址后不会套用厂商搜索能力。自定义兼容服务应按正常流程使用通用模型提供方。未公开标准连接信息、仅支持 OAuth 或使用未知 API 的路由会明确提示不可自动跟随，不盲目探测。

Provider 请求最长 90 秒，外层工具预算 100 秒。取消、超时、不支持搜索和缺少凭据分别反馈；失败不改变当前对话模型。

## 扩展接口

受信任扩展可通过独立插件的 `webSearchProtocols.registerRouteResolver(resolver)` 注册精确路由，再通过 `webSearchProtocols.registerProtocol(protocolId, adapter)` 注册协议执行器，不需要修改 Harness 核心。路由必须与当前会话的 Provider 和模型完全匹配，不能跨提供方回退。

内置协议还包括 `mcp-web-search` 和 `dsh-web-search-v1`。显式路由中的 `webSearch` 可以声明协议、`credential: inherit`、同端点路径及少量短标量扩展字段；不能覆盖模型、查询、工具或凭据保留字段。普通模型提供方表单不暴露这些高级实现细节。

## Harness 更新

扩展的版本、主入口 `index.js`、浏览器入口 `client.js`、公开设置插槽注册和依赖均随 Desktop 自有包交付。源码构建和仓库更新继续使用同一套生产闭包装配逻辑。更新覆盖的是候选目录里的 Desktop 扩展，不是官方插件或用户设置。

候选装配检查扩展前后端文件和声明的 Harness 依赖；启动时检查公开 Agent、模型目录与搜索注册接口，再通过现有候选 smoke 和原子切换流程激活。准备或启动失败保留当前可用 Harness、会话与设置。已验证的上游版本不代表未知未来接口永远兼容；不兼容必须先适配并重新验证。

## 安全

- 凭据只发送到当前模型已配置的 HTTPS 端点；仅本机 loopback 开发地址允许 HTTP。
- HTTP 重定向被拒绝，不自动切换搜索服务，不盲试不同协议。
- 模型的工具参数不能改变内部 Provider、端点、模型或凭据。
- 来源只保留 HTTP(S) URL，并去重、归一化；响应有大小上限。
- 测试的协议响应可以使用模拟服务，但不能据此宣称某个真实模型供应商已验收。
