# ADR-024：流空闲超时作为原生字段补丁进模型提供方表单

## 状态

已采用。为这一处恢复上游设置 UI 补丁，[ADR-017](adr-017-independent-search-coexistence.md)「不补丁上游设置 UI」在其余范围继续有效。

## 背景

`llm-pi-ai` 与 `llm-deepseek` 都有公开字段 `streamIdleTimeoutMs`（默认 300000ms），决定一次请求最多允许多久完全收不到流式数据。本机大模型的冷加载与长上下文预填充容易超过它，而上游表单不渲染该字段，用户只能手工编辑 `settings.yaml`。

上游 `dsh-client-ui-settings-models` 没有可用于表单内部的扩展点：`renderSlot` 只到 4 个调用点（提供方卡片 3 处、区块页脚 1 处），`ProviderEditor` 与 `CustomProviderCard` 都拿不到它。先尝试过用 `settings.models.provider-card` 插槽外加独立扩展包渲染，结果字段挂在折叠状态的卡片上、脱离表单，且新建流程中提供方尚未进入目录，字段根本不出现 —— 不满足需求，已撤销。

## 决策

- 补丁目标版本以 `harness/toolchain-lock.json` 为准，当前为 `@deepseek-ai/dsh-client-ui-settings-models@0.1.5-rc.2` 的 `lib/client.js`，把 `streamIdleTimeoutMs` 加成原生字段：
  - `CustomProviderCard`（新建）：草稿 state、模型目录下方的输入框、并入提交的 profile 对象、无法解析时阻止「创建提供方」。
  - `ProviderEditor`（编辑）：同一字段，写入草稿 profile，无法解析时阻止「保存」。位置与 `API 协议`、`模型目录` 同在「自定义设置」折叠区内。
  - 共享 `parseTimeoutMs` / `timeoutInvalid` 两个解析函数，范围取上游自己的上限 2147483647。
  - `zh` 与 `en` 两份字典各加 3 个键。桌面 locale 桥把 zh-CN 与 zh-TW 都映射到 `zh`，该区块本来也只注册这两种语言，因此不另加 zh-TW 条目。
- 单位沿用上游原值（毫秒），不做换算：用户填什么，提供方配置里就是什么。
- 留空即 `unset`，回到上游默认，而不是写入当日默认值。
- 撤销为此新建的 `deepseek-desktop-model-advanced` 扩展包及其全部接线。

## 理由与边界

选补丁而非运行时 DOM 注入（React portal），关键在失效时有没有信号：

- 补丁**不依赖行号**。`git apply` 按上下文匹配；实测在文件顶部插入 500 行使全文行号位移后，补丁仍然成功应用。
- 上下文代码真变了时，本仓库的机制是**构建期硬失败**：`markers` 全部命中则跳过（上游已自带该能力），未命中且版本不等于锁定版本则抛错，应用后再次校验 markers，补丁文件另有 sha256。实测模拟上游改版（版本 0.1.7-alpha.1 且锚点代码被重写）得到明确错误：`Desktop compatibility patch … is absent from 0.1.7-alpha.1; expected 0.1.6-alpha.1`。
- portal 方案相反：依赖上游 DOM 结构与类名，标记一变就静默失位，没有构建期信号，只能等用户发现。

代价是每次 Harness 升级必须重新生成并核对该补丁。补丁由确定性字符串替换脚本生成，锚点取唯一且语义稳定的片段，不含任何构建机路径。

本决策不改变上游默认值，也不对真实供应商在特定超时下的表现作出声明。
