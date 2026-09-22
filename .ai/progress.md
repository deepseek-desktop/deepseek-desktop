# 当前交付摘要

- 社区旧 alpha Release/Tag 已撤下；`v0.1.5.1` 已通过四平台原生矩阵发布为社区预发布，公开资产为五个安装包与 `SHA256SUMS`。公开 ARM64 DMG 已在本机 macOS arm64 完成安装、启动、真实 oMLX 推理与退出清理验收。
- 发行版本采用 Harness 对齐的四段数字：前三段等于锁定 Harness 的前三段版本号，第四段是 Desktop 修订号。当前锁定 Harness `0.1.5-rc.2`，源码默认 Desktop 修订号为 `1`。
- 当前 Harness 固定实际 `dsh-v0.1.5-rc.2` 标签 commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`；模型菜单采用已经审阅的 WebKit 点击聚焦补丁，保持 RC 真实版本。
- 插件配置和只读插件清单使用当前 Harness 机制；Desktop 不保留旧市场 UI 或强制装配逻辑。DSH Market 随首次使用的新 Harness commit 通过官方 `dsh plugin --profile desktop-web add dshmarket@latest` 同步，失败可重试；详见 ADR-028。
- 独立联网搜索扩展通过公开 Agent 上下文、模型目录、搜索 Provider 和设置插槽接入；官方搜索插件保持默认启用，三种模式互斥，Desktop 不补丁改写官方搜索界面或核心路由。
- Desktop 采用单窗口 Tauri Shell，Harness 工作台运行在隔离 WebView；原生生命周期、加密凭据、诊断、更新和菜单由 Rust 管理，工作台不获得通用 Tauri IPC、文件系统或 shell 权限。
- 发布只允许 GitHub 官方托管 Runner 原生构建 macOS ARM64/x64、Windows x64 和 Linux x64。未签名社区制品保持 prerelease；完整验证命令和失败恢复规则见 [发布手册](skills/release-workflow.md)。
- 后续判断必须以当前 HEAD、工具链 lock、生成锁和实际构建结果为准；历史成功发行不替代新四段版本的验证。
- 修复本地构建入口与验证顺序：`pnpm run build` 进入完整 Tauri/Harness 构建，`verify` 和 `test:e2e` 在消费桌面扩展前重新生成 Harness 闭包；Playwright 预览使用独立前端构建，避免旧生成目录造成依赖漏装或完整构建挤占启动超时。
- oMLX Qwen3.8 配置使用当前 Harness 官方 schema；`v0.1.6.2` 安装版已完成真实对话与 Bash 工具调用，`v0.1.6.3` 安装版另已完成本机真实对话。用户模型配置保持不变，工具调用历史证据不冒充本版重测。
- Release 正文从 CHANGELOG 的非空“未发布”段生成，发布后归档至对应版本段；`docs/releases/0.1.5.1.md` 是当前版本正文归档，`docs/releases/0.1.6.x.md` 仅保留已撤下版本的历史说明，不能作为下载入口。
