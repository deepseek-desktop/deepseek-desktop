# DeepSeek Desktop Community Edition

This release is an independent, unofficial community distribution of the locked DeepSeek Harness Runtime.

## Highlights

- Uses one cross-platform authenticated encrypted credential vault without repeated operating-system keychain prompts.
- Fixes custom Provider creation, credential Proxy calls, Runtime retry behavior, and misleading authentication errors.
- Disables automatic spelling correction, capitalization, and writing suggestions inside managed Harness inputs without changing entered values.

## Downloads

- **macOS Apple Silicon:** `*_aarch64.dmg`
- **macOS Intel:** `*_x64.dmg`
- **Windows x64:** `*_x64-setup.exe`
- **Linux x64:** choose the `.AppImage` portable package or `.deb` installer
- **Integrity:** verify the installer with `SHA256SUMS` before installation

## Important

The macOS application has an ad-hoc integrity signature but is not signed or notarized with an Apple Developer ID. Windows and Linux community artifacts do not carry a trusted publisher signature. Automatic updates remain disabled. See the repository documentation for installation guidance and current platform acceptance status.

---

这是基于固定版本 DeepSeek Harness Runtime 构建的独立、非官方社区发行版。

- 使用跨平台认证加密凭据库，不再反复弹出系统钥匙串授权窗口
- 修复自定义 Provider 创建、凭据代理调用、Runtime 重试和误导性的认证错误
- 关闭受管 Harness 输入框的自动纠错、首字母大写和写作建议，不修改用户输入值

- macOS Apple 芯片请选择 `*_aarch64.dmg`
- macOS Intel 芯片请选择 `*_x64.dmg`
- Windows 请选择 `*_x64-setup.exe`
- Linux 可选择 `.AppImage` 便携包或 `.deb` 安装包
- 安装前请使用 `SHA256SUMS` 校验文件完整性

当前社区版未使用 Apple Developer ID、Apple 公证或 Windows 可信发布者证书，自动更新保持关闭。安装说明和平台实测边界请查看仓库文档。
