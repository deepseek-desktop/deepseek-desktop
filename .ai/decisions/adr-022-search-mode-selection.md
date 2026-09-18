# ADR-022：联网搜索三模式单选，官方插件恢复默认启用

## 状态

已采用，取代 [ADR-021](adr-021-official-search-plugin-default-off.md) 全文，并撤销它对 [ADR-017](adr-017-independent-search-coexistence.md) 的修改；ADR-017 其余决策继续有效。

## 背景

ADR-021 断言官方 `web-search-deepseek` 启用时会注册自己的 `web_search` 工具，与 Desktop 扩展形成两条竞争的搜索路径。核对上游源码后该断言不成立：

- 模型可见的 `web_search` 工具由 `@deepseek-ai/dsh-tool-web` 唯一注册；两个搜索插件都不注册工具。
- 官方插件只调用 `ctx.web.registerSearchProvider()`，登记 id 为 `deepseek-official` 的 provider；本扩展登记 `follow-model`。
- `WebRuntime.search()` 每次调用用 `web.searchProvider` 精确解析出唯一一个 provider，解析不到抛 `WEB_PROVIDER_CONFIGURED_MISSING`。歧义错误 `WEB_PROVIDER_AMBIGUOUS` 只在该配置缺省时可达，而 `web.searchProvider` 自本仓库第一版起就始终显式配置。

因此一次工具调用只产生一个上游请求，两个插件同时启用不会重复搜索。ADR-021 反而引入一个真实缺陷：默认停用官方插件后，「独立搜索服务」模式的默认 Provider ID 恰是它注册的 `deepseek-official`，于是保存成功、界面显示「已生效」，而每次搜索都失败 —— 激活期只检查 `web` 服务存活，不检查目标 provider 是否在册。

「独立搜索服务」的自由文本 Provider ID 本身也没有价值：Harness 不公开 provider 枚举接口，实际可用值只有官方插件那一个。

## 决策

- 官方 `web-search-deepseek` 恢复默认启用，`deepseek-desktop-bundle` 不再对它打停用补丁。两个插件常驻，由 `web.searchProvider` 决定谁执行。
- `web-search-follow-model` 的 `mode` 收敛为互斥三选一：`follow-model` / `web-search` / `disabled`。删除 `independentProvider` 与 `officialSearchPlugin` 两个设置字段及其界面控件。自由文本消失后，填不出不存在的 Provider ID。
- 不为退役的 `independent` 保留兼容处理。schemastery 会拒绝联合类型之外的存储值，`settings.register()` 因此在构造时抛错，仍存有该值的 profile 会让 `web-search-selection` 条目加载失败。接受这一代价：v1.1.20 是该模式唯一存在过的版本，且它在其中本就每次搜索必败，实际存有该值的安装极少。
- Desktop 不把官方插件强塞回 profile。条目不在或被停用时，`web-search` 选择直接失败回滚，而不是替用户改写 profile。
- 激活期断言目标 provider 已注册且 `available()` 为真，否则失败回滚，界面不得显示「已生效」。这也是上一条的落地方式。
- 凭据有效性仍留给运行期：官方插件通过自己的设置节和启动环境回退解析密钥，在 Desktop 侧复刻这套逻辑会对实际可解析的密钥误报缺失。

## 理由与边界

三选一是结构性的互斥约束。改用「两个独立开关」会打开「都启用且 `searchProvider` 为空」这一状态，而两个 provider 的 `available()` 实际恒为真，该状态下每次搜索都抛 `WEB_PROVIDER_AMBIGUOUS`。靠停用一方来选中另一方同样更差：停用条目要拆除整个 fiber，两个条目的启停无法做成原子操作，失败会停在「零个 provider」或「两个 provider」，而切换配置字段本就有干净的回滚路径。

本决策不改变官方插件的源码、名称、设置卡片或配置，也不对签名、公证或真实供应商凭据验收作出任何声明。官方插件启用后会渲染它自己的设置卡片，这是启用它的必然代价，只能由文案区分。
