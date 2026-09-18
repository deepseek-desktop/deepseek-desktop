# ADR-021：桌面默认停用官方搜索插件并交由设置开关控制

## 状态

**已废弃，由 [ADR-022](adr-022-search-mode-selection.md) 取代。** 本决策的全部理由建立在一个错误的机制判断上（见下），实现已回退：官方插件恢复默认启用，`officialSearchPlugin` 开关已删除。保留本文件是为了记录该错误结论及其纠正过程。

**错误在哪里**：下文称「官方插件在启用时会注册自己的 `web_search` 工具」。核对源码后并非如此 —— 官方插件只调用 `ctx.web.registerSearchProvider()` 注册一个 provider；模型可见的 `web_search` 工具由 `@deepseek-ai/dsh-tool-web` 唯一注册。官方插件源码里那处 `name: "web_search"` 是它 POST 到 `{baseURL}/messages` 的请求体中声明的 Anthropic 服务端工具 `web_search_20250305`，是发往远端 API 的参数，不是 Harness 工具注册。因此「两条竞争路径」从未存在。下文「用户观察到二者冲突」一句也未经机制层面确认。

## 背景

ADR-017 把「插件是否启用」与「选择哪个搜索 Provider」分开，让官方插件与 Desktop 独立扩展共存，只由 `web.searchProvider` 决定谁执行搜索。该模型在路由层面成立，但忽略了工具注册层面：官方插件在启用时会注册自己的 `web_search` 工具，因此同一个会话里会出现两条互相竞争的搜索路径，用户观察到二者冲突。

## 决策

- 桌面 profile 默认停用官方 `web-search-deepseek`。停用写在 `deepseek-desktop-bundle` 的 `cordis.patch.yml` 中，该 bundle 在 `dsh-base` 之后组装，因此覆盖上游声明的条目，而条目本身保持存在、未被改写，随时可以重新启用。
- `web-search-follow-model` 设置新增 `officialSearchPlugin` 开关（`disabled` / `enabled`，默认 `disabled`），三语文案同步提供。
- 该设置是唯一持久状态：协调器在每次激活时把它应用到 Loader 条目的 `disabled` 上，不依赖 Loader 文件的回写语义。启用时传 `null` 清除覆盖而非写入显式 `false`，使上游默认继续生效。停用与回滚路径同样恢复该状态。
- 仍然不修改官方插件的源码、名称或设置界面；Desktop 只控制它在桌面 profile 中的启用状态。

## 理由与边界

设置作为唯一事实来源，可以避免「bundle 补丁每次组装都重新写入停用」与「用户运行时改写」之间的层级冲突：无论 profile 如何重新组装，启用状态都由设置在激活时重新推导。bundle 层的默认停用则消除协调器生效之前两个插件同时注册的窗口。

用户主动在 profile 中把该条目改回启用仍然有效，Desktop 不覆盖这一选择；对应断言已写入 Harness smoke。本决策只针对桌面发行的默认组装，不改变上游插件自身的行为，也不对未接入的签名、公证或真实供应商凭据验收作出任何声明。
