# DeepSeek Desktop 社区版

这是内置固定版本本地 Runtime 的独立、非官方社区发行版。

## 主要变化

- Runtime 已同步至官方 `0.1.2-alpha.1`，锁定提交 `cd5ef8148158`，并适配新的 Python Runtime 部署根包名
- 上游 `dsh-web-fetch-http` 已进入桌面 Runtime 闭包，为联网检索提供新版运行时实现
- 原生窗口标题增加桌面版本号；版本缺少 `v` 时自动补齐，便于用户准确反馈问题版本
- 桌面凭据、授权策略、模型保存回滚和会话展示补丁已迁移并重新校验到新版 Runtime 包结构
- 修复 Windows 短路径构建副本的仓库地址自动解析，GitHub Actions 始终使用当前工作流仓库链接
- 发行标签支持完整 SemVer 的带 `v` 和无 `v` 两种格式，并在构建入口严格校验
- Runtime 来源和 Rust 工具链增加不可变提交与 SHA-256 校验，公开发行不会因移动 tag 或本机缓存发生漂移
- Runtime 构建变量统一为 `RUNTIME_REPOSITORY` / `RUNTIME_REF`，本地开发可自动跟随最新 SemVer，社区发行保持审计锁定
- 凭据记录索引改为加密存储，并安全迁移旧版明文索引；失败写入和删除具备回滚保护
- Desktop 壳不再选择、保存或注册项目目录；Runtime 使用独立内部运行目录，项目目录完全由工作台管理
- 外接屏仍连接时恢复原窗口位置，目标显示器断开时自动回到当前可见显示器
- 修复损坏或未来版本设置恢复、诊断日志轮转、UTF-8 截断和桌面状态操作提示
- 减少 Runtime profile 扩展的重复文件同步，并加强三语文案引用检查
- 保留 DSH Market、脱敏日志导出、自定义 Provider、模型切换和跨平台本地加密凭据库能力

## 下载选择

- **macOS Apple 芯片：** `*_aarch64.dmg`
- **macOS Intel：** `*_x64.dmg`
- **Windows x64：** `*_x64-setup.exe`
- **Linux x64：** `.AppImage` 便携包或 `.deb` 安装包
- **完整性校验：** 安装前使用 `SHA256SUMS` 校验安装包

当前社区版未使用 Apple Developer ID、Apple 公证或 Windows 可信发布者证书，自动更新保持关闭。安装说明和平台实测边界请查看仓库文档。

---

# DeepSeek Desktop Community Edition

This independent, unofficial community distribution bundles a locked local Runtime, DSH Market 1.28.1, and pnpm 11.7.0. This release updates the Runtime to upstream 0.1.2-alpha.1, includes its HTTP web-fetch implementation, decouples Desktop startup from Runtime project selection, keeps Runtime in an internal work directory, restores windows safely across changing monitor layouts, and shows the exact Desktop version in the native window title.

The macOS application has an ad-hoc integrity signature but is not signed or notarized with an Apple Developer ID. Windows and Linux community artifacts do not carry a trusted publisher signature. Automatic updates remain disabled.
