# ADR-018：受限 MCP 搜索客户端

采用当前审计闭包已有的 `@modelcontextprotocol/sdk@1.30.0`，由 Desktop 独立搜索插件显式声明并锁定依赖。通过公开 Client 和 StreamableHTTPClientTransport 处理初始化、通知、JSON/SSE 响应及关闭，不再手写 JSON-only RPC 客户端。

自定义 fetch 仅允许当前会话解析得到的同一端点，禁止自动重定向；凭据仅发往该端点。响应头与响应体共用取消 / 总超时，每个响应读取累计超过 2 MiB 即取消，不先读完整内容。SDK 错误转换为不含远端正文或凭据的分类错误。

SDK 负责协议，不决定搜索 Provider；普通聊天内容仍不能当作搜索执行证据。候选升级必须部署完整依赖并执行 JSON、SSE、取消、超时及超限回归。此决定不增加普通用户配置项，不修改官方搜索插件或 Harness 核心。
