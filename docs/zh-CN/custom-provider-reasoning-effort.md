# 自定义模型提供方的推理强度

会话输入区的模型选择器带一个「推理等级」子菜单。它只在当前模型声明了可选推理档位时出现：预设提供方的档位由适配器和上游模型目录提供，**手动添加的 OpenAI Compatible 提供方默认没有**，需要在 `settings.yaml` 中显式声明。

本文说明声明方式、每一档实际发出的请求，以及一个已实测的完整示例。

## 为什么自定义提供方默认不显示

pi-ai 适配器判定一个模型的推理能力时只有两个来源：模型条目自己声明的 `reasoningEfforts`，以及未声明时回退到 pi-ai 安装目录中**同 id** 的条目。手动添加的提供方指向的是上游目录没有的模型 id，回退无处可去，于是判定为不具备推理能力，菜单不渲染。

这是能力判定，不是界面缺失。模型设置界面刻意不提供推理强度控件：推理档位是**单个模型**的能力，同一个提供方下的模型未必一致，提供方级别的控件只能被设成其中一部分模型会拒绝的值。DeepSeek 官方提供方的档位由其适配器直接给出，pi-ai 目录内的厂商路由由上游目录给出，两者都不经过配置文件，也不需要本文的配置。

设置界面的「获取可用模型」同样不会带来推理能力：它按端点的模型列表接口读取 `id`、`name`、上下文窗口和最大输出，是供采纳的候选元数据，`settings.yaml` 仍是唯一决定路由服务什么的地方。已存在的模型条目在重新获取时原样保留，只有新出现的 id 才会新增行，因此「自动获取模型列表」与「手写推理档位」可以长期共存。

## 配置位置

