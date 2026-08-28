# 当前上下文

## 项目定位

DeepSeek Desktop 是 DeepSeek Harness 的独立社区桌面发行版。它使用 Tauri 2 管理本地 Runtime，在单个原生窗口中嵌入 Harness 工作台，并提供首次引导、工作区、模型凭据、诊断、关于和更新状态等桌面能力。

本仓库是独立 Git 仓库。虽然当前目录位于 SpringOpen 的 `views/` 下，但不得从 SpringOpen 父仓库接管、暂存或提交本仓库文件，也不得修改相邻的 `views/deepseek-harness`。

## 当前边界

- Runtime 仅监听 `127.0.0.1` 随机端口，由 Rust Supervisor 启停、探活和回收。
- Harness 工作台与桌面管理界面共用一个原生窗口，通过受控视图和原生菜单切换。
- 工作台 WebView 不获得通用 Tauri Shell、文件系统或任意 IPC 权限。
- 模型凭据保存在跨平台本地加密凭据库中，不使用系统钥匙串，也不降级为 `.env` 或明文文件。
- 加密凭据库主要防止意外明文泄漏；它不承诺抵御已经取得同一操作系统用户权限的恶意进程。
- 社区版默认关闭自动更新；签名、公证和可信发布者能力必须在具备真实证书并完成平台验证后才能声明。
- 四平台发行可由平台无关的本地 Controller 和多个受信任原生 Worker 协作完成；filesystem/NAS 是默认发布渠道，GitHub 仅为可选 Provider。

## 版本基线

- 项目默认和文档示例版本：`1.0.0`；真实发行版本由 Git tag 或发布环境注入。
- Node：`24.16.0`
- pnpm：`11.7.0`
- Rust：`1.98.0`
- Tauri CLI：`2.11.4`
- Runtime 固定来源、commit 和制品校验和以 `runtime/toolchain-lock.json` 为准，不在本文件重复维护。

## 发行目标

- macOS arm64 / x64
- Windows x64
- Linux x64

未经对应平台真实构建和运行验证，不得将目标矩阵写成已验收平台列表。
