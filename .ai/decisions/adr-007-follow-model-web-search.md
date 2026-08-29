# ADR-007：联网搜索跟随当前模型 Provider

## 状态

已采用。

## 决策

Harness Runtime 内置并默认启用 `@deepseek-ai/dsh-web-search-follow-model`。`web_search` 每次从内部 Agent 执行上下文解析当前会话实际模型路由，再依据 Provider 的 `capabilities.webSearch` 声明选择协议执行器，继承该 Provider 的 endpoint、model 和 `CredentialRef`，最后归一化为 Provider 无关的搜索结果。

核心路由不识别厂商名称、域名或 Provider ID。未知 Provider 不盲目发送探测请求；明确不支持、未声明能力、凭据缺失和协议不可用分别失败。搜索失败不改变模型会话和正常对话能力。

首批内置协议为 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages、MCP 和 DSH Web Search v1。受信任插件可通过 `webSearchProtocols` 服务注册额外协议执行器，但声明式扩展字段只允许受约束的短标量值，不能成为任意代码或表达式入口。

## 理由

- 用户只维护一份模型 Provider 配置和凭据，切换模型后搜索行为自然同步。
- 协议与能力比厂商身份更稳定，兼容标准实现和自定义网关。
- 不盲探测可以避免重复计费、数据泄漏和不可预测的副作用。
- `CredentialRef` 保持凭据生命周期与现有凭据服务一致，不新增搜索专用明文存储。
- Desktop 继续只负责 Runtime 打包、启动、更新和安全边界，不承担业务协议。

## 约束

- 内部模型路由上下文不得暴露为模型可控工具参数。
- 凭据不得跨 Provider 降级发送，传输端点必须使用 HTTPS，loopback 开发环境除外；重定向默认拒绝。
- 自定义 Provider 没有显式能力声明时不得继承内置 Provider 的默认能力。
- 厂商特定兼容逻辑只能位于对应 Provider 适配器或独立协议插件，不得进入核心 follow-model 路由。
- Provider 和协议开发说明必须与 `docs/zh-CN/runtime-web-search.md` 保持一致。