应用数据目录下的 `dsh/settings.yaml`。macOS 默认位于 `~/Library/Application Support/deepseek.desktop/dsh/settings.yaml`；Windows 和 Linux 使用 Tauri 对应的平台应用数据目录，见[数据目录](getting-started.md#数据目录)。

该文件被监听，保存后热加载，不需要重启。配置无法服务时整份更新会被拒绝并保留上一份生效配置，日志中出现 `llm-pi-ai: keeping the previously registered routes after a refused update`。

## 声明档位

在模型条目上声明 `reasoningEfforts`：键是菜单档位，值是该档要发送给服务端的**线上写法**。

```yaml
models:
  - id: <模型 id>
    reasoningEfforts:
      off:
      low: low
      medium: medium
      high: high
```

键取自固定的七档词表，菜单按该顺序显示，名称是首字母大写后的键名：

| 档位键 | 菜单显示 | 预算槽 |
| --- | --- | --- |
| `off` | Off | 不发送预算 |
| `minimal` | Minimal | `minimal` |
| `low` | Low | `low` |
| `medium` | Medium | `medium` |
| `high` | High | `high` |
| `xhigh` | Xhigh | `high`（与 `high` 共用） |
| `max` | Max | `high`（与 `high` 共用） |

- **只声明服务端真实支持的档位。** 词表是本项目的固定预设，不是服务端的能力清单；声明了服务端不认的档，多数服务端会静默回退到邻近值，于是菜单上多出一档、行为却和相邻档一模一样。
- 未声明的键视为该模型不支持，不进入菜单；至少要声明一个 `off` 以外的档。
- `off` 是唯一允许留空值的键，表示这一档不发送线上值。
- 键与值允许不同名（`low: minimal` 表示菜单显示 Low、线上发 `minimal`），但那会让界面和线上行为对不上，仅在固定词表覆盖不到服务端写法时使用。
- 提供方级的 `reasoning: <档位>` 决定菜单默认档；不声明时显示 `Default`，由服务端自行决定。

只声明 `reasoningEfforts` 时，Chat Completions 路由按 OpenAI 惯例发送顶层 `reasoning_effort`。对多数网关这已经够用，但它**关不掉思考**：选中 `off` 时这条路径什么都不发，服务端自己的默认（或它保存的模型设置）继续生效，于是菜单里的 Off 与实际行为不符。

## 让「Off」真正生效（仅 Chat Completions）

服务端按 chat template 参数控制思考时，用 `compat` 指定发送形状：

```yaml
compat:
  thinkingFormat: chat-template
  thinkingTokenBudgetField: thinking_budget   # 服务端接受的思考预算字段名
  chatTemplateKwargs:
    enable_thinking:
      $var: thinking.enabled
    reasoning_effort:
      $var: thinking.effort
      omitWhenOff: true
```

`chatTemplateKwargs` 的值可以是字面量，也可以是三个请求期占位符之一：

| 占位符 | 取值 |
| --- | --- |
| `thinking.enabled` | 选中 `off` 时为 `false`，其余档为 `true` |
| `thinking.effort` | 该档在 `reasoningEfforts` 中声明的线上写法 |
| `thinking.budget` | 该档的思考预算，见 `thinkingBudgets` |

`omitWhenOff: true` 让该键在 `off` 档缺席。这样 `off` 档发出的是显式的 `enable_thinking: false`，而不是「什么都不发」，服务端存储的默认值因此被覆盖。

`thinkingBudgets` 按上表的预算槽设置思考预算，配合 `thinkingTokenBudgetField` 作为顶层字段发出；预算会按该请求的最大输出上限收敛，至少保留 1024 token 给正文。不声明这两项时不发送预算，由服务端自己决定。

声明了这两项之后，预算会**随每一次请求**发出。服务端通常把请求参数排在自己保存的模型设置之前，因此此时在服务端关闭预算不会生效——它每次都被请求里的值覆盖，而且是静默的，服务端一侧看不出异常。要真正停用预算，删掉客户端这两个字段，而不是只改服务端。


预算槽只有四个，且 `xhigh`、`max` 强制共用 `high` 的槽，因此**一个路由内最多只能有四档预算互不相同的思考等级**。同时暴露 `high` 与 `xhigh` 时，两档的预算必然相同；若服务端的模板又把其中一个回退成另一个，这两档就会发出完全一致的请求。需要更多互不相同的预算档时，只能另建一个指向同一端点的路由，让它拥有自己的 `thinkingBudgets`。

`thinkingFormat` 与 `chatTemplateKwargs` **只在 `api: openai-completions` 上可配置**，其余协议的 compat 闸门不提供这两个字段。`openai-responses` 与 `anthropic-messages` 路由只需声明 `reasoningEfforts`，由各自协议原生传递推理强度；本文未对这两条路径做实测。

## 完整示例：oMLX + Qwen3.8

以本机 oMLX 暴露的 Qwen3.8 为例。以下配置对齐本机 OpenCode 已在使用的路由：模型 `qwen3.8-27b-4bit`、131072 上下文、32768 最大输出、Medium 默认推理、15 分钟流空闲超时，并保留跨轮思考内容。该模型的 chat template 只接受 `low`、`medium`、`xhigh` 三个值（默认 `xhigh`），因此只声明这三档；词表中的 `minimal`、`high`、`max` 该模型不支持，声明后只会得到与 Xhigh 行为相同的重复项。

[可直接合并的完整示例](../examples/omlx-qwen38.settings.yaml)由验证脚本交给当前暂存 Harness 的 `@deepseek-ai/dsh-llm-pi-ai` schema 解析，避免文档字段与实际内核漂移。

```yaml
llm-pi-ai:
  providers:
    omlx:
      apiKeyEnv: OMLX_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:8888/v1
      streamIdleTimeoutMs: 900000
      reasoning: medium
      compat:
        thinkingFormat: chat-template
        chatTemplateKwargs:
          enable_thinking:
            $var: thinking.enabled
          preserve_thinking: true
          reasoning_effort:
            $var: thinking.effort
            omitWhenOff: true
      models:
        - id: qwen3.8-27b-4bit
          name: Qwen3.8 27B
          contextWindow: 131072
          maxTokens: 32768
          input:
            - text
          reasoningEfforts:
            off:
            low: low
            medium: medium
            xhigh: xhigh
agent-default-model:
  provider: omlx
  model: qwen3.8-27b-4bit
```

四个档位实际发出的 `chat_template_kwargs`：

| 菜单档位 | `chat_template_kwargs` |
| --- | --- |
| Off | `{"enable_thinking": false, "preserve_thinking": true}` |
| Low | `{"enable_thinking": true, "preserve_thinking": true, "reasoning_effort": "low"}` |
| Medium | `{"enable_thinking": true, "preserve_thinking": true, "reasoning_effort": "medium"}` |
| Xhigh | `{"enable_thinking": true, "preserve_thinking": true, "reasoning_effort": "xhigh"}` |

`streamIdleTimeoutMs` 对应 Harness 的单段流空闲预算；OpenCode 的总请求 `timeout` 没有一一对应的 Harness 字段，因此没有硬套进去。`preserve_thinking` 是静态 chat template 参数，每档都发送。`input: [text]` 与当前 OpenCode 模型声明一致，避免把该量化版本误标成已验证的图片模型。上下文窗口必须按实际模型声明：未声明 `contextWindow` 时适配器使用 262144 的默认值，大于该模型实际的 131072 会让压缩时机偏晚。

### 可选的思考预算

推荐配置不发送思考预算，由 oMLX 和模型模板自己决定。确实需要为每档固定预算时，可以另外加入：

```yaml
      thinkingBudgets:
        low: 1024
        medium: 2048
        high: 8192
      compat:
        thinkingTokenBudgetField: thinking_budget
```

其余字段保持不变。此时 Low、Medium、Xhigh 分别附带 1024、2048、8192；Xhigh 使用 `thinkingBudgets.high` 槽。客户端会在每次请求覆盖服务端预算，只有确认需要固定预算时才应启用。

## 常见问题

**菜单出现了，但选 Off 仍然思考。** 只声明了 `reasoningEfforts` 而没有配 `compat.thinkingFormat`，或服务端把思考开关锁在自己一侧。前者按上一节补 `chat-template` 形状；后者需要在服务端解除锁定（oMLX 对应 `forced_ct_kwargs`）。

**某一档与相邻档表现完全一样。** 该档的线上写法很可能不在服务端模板的词表内，被服务端静默换成了别的值。服务端通常不会因此报错：以 oMLX 为例，模板渲染失败后它先查一张内置的别名表重试，别名也渲染不出来才丢掉该字段、让模板的默认值兜底，全程只记一条 debug 日志。Qwen3.8 的模板只认 `('xhigh', 'medium', 'low')`，而 oMLX 的别名表把 `high` 映射为 `xhigh`，于是同时暴露 High 和 Xhigh 会得到两个完全相同的档；一个模板和别名表都不认的值则落到模板默认值，本例同样是 `xhigh`。核对服务端模板的词表，按词表真实支持的名字声明档位——菜单上多出来的那一档不会报错，只会安静地和邻档同行为。

**用了 `thinkingFormat: qwen` 却关不掉思考。** 该形状发送的是**顶层** `enable_thinking`。若服务端的请求模型没有声明这个字段（oMLX 即是如此），它会被直接丢弃。改用 `chat-template` 形状把开关放进 `chat_template_kwargs`。

**整个提供方从模型列表中消失。** 配置被判定为无法服务，全份更新遭拒。常见原因是 `reasoningEfforts` 为空、只声明了 `off`、或某一档的值是空字符串。查看日志中的拒绝原因，它会指出出错的路由和字段。

## 自行验证

配置改动后建议直接核对线上行为，而不是只看菜单是否出现。对着自己的端点按上表逐档发一次请求，比较返回中的思考内容长度：`off` 档应当没有任何思考内容，其余档之间应当能看出差异。单次采样不足以判断相邻档是否真的不同，同一档至少重复三次再比较区间。

## 验证边界

本文的字段语义取自当前锁定 Harness 的 `@deepseek-ai/dsh-llm-pi-ai` 配置契约，Harness 升级后须重新核对。

示例一节的四档请求与响应差异在 macOS arm64 + oMLX 0.6.4 + Qwen3.8-27B-oQ4e-mtp 上实测通过：`off` 档三次采样均无思考内容，`xhigh` 档与 `low`/`medium` 档的思考长度区间不重叠；`low` 与 `medium` 的区间存在重叠，与该模板 `medium` 分支不注入任何指令一致。随后使用 `/Applications/DeepSeek Desktop.app` 内实际安装的 `v0.1.6.1`，通过桌面凭据桥接完成 Medium 档真实对话和 Bash 工具调用；会话记录确认 provider、model、131072 上下文、32768 最大输出、工具结果及最终回复。该结果只覆盖本机 oMLX 0.6.4 与上述量化模型，不扩大为其他服务、模型或平台兼容性结论。
