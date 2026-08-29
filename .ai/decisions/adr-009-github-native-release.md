# ADR-009：GitHub Actions 官方原生矩阵发布

## 状态

已采用。

## 决策

DeepSeek Desktop 的正式四平台发行统一使用 GitHub Actions 官方托管 Runner。Pull Request 和 `master` push 只执行质量检查；带或不带 `v` 前缀的完整 SemVer Tag 才触发 macOS ARM64、macOS x64、Windows x64 和 Linux x64 原生矩阵。

四个平台都调用现有 `package:community`，不复制打包逻辑。矩阵全部成功后，汇总任务严格验证两份 DMG、一个 EXE、一个 AppImage、一个 DEB 和统一 SHA-256；公开 Release 只包含这 5 个安装包与 `SHA256SUMS`。内部 BUILD-INFO 只用于目标和来源核验。

本机四平台调度、Parallels、Rosetta、Docker、Controller/Worker、多节点票据和自托管 Runner 不再作为正式发布主流程。本机只负责通用验证、Runtime smoke 和当前 macOS 架构构建/启动检查。

## 理由

- 每个目标由对应官方 Runner 原生完成，减少本机环境差异和维护负担。
- PR 不进入开发者本地节点，安全边界更直接。
- 所有平台复用单一打包事实，避免流程分叉。
- 四个平台全部通过后才发布，用户不会看到不完整版本。

## 后果

- 正式发布依赖 GitHub Actions 可用性和仓库 Secrets。
- 某个平台失败时必须修复并使用新的不可变版本 Tag，不能移动旧 Tag。
- 本机测试不能代替 Windows、Linux 或 Intel macOS 的原生结果。
- 历史本地发布协议可继续存在于源码中供实验，但发布手册和 Agent 记忆不得把它作为默认路线。
