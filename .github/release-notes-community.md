# DeepSeek Desktop 社区版

这是内置固定版本本地 Harness 的独立、非官方社区发行版。

<!-- release-downloads -->

## 主要变化

- 修复 Harness 仓库更新的桌面扩展依赖装配与启动顺序：候选先完成构建和启动检查，重启后再切换；准备失败仍保留当前版本
- 更换 Harness 仓库后立即清除旧仓库的候选版本和进度，避免显示过期更新状态
- 统一项目自有界面、配置、命令与目录名称为 Harness；本次采用全新配置契约，不兼容旧配置，升级前请备份应用数据
- 保持窗口顶部统一菜单栏，修正 macOS 子菜单定位，并保留原生复制、剪切、粘贴与关闭确认
- Desktop 更新摘要支持 Markdown 和备用来源的安全格式化显示，标题、列表、表格和链接不再显示为原始文本
- 保留同窗设置、工作台插件加载、会话状态、外部链接和跟随当前模型的联网搜索行为

本次修复需要安装新版 Desktop 外壳。安装包内置 Harness 仍固定为 `0.1.2-alpha.1`（`cd5ef8148158`），Node `24.20.0` / pnpm `11.24.0` 和 DSH Market `1.28.1` 保持不变。macOS 已实测通过仓库更新到 `0.1.2-rc.1`（`76fda729799f`）并恢复内置版本；其他平台的仓库更新交互尚未完成真机验收。

## 下载选择

- **macOS Apple 芯片：** `*_aarch64.dmg`
- **macOS Intel：** `*_x64.dmg`
- **Windows x64：** `*_x64-setup.exe`
- **Linux x64：** `.AppImage` 便携包或 `.deb` 安装包
- **完整性校验：** 安装前使用 `SHA256SUMS` 校验安装包

当前社区版未使用 Apple Developer ID、Apple 公证或 Windows 可信发布者证书，自动更新保持关闭。安装说明和平台实测边界请查看仓库文档。

---

# DeepSeek Desktop Community Edition

This release fixes dependency assembly and activation ordering for repository-based Harness updates, clears stale candidates when changing repositories, and formats Desktop release notes safely. It keeps the unified in-window menu bar, corrects macOS submenu positioning, and preserves native editing shortcuts and close confirmation.

Project-owned configuration, commands, paths, and interface text now use Harness naming. This is a new configuration contract without legacy compatibility; back up application data before upgrading. Install the new Desktop app to receive these changes. The bundled Harness remains pinned to 0.1.2-alpha.1, with Node 24.20.0, pnpm 11.24.0, and DSH Market 1.28.1. Repository upgrade to 0.1.2-rc.1 and restoration of the bundled version were tested on macOS; equivalent native interactions on other platforms remain unverified.

The macOS application has an ad-hoc integrity signature but is not signed or notarized with an Apple Developer ID. Windows and Linux community artifacts do not carry a trusted publisher signature. Automatic updates remain disabled.
