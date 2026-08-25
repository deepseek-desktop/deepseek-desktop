# DeepSeek Desktop 社区版

这是内置固定版本本地 Runtime 的独立、非官方社区发行版。

## 主要变化

- 内置 DSH Market `1.28.1` 和锁定的 pnpm `11.7.0`，可在桌面工作台中浏览、安装、更新和卸载插件，无需预装 Node.js 或 pnpm
- Runtime 启动时合并桌面内置 Bundle 与用户 Profile，不覆盖已安装插件和自定义依赖
- 桌面诊断页新增脱敏纯文本日志导出，诊断包继续保留结构化状态与版本信息
- 修复 DSH Market 安装子进程误继承桌面预加载脚本导致的安装失败
- 桌面管理与工作台 WebView 互斥显示，修复页面重叠时鼠标手势和箭头反复切换的闪烁问题
- README 补齐实际工作台、插件市场截图与中文快速使用流程

## 下载选择

- **macOS Apple 芯片：** `*_aarch64.dmg`
- **macOS Intel：** `*_x64.dmg`
- **Windows x64：** `*_x64-setup.exe`
- **Linux x64：** `.AppImage` 便携包或 `.deb` 安装包
- **完整性校验：** 安装前使用 `SHA256SUMS` 校验安装包

当前社区版未使用 Apple Developer ID、Apple 公证或 Windows 可信发布者证书，自动更新保持关闭。安装说明和平台实测边界请查看仓库文档。

---

# DeepSeek Desktop Community Edition

This independent, unofficial community distribution bundles a locked local Runtime, DSH Market 1.28.1, and pnpm 11.7.0. It preserves user profile dependencies, fixes plugin child-process startup, adds redacted log export, prevents overlapping workbench and management WebViews, and documents the verified workbench and plugin market flows.

The macOS application has an ad-hoc integrity signature but is not signed or notarized with an Apple Developer ID. Windows and Linux community artifacts do not carry a trusted publisher signature. Automatic updates remain disabled.
