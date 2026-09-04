# DeepSeek Desktop 社区版

这是内置固定版本本地 Runtime 的独立、非官方社区发行版。

<!-- release-downloads -->

## 主要变化

- 修复 macOS 从 Finder 启动后 Runtime 仓库检查超时：仓库检查和拉取自动使用系统静态代理，并遵守绕过规则
- 保留用户已有 Git 和环境代理设置，不修改全局网络配置，不要求重新填写仓库或模型凭据
- 仓库连接超时改为明确的三语网络/代理提示，并清理仍在运行的 Git 辅助进程；失败不停止或替换当前 Runtime
- 保留工作台插件加载、会话 Cookie 清理、菜单和编辑快捷键等既有修复

本次修复位于 Desktop 外壳，需要安装新版桌面应用，仅更新 Runtime 不会生效。安装包内置 Runtime 仍固定为 `0.1.2-alpha.1`（`cd5ef8148158`），Node `24.20.0` / pnpm `11.24.0` 和 DSH Market `1.28.1` 保持不变。

系统代理自动适配仅针对 macOS 的 HTTP(S) Git 请求；PAC 自动代理、Windows/Linux 和依赖下载继续使用各工具已有的网络配置。

## 下载选择

- **macOS Apple 芯片：** `*_aarch64.dmg`
- **macOS Intel：** `*_x64.dmg`
- **Windows x64：** `*_x64-setup.exe`
- **Linux x64：** `.AppImage` 便携包或 `.deb` 安装包
- **完整性校验：** 安装前使用 `SHA256SUMS` 校验安装包

当前社区版未使用 Apple Developer ID、Apple 公证或 Windows 可信发布者证书，自动更新保持关闭。安装说明和平台实测边界请查看仓库文档。

---

# DeepSeek Desktop Community Edition

This release fixes Runtime repository checks timing out when the macOS app is launched without terminal proxy variables. HTTP(S) Git checks and clones now use the system static proxy and bypass rules, while respecting explicit Git and environment proxy settings. Timeouts have clearer localized messages and clean up Git helpers without changing the current Runtime.

Install the new Desktop app to receive this shell fix. The bundled Runtime remains pinned to 0.1.2-alpha.1, with Node 24.20.0, pnpm 11.24.0, and DSH Market 1.28.1. PAC, Windows/Linux, and dependency downloads retain their existing network configuration behavior.

The macOS application has an ad-hoc integrity signature but is not signed or notarized with an Apple Developer ID. Windows and Linux community artifacts do not carry a trusted publisher signature. Automatic updates remain disabled.
