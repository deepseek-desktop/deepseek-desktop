# DeepSeek Desktop 社区版

这是内置固定版本本地 Runtime 的独立、非官方社区发行版。

## 主要变化

- 产品、安装包、桌面自有组件、诊断文件和数据目录统一使用 DeepSeek Desktop 新名称
- 使用跨平台认证加密凭据库，不再反复弹出系统钥匙串授权窗口
- 修复自定义 Provider 创建、凭据代理调用、Runtime 重试和误导性的认证错误
- 关闭受管工作台输入框的自动纠错、首字母大写和写作建议，不修改用户输入值

## 下载选择

- **macOS Apple 芯片：** `*_aarch64.dmg`
- **macOS Intel：** `*_x64.dmg`
- **Windows x64：** `*_x64-setup.exe`
- **Linux x64：** `.AppImage` 便携包或 `.deb` 安装包
- **完整性校验：** 安装前使用 `SHA256SUMS` 校验安装包

当前社区版未使用 Apple Developer ID、Apple 公证或 Windows 可信发布者证书，自动更新保持关闭。安装说明和平台实测边界请查看仓库文档。

---

# DeepSeek Desktop Community Edition

This independent, unofficial community distribution bundles a locked local Runtime. It standardizes the DeepSeek Desktop identity, uses a cross-platform authenticated encrypted credential vault, fixes Provider creation and Runtime retry failures, and disables automatic text correction in managed workbench inputs.

The macOS application has an ad-hoc integrity signature but is not signed or notarized with an Apple Developer ID. Windows and Linux community artifacts do not carry a trusted publisher signature. Automatic updates remain disabled.
