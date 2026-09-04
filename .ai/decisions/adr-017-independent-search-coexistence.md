# ADR-017：独立搜索扩展与官方插件共存

## 状态

已采用，取代 ADR-007 中依赖 Harness 搜索核心和官方设置 UI 补丁的实现。

## 决策

- 官方 `web-search-deepseek` 保持上游源码、配置与设置卡片，不强制停用。Desktop bundle 仅选择 `web.searchProvider: follow-model`，用户 profile 的主动禁用仍有最终优先级。
- follow-model 自有 host/client、设置 namespace、三语资源与 `settings.plugin.item` 插槽。删除此前对 web、tool-web、llm-pi-ai、llm-deepseek 和官方插件设置 UI 的搜索专用补丁；其他 Desktop 修复不属于本次删除范围。
- 使用公开 `agents.currentInitiator()` 获取异步执行上下文，模型提供方目录定位公开 settings；原生 DeepSeek 连接使用该包导出的连接解析函数与 launch-environment 快照，不读取官方搜索配置。
- 独立搜索路由选择仍属于 Harness 的 `web.searchProvider`，不再增加非公开 `searchWithProvider` 方法。旧扩展 `independent` 配置明确失败，UI 不再允许选择它。
- 依赖 Harness 源码包由候选闭包提供。扩展的 `dsh.desktop.harnessPackages` 声明此类要求，防止 npm 自动安装另一版 Harness 核心；已有 npm peer 锁保持不变。新字段由唯一 deploy helper 消费，宿主服务方法在插件启动时验证。Desktop 自有 client 的完整入口及注入依赖也必须存在。
- Responses/Chat/Messages 要求真实结构化搜索执行或引用证据，不能把普通回答当作搜索结果。未知 API、不完整路由、明确禁用、凭据缺失及搜索失败不跨提供方降级。
- 已实测的 DeepSeek 与 Alibaba MaaS 标准端点自动选 Responses 搜索，独立于聊天协议与可编辑 Provider id。未填写 API 不再阻断这些端点；未知端点不推测内置目录的协议或地址。pi-ai 模型条目不拥有连接覆盖字段，扩展不读取此类未知字段。

## 理由与边界

启用状态与搜索选择分离，使官方插件可共存，并避免 Harness 更新替换 Desktop 私有 UI 补丁后设置消失。每次搜索绑定当前 Agent 的路由，不使用全局最近模型或全局凭据缓存。

已有上游接口与依赖仍是兼容边界，不承诺未知未来 Harness 无条件可用。候选检查失败不得修改 current 指针或用户数据。真实平台与供应商验收分别记录，不能用 Mock、浏览器视口或 ARM Windows 的 x64 模拟代替 Windows x64 原生验收。
