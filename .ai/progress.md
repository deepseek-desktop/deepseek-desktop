# 当前交付摘要

- 当前已成功交付的历史版本是 `v1.1.27` 社区预发布；其质量门禁、四平台原生构建、Windows x64 安装交互、汇总发布和本机 macOS ARM64 安装验收均有记录，证据及边界见 [当前发布验收](memory/verification.md#当前发布验收)。
- 下一代发行版本采用 Harness 对齐的四段数字：前三段等于锁定 Harness 的正式版本，第四段是 Desktop 修订号。当前锁定 Harness `0.1.6`，首个候选为 `0.1.6.1`；该候选尚未经过 Tag 矩阵或公开发布验收。
- Harness 默认来源为 `https://github.com/deepseek-desktop/deepseek-harness.git`，锁定 commit `ddefc45fbc7f8e46dd73185e68295696d1297887`（`0.1.6-alpha.2`）。来源仓库从上游切换到 Desktop fork 时 commit 未改变，因此内核字节基线不变。
- 插件配置、插件管理器和只读插件清单使用当前 Harness 机制；Desktop 不保留旧市场 UI 或强制装配逻辑。需要 DSH Market 时由官方 `dsh plugin` 命令管理用户依赖和 Bundle 声明。
- 独立联网搜索扩展通过公开 Agent 上下文、模型目录、搜索 Provider 和设置插槽接入；官方搜索插件保持默认启用，三种模式互斥，Desktop 不补丁改写官方搜索界面或核心路由。
- Desktop 采用单窗口 Tauri Shell，Harness 工作台运行在隔离 WebView；原生生命周期、加密凭据、诊断、更新和菜单由 Rust 管理，工作台不获得通用 Tauri IPC、文件系统或 shell 权限。
- 发布只允许 GitHub 官方托管 Runner 原生构建 macOS ARM64/x64、Windows x64 和 Linux x64。未签名社区制品保持 prerelease；完整验证命令和失败恢复规则见 [发布手册](skills/release-workflow.md)。
- 后续判断必须以当前 HEAD、工具链 lock、生成锁和实际构建结果为准；历史成功发行不替代新四段版本的验证。
