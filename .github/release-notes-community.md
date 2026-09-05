# DeepSeek Desktop 社区版

这是内置固定版本本地 Harness 的独立、非官方社区发行版。

<!-- release-downloads -->

## 主要变化

- 修复 macOS 原生视图引用失衡导致的崩溃，以及 WebKit 消息回放导致的历史对话空白；保持全屏、同窗设置和统一菜单位置
- 加强凭据日志脱敏、配置原子保存、并发设置冲突处理与 Harness 激活中断恢复，保留用户配置和会话数据
- 将“跟随当前模型”的联网搜索作为 Desktop 独立扩展装配；官方 `web-search-deepseek` 保持上游原样，两个插件可以同时启用，由唯一的搜索 Provider 选择避免重复搜索
- 联网搜索默认复用当前会话实际模型、接口地址和凭据，模型切换及多会话互不串用；不支持的协议会明确失败，不把普通模型回答伪装成搜索结果
- 内置 Harness 升级到 `0.1.3-alpha.1`，恢复权限预设的中文显示：“仅可查看”“工作区内修改”“完全权限”
- 修复生产闭包路径清理损坏原生 Node 模块的问题；文本和二进制分别处理，macOS 修改后的 Mach-O 重新执行完整性签名
- Windows x64 发布矩阵新增真实安装、启动、工作台、设置菜单、关闭确认、Harness 子进程退出和卸载验收；任一步失败都不会创建 Release
- 保持窗口顶部统一菜单栏、同窗设置、原生复制粘贴、关闭确认、外部链接和 Desktop 更新摘要格式化行为

本次修复需要安装新版 Desktop 外壳。安装包内置 Harness 固定为 `0.1.3-alpha.1`（`d347e703908d`），Node `24.20.0` / pnpm `11.24.0` 和 DSH Market `1.28.1` 保持不变。Harness 升级或切换仓库时会重新装配 Desktop 独立扩展；候选只有在构建、闭包校验和真实启动检查通过后才会切换，失败仍保留当前可用版本。

## 下载选择

- **macOS Apple 芯片：** `*_aarch64.dmg`
- **macOS Intel：** `*_x64.dmg`
- **Windows x64：** `*_x64-setup.exe`
- **Linux x64：** `.AppImage` 便携包或 `.deb` 安装包
- **完整性校验：** 安装前使用 `SHA256SUMS` 校验安装包

当前社区版未使用 Apple Developer ID、Apple 公证或 Windows 可信发布者证书，Desktop 安装包自动更新保持关闭；Harness 独立更新不受此限制。本版本标记为社区预发布，不占据 Latest。安装说明和平台实测边界请查看仓库文档。

---

# DeepSeek Desktop Community Edition

This release fixes unbalanced macOS native-view ownership and WebKit conversation-history replay, while preserving fullscreen and the unified window menu. It also strengthens credential redaction, atomic configuration writes, concurrent settings updates, and interrupted Harness activation recovery.

This release installs follow-model web search as an independently managed Desktop extension while leaving the official `web-search-deepseek` plugin unchanged. Both plugins can remain enabled because one configured search provider owns request routing. Searches reuse the active session model, endpoint, and credential reference; model changes and concurrent sessions remain isolated, and unsupported protocols fail explicitly.

The bundled Harness is updated to 0.1.3-alpha.1 (`d347e703908d`), restoring localized permission preset labels. Production deployment now preserves native-binary offsets while sanitizing build paths and re-signs modified Mach-O files. The Windows x64 release job installs the generated package and verifies application startup, workbench and Settings interaction, close confirmation, Harness child-process cleanup, and uninstall before a Release can be created. Node 24.20.0, pnpm 11.24.0, and DSH Market 1.28.1 remain pinned.

The macOS application has an ad-hoc integrity signature but is not signed or notarized with an Apple Developer ID. Windows and Linux community artifacts do not carry a trusted publisher signature. Desktop installer auto-updates remain disabled; independent Harness updates remain available. This community prerelease is not promoted to Latest.
