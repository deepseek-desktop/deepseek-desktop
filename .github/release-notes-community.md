# DeepSeek Desktop 社区版

这是内置固定版本本地 Harness 的独立、非官方社区发行版。

<!-- release-downloads -->

## 主要变化

- Harness 默认来源改为官方仓库，内置基线升级到官方 master 的 `c291e7961a51`（`0.1.5-rc.2`）。
- 插件配置与只读插件列表采用官方实现，不再强制装配 DSH Market，也不保留旧市场适配补丁。
- Desktop 独立搜索设置改用官方 Fetch API、模型目录和公开 peer 依赖，删除旧 RPC 通道、私有依赖列表和旧版路由兼容字段。
- 打包与仓库更新统一采用当前官方的本地 npm 包、依赖闭包和隔离安装机制，不再修改 Python SDK 聚合包或补拷旧核心。
- 模型设置、聊天展示、审批提示和插件分批加载沿用官方行为；保留经验证仍必要的桌面凭据隔离、Cookie 清理和工具调用身份修复。

Node `24.20.0` / pnpm `11.24.0` 保持锁定。此更新需要新版 Desktop 外壳；Harness 候选通过构建、闭包校验和真实启动检查后才会切换，失败保留当前版本。

## 下载选择

- **macOS Apple 芯片：** `*_aarch64.dmg`
- **macOS Intel：** `*_x64.dmg`
- **Windows x64：** `*_x64-setup.exe`
- **Linux x64：** `.AppImage` 便携包或 `.deb` 安装包
- **完整性校验：** 安装前使用 `SHA256SUMS` 校验安装包

当前社区版未使用 Apple Developer ID、Apple 公证或 Windows 可信发布者证书，Desktop 安装包自动更新保持关闭；Harness 独立更新不受此限制。本版本标记为社区预发布，不占据 Latest。安装说明和平台实测边界请查看仓库文档。
