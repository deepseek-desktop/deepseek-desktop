# Agent 协作指南

## 适用范围

本仓库只包含 DeepSeek Desktop。生成的 Harness 暂存目录、构建产物、本地工具链、上游审计检出、凭据和用户工作区数据均不得提交。

## 权威来源

- `.ai/README.md` 是 Agent 项目记忆入口；`.ai/context.md`、`.ai/todo.md` 和相关决策记录用于跨任务恢复上下文。
- `harness/toolchain-lock.json` 记录稳定工具链、Node 制品、原生依赖、桌面补丁和发布允许的 Harness 固定来源；`target/generated/harness-lock.json` 记录本次构建解析出的 Harness 仓库、commit、CLI 入口和 Harness 哈希。
- `src-tauri/` 负责原生生命周期、加密凭据库、诊断、设置和更新边界。
- `src/` 负责 Vue 桌面 Shell 和类型化 IPC 契约。
- `README.md`、`docs/`、`SECURITY.md` 和 `CONTRIBUTING.md` 定义公开行为与协作规则。

代码、Git 状态和实际构建结果高于 `.ai/` 记忆；发现不一致时应先核对源码，再同步修正记忆。

## 会话启动

每个新任务至少执行并读取：

1. `git status --short --branch`
2. `AGENTS.md`
3. `.ai/README.md`
4. `.ai/context.md`
5. `.ai/todo.md`

涉及架构、构建、凭据、Harness 或发布时，再读取 `.ai/architecture.md`、`.ai/conventions.md`、相关 `.ai/decisions/` 与 `.ai/memory/verification.md`。发布任务还必须读取 `.ai/skills/release-workflow.md`，按其中的方案选择、最短反馈路径、安全门禁和报告模板执行。不要依靠历史对话代替仓库事实。

## 修改规则

- 仓库文档、Issue / Pull Request 模板和发布说明以简体中文为主；确有国际协作需要时可附英文摘要，但不以英文替代中文正文。
- 用户可见文案必须同时补齐 `zh-CN`、`zh-TW` 和 `en-US`。
- 工作台 WebView 不得获得通用 Tauri Shell、文件系统或 IPC capability。
- 禁止增加明文凭据降级存储。
- 未经真实验证，不得宣称已完成签名、公证、平台支持或外部 Provider 兼容。
- 修改应聚焦；除非有意升级并同步更新校验和、许可证、SBOM 预期、测试和文档，否则保持锁定 Harness 不变。
- 完成影响架构边界、公共配置、验证基线或后续工作的重要变更后，同步维护 `.ai/`；不把执行流水和临时日志写入项目记忆。

## 验证

开发时运行与改动范围匹配的最小检查。涉及发行的改动必须执行：

```bash
corepack pnpm@11.24.0 verify
corepack pnpm@11.24.0 test:e2e
corepack pnpm@11.24.0 harness:smoke
```

`verify` 会先暂存并校验目标 Harness，再执行 Rust 检查，确保干净检出不依赖历史生成的 sidecar。
