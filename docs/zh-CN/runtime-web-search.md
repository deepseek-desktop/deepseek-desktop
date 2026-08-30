# 跟随当前模型的联网搜索

DeepSeek Desktop 内置的 Harness Runtime 默认启用“跟随当前模型”联网搜索。普通用户只需要按现有方式配置模型 Provider、API 地址、密钥和模型，不需要在 Provider 表单中选择联网搜索协议；模型调用 `web_search` 时，Runtime 会读取当前会话实际使用的 Provider，自动匹配标准搜索协议，并复用它的地址、模型和凭据引用。

切换会话模型后，下一次搜索会立即跟随新的 Provider。搜索失败只会结束本次工具调用，不影响继续使用当前模型对话。

模型 Provider 的单次搜索请求最长等待 90 秒，外层 `web_search` 工具保留 100 秒总预算，用于覆盖第三方兼容接口的模型推理与联网检索耗时。用户主动取消与请求超时会显示不同提示；发生超时后，本轮不会建议模型自动连续重试，用户可以继续正常对话或稍后重新搜索。

## 能力边界

联网搜索不会根据 Provider 名称、域名或厂商身份猜测协议。Runtime 按以下顺序确定能力：

- Provider 或配置文件显式声明的搜索能力，作为高级覆盖；
- 当前模型 API 协议对应的内置标准映射；
- 标准协议能力发现；
- MCP `tools/list` 返回的工具；
- 经过完整性验证的兼容性元数据。

完全未知的自定义 API 不会被连续发送不同请求来试探能力。这样可以避免重复计费、意外泄漏查询内容或把凭据发送到错误服务。无法自动匹配时会给出明确提示；用户仍可正常对话。

设置页提供三种模式：

- **跟随当前模型**：默认模式，继承当前 Provider 的搜索能力和凭据引用；
- **禁用联网搜索**：不注册可用搜索路由；
- **独立搜索服务**：显式选择单独配置的搜索 Provider，不会复用或转发当前模型的密钥。

## 自动映射与高级覆盖

普通用户不需要填写下面的配置。Runtime 当前自动映射：

| 模型 API 协议 | 联网搜索协议 |
| --- | --- |
| `openai-responses` | `openai-responses-web-search` |
| `openai-completions` | `openai-chat-completions-search` |
| `anthropic-messages` | `anthropic-messages-web-search` |

Provider 开发者或非标准接口可以通过配置文件显式覆盖自动映射。例如：

```yaml
apiProtocol: openai-chat-completions
capabilities:
  webSearch:
    protocol: openai-chat-completions-search
    credential: inherit
```

`credential: inherit` 表示复用当前 Provider 的 `CredentialRef`，不是复制密钥字面值。Runtime 不会把凭据写入日志、诊断包、会话事件或浏览器存储。

当前内置的通用搜索协议包括：

- `openai-responses-web-search`
- `openai-chat-completions-search`
- `anthropic-messages-web-search`
- `mcp-web-search`
- `dsh-web-search-v1`

`enable_search` 等非标准字段只能放在 Provider 的显式协议扩展声明中。扩展字段只允许有限数量的短标量值，不能覆盖模型、查询、工具或凭据等保留字段，也不能包含可执行代码或表达式。

内置 Provider 可以在自己的适配器中给出经过审计的能力；自定义地址只按模型 API 协议使用对应的标准映射，不会继承与其来源无关的厂商能力。真实第三方服务仅用于可选兼容性验证，不进入核心路由、默认配置或厂商判断。

## 第三方协议扩展

受信任 Runtime 插件可以注册新的协议执行器：

```ts
const dispose = ctx.webSearchProtocols.register(protocolId, adapter)
```

执行器接收已经绑定的当前模型路由、解析后的当前 Provider 凭据、查询和取消信号，并必须返回统一结果：

```ts
interface WebSearchResult {
  content?: string
  sources: Array<{
    url: string
    title?: string
    snippet?: string
    publishedAt?: string
  }>
  truncated?: boolean
}
```

协议插件属于 Runtime 受信任代码边界。维护者应审核其来源、传输目标、重定向行为、日志和响应大小限制；不要安装来源不明的搜索协议插件。

## 安全规则

- 密钥只发送到当前 Provider 已配置且通过校验的 HTTPS endpoint；本机开发仅允许 loopback HTTP。
- HTTP 重定向默认拒绝，搜索失败后不会自动跨 Provider 降级。
- 模型无法通过 `web_search` 参数改变内部 Provider、endpoint、模型或凭据路由。
- 返回来源只接受 HTTP/HTTPS URL，并在交给模型前去重和归一化。
- 响应大小、取消和超时都有明确上限；Provider 请求与外层工具分别使用 90 秒和 100 秒预算，错误信息不包含凭据值或内部引用名。

## 迁移说明

旧版全局固定搜索 Provider 已改为 `follow-model`。现有模型 Provider、凭据、会话和工具 Schema 保持不变，不需要重新输入地址或密钥。原有固定搜索实现仅可作为某个标准协议执行器或显式独立搜索服务存在，不再决定全局默认路由。
