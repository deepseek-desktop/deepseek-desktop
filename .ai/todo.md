# 活跃待办

## 发布外部条件

- macOS Apple Developer ID 签名与公证尚未接入；具备证书后再启用 stable 发布门禁。
- Windows Authenticode 可信发布者签名尚未接入。
- 桌面安装包自动更新保持关闭，直到安装包签名、Updater 签名材料和真实升级回滚验证全部闭环。
- Runtime 独立更新协议已实现；正式配置更新地址与发布公钥前，仍需使用受信任 macOS x64、Windows x64 和 Linux x64 节点完成制品生成、下载、中断、切换和回滚演练。

## 平台验证

四平台矩阵每次发布都在各自原生 Runner 上执行 `package:community`，因此以下已是自动覆盖，不需要重复人工确认：

- `verify` 全链（含 Rust 单元测试）在 macOS ARM64/x64、Windows x64、Linux x64 各跑一次；诊断脱敏的 `USERPROFILE` 与 `HOMEDRIVE` + `HOMEPATH` 解析由注入环境的用例覆盖，四个平台都会执行。
- `test:e2e` 与 `runtime:smoke`（真实 Runtime 启动 + 父进程消亡清理）在四个平台各跑一次。
- 交付闭包扫描拒绝 `.env`、密钥、本机绝对路径和符号链接逃逸，四个平台各扫一次。

仍然只能由真机人工完成、当前尚未做的：

- Windows x64 与 Linux x64 的**桌面应用本身**启动验收：安装包安装、原生窗口标题、点击启动后 Runtime sidecar 拉起、工作台同窗口加载、退出无残留。目前只有 macOS ARM64 做过（见 `progress.md`）。CI 验证的是 Runtime 闭包能启动，不是 Tauri 外壳能启动。
- Linux x64 的凭据库、插件市场和对话链路验收。
- 未签名制品在 Gatekeeper 与 SmartScreen 下的实际拦截表现。

当前没有已知阻塞本地社区版开发的代码问题。新发现的问题应先用源码和可复现证据确认，再加入本文件。
