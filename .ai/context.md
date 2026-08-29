# 当前上下文

## 项目定位

DeepSeek Desktop 是 DeepSeek Harness 的独立社区桌面发行版。它使用 Tauri 2 管理本地 Runtime，在单个原生窗口中嵌入 Harness 工作台，并提供首次引导、模型凭据、诊断、关于和更新状态等桌面能力。

本仓库是独立 Git 仓库。虽然当前目录位于 SpringOpen 的 `views/` 下，但不得从 SpringOpen 父仓库接管、暂存或提交本仓库文件，也不得修改相邻的 `views/deepseek-harness`。

## 当前边界

- Runtime 仅监听 `127.0.0.1` 随机端口，由 Rust Supervisor 启停、完成浏览器令牌握手、探活和回收；令牌化启动 URL 仅保存在进程内私有状态，公开状态与诊断只保留无令牌根地址。
- Desktop 是稳定原生外壳，不选择、保存或注册用户项目目录；Runtime 工作台自行管理项目目录。Runtime 从应用数据目录内的独立 `runtime-workdir` 启动，Desktop 只依赖公开启动、健康和凭据协议。
- OpenAI Responses 兼容流的最终 `output_item.done` 事件是工具调用 ID、名称、参数和 namespace 的权威事实；不得沿用 `output_item.added` 中可能过期的工具身份，否则会把 `glob` 等调用误派发为 `read`。
- Harness 工作台与桌面管理界面共用一个原生窗口，通过受控视图和原生菜单切换。
- 窗口状态按显示器恢复；保存位置仍能落在已连接显示器时保持不变，目标显示器断开时回到当前主显示器可见区域。
- 工作台 WebView 不获得通用 Tauri Shell、文件系统或任意 IPC 权限。
- 模型凭据保存在跨平台本地加密凭据库中，不使用系统钥匙串，也不降级为 `.env` 或明文文件。
- DeepSeek 联网搜索只读取官方凭据 `DEEPSEEK_API_KEY` 并调用官方搜索端点；阿里云 MaaS 等自定义 Provider 凭据不得自动转发或别名到该端点。
- 加密凭据库主要防止意外明文泄漏；它不承诺抵御已经取得同一操作系统用户权限的恶意进程。
- 社区版默认关闭桌面安装包自动更新；Runtime 独立更新默认采用“发现后提醒”，且只有在构建时配置可信 Ed25519 清单、公钥和发布者后才启用，二者不共用信任边界。
- 四平台发行可由平台无关的本地 Controller 和多个受信任原生 Worker 协作完成；filesystem/NAS 是默认发布渠道，GitHub 仅为可选 Provider。
- Runtime 更新只写入应用数据目录，执行签名与兼容校验、受限解压、启动 smoke、原子切换和自动回滚；安装包内置 Runtime 始终作为最终恢复基线。

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
