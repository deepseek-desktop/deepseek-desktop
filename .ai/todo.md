# 活跃待办

## 发布外部条件

- macOS Apple Developer ID 签名与公证尚未接入；具备证书后再启用 stable 发布门禁。
- Windows Authenticode 可信发布者签名尚未接入。
- 桌面安装包自动更新保持关闭，直到安装包签名、Updater 签名材料和真实升级回滚验证全部闭环。
- Runtime 独立更新协议已实现；正式配置更新地址与发布公钥前，仍需使用受信任 macOS x64、Windows x64 和 Linux x64 节点完成制品生成、下载、中断、切换和回滚演练。

## 平台验证

- Linux x64 仍需在真实发行环境完成安装、启动、Runtime、凭据、插件和对话验收后，才能声明平台完整可用。
- 下一个明确授权的正式版本需由 GitHub Actions 官方 Runner 完成 macOS ARM64/x64、Windows x64 和 Linux x64 原生矩阵，并在发布后核验 5 个安装包与 `SHA256SUMS`。

当前没有已知阻塞本地社区版开发的代码问题。新发现的问题应先用源码和可复现证据确认，再加入本文件。
