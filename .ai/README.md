# Agent 项目记忆

本目录保存 DeepSeek Desktop 对 AI Agent 有长期价值的当前事实、稳定决策和验证基线，用于不同任务之间快速恢复上下文。它不保存聊天记录、执行流水、临时诊断或可由 Git 直接查询的历史日志。

## 读取顺序

1. `context.md`：产品定位、当前边界和关键版本。
2. `todo.md`：仍需处理的工作和外部条件。
3. `architecture.md`：代码分层、运行链路和数据边界。
4. `conventions.md`：实现、配置、验证和 Git 约束。
5. `decisions/`：不能只靠代码解释清楚的稳定技术决策。
6. `memory/verification.md`：最近一次可信验证及其能力边界。
7. `progress.md`：当前已交付能力摘要。
8. `skills/`：需要跨任务复用的操作手册；构建或发布任务必须先读 `skills/release-workflow.md`。

## 维护规则

- 源码、Git 状态、锁文件和实际测试结果始终优先于本目录。
- 只维护当前有效事实；历史由 Git 追溯，不在文件末尾持续追加日志。
- 架构或安全边界变化时更新或新增决策记录。
- 完成项从 `todo.md` 移除，并按需更新 `progress.md` 和验证基线。
- 发布流程、提速策略和故障恢复统一维护在 `skills/release-workflow.md`，不要在其他 `.ai/` 文件复制整套命令。
- API Key、访问令牌、本机绝对路径、用户数据和诊断内容不得写入本目录。
