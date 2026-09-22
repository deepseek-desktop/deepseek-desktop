# 当前交付摘要

- 当前公开发行版为 `v0.1.6.2`：Tag 绑定提交 `0080e35eb1569f32c3450145941f461038cf7024`，GitHub 官方 Runner 四平台矩阵与汇总发布全部成功，六个公开资产已下载并重算通过。旧版本体系的 Release 与 Tag 已从 GitHub 和本地清理；历史验证记录只作技术证据。
- 发行版本采用 Harness 对齐的四段数字：前三段等于锁定 Harness 的前三段版本号，第四段是 Desktop 修订号。当前锁定 Harness `0.1.6`，源码默认 Desktop 修订号为 `3`。
- Harness 默认来源为 `https://github.com/deepseek-desktop/deepseek-harness.git`，锁定 commit `303d39dab4a88bcd957221d88b663e72e03bf7ee`（CLI 仍为 `0.1.6-alpha.2`），带上已审阅的 WebKit 模型菜单点击修复。该审计基线不等同于稳定内核，后续自动选版与更新候选暂时只过滤 alpha/beta。
- 插件配置、插件管理器和只读插件清单使用当前 Harness 机制；Desktop 不保留旧市场 UI 或强制装配逻辑。DSH Market 随首次使用的新 Harness commit 通过官方 `dsh plugin --profile desktop-web add dshmarket@latest` 同步，失败可重试；详见 ADR-028。
- 独立联网搜索扩展通过公开 Agent 上下文、模型目录、搜索 Provider 和设置插槽接入；官方搜索插件保持默认启用，三种模式互斥，Desktop 不补丁改写官方搜索界面或核心路由。
- Desktop 采用单窗口 Tauri Shell，Harness 工作台运行在隔离 WebView；原生生命周期、加密凭据、诊断、更新和菜单由 Rust 管理，工作台不获得通用 Tauri IPC、文件系统或 shell 权限。
- 发布只允许 GitHub 官方托管 Runner 原生构建 macOS ARM64/x64、Windows x64 和 Linux x64。未签名社区制品保持 prerelease；完整验证命令和失败恢复规则见 [发布手册](skills/release-workflow.md)。
- 后续判断必须以当前 HEAD、工具链 lock、生成锁和实际构建结果为准；历史成功发行不替代新四段版本的验证。
- 修复本地构建入口与验证顺序：`pnpm run build` 进入完整 Tauri/Harness 构建，`verify` 和 `test:e2e` 在消费桌面扩展前重新生成 Harness 闭包；Playwright 预览使用独立前端构建，避免旧生成目录造成依赖漏装或完整构建挤占启动超时。
- 新增 oMLX Qwen3.8 官方配置契约示例及暂存 Harness schema 回归；本机构建包已用真实模型完成对话和 Bash 工具调用，下载的正式发布包再次通过真实 UI 对话，用户配置修改前保留了可恢复备份。
- Release 正文不再硬编码一次性的版本变化，改为从 `CHANGELOG.md` 的非空“未发布”段生成；`v0.1.6.2` 公开正文已修正并复核社区 Harness、四段版本和 oMLX 信息。
