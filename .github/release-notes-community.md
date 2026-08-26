# DeepSeek Desktop 社区版

这是内置固定版本本地 Runtime 的独立、非官方社区发行版。

## 主要变化

- 统一 `.env`、应用元数据、Runtime 来源和安装包信息的构建配置链路
- Runtime 来源解析为不可变提交，并生成可追溯的构建信息与制品校验和
- 修复 Runtime 桌面补丁应用流程，保持上游构建和桌面扩展可复现
- 修复 macOS 从工作台切回桌面管理时残留 WebView 原生渲染层导致的白屏问题
- 修复 Windows Runtime 子进程显示控制台窗口、关闭窗口触发自动恢复并可能打开外部浏览器的问题
- 保留 DSH Market、脱敏日志导出、自定义 Provider 和跨平台本地加密凭据库能力

## 下载选择

- **macOS Apple 芯片：** `*_aarch64.dmg`
- **macOS Intel：** `*_x64.dmg`
- **Windows x64：** `*_x64-setup.exe`
- **Linux x64：** `.AppImage` 便携包或 `.deb` 安装包
- **完整性校验：** 安装前使用 `SHA256SUMS` 校验安装包

当前社区版未使用 Apple Developer ID、Apple 公证或 Windows 可信发布者证书，自动更新保持关闭。安装说明和平台实测边界请查看仓库文档。

---

# DeepSeek Desktop Community Edition

This independent, unofficial community distribution bundles a locked local Runtime, DSH Market 1.28.1, and pnpm 11.7.0. It unifies build configuration and provenance, fixes Runtime patching, prevents stale macOS WebView layers from obscuring the desktop management surface, and keeps the Windows Runtime console hidden.

The macOS application has an ad-hoc integrity signature but is not signed or notarized with an Apple Developer ID. Windows and Linux community artifacts do not carry a trusted publisher signature. Automatic updates remain disabled.
