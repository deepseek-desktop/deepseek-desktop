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
- 联网搜索默认跟随当前会话模型 Provider，通过显式 `capabilities.webSearch` 协议声明复用该 Provider 的 endpoint、model 和 `CredentialRef`；Provider 请求使用 90 秒预算，外层工具使用 100 秒预算并区分取消与超时；核心路由不识别厂商、域名或 Provider ID，未知接口不盲试协议，也不跨 Provider 传递凭据。
- Desktop 仅承载并隔离 Runtime 工作台，不改写页面交互：受管 loopback 页面在内嵌 WebView 中正常导航，外部 HTTP/HTTPS 链接优先交给系统默认浏览器，打开失败或其他原生导航行为由 WebView 继续处理。
- 加密凭据库主要防止意外明文泄漏；它不承诺抵御已经取得同一操作系统用户权限的恶意进程。
- 社区版默认关闭桌面安装包自动更新；Runtime 独立更新默认采用“发现后提醒”，且只有在构建时配置可信 Ed25519 清单、公钥和发布者后才启用，二者不共用信任边界。
- 四平台发行可由平台无关的本地 Controller 和多个受信任原生 Worker 协作完成；filesystem/NAS 是默认发布渠道，GitHub 仅为可选 Provider。
- 正式发行先通过签名准备凭据只执行一次公共门禁；Worker 严格绑定 tag、Desktop/Runtime commit、源码、配置、lock 和工具链后复用同一 `desktop:package` 完成目标平台组装、smoke、打包与审计。无有效凭据时不得跳过完整门禁。
- Runtime 闭包和 Cargo 输出采用目标隔离的内容寻址持久缓存，命中前复核清单与哈希；单机四环境默认按内存限制并发，只重试失败目标，上传失败不重新编译。
- 单机四环境从当前干净、tag 锁定的 HEAD 生成经 Git 校验的本地 source bundle，避免 Rosetta、Docker 与 Parallels 依赖宿主机 SSH 会话；公共 Runtime 闭包保留四目标 Koffi、Sharp/libvips 等可选原生包，Worker 再按目标裁剪。
- 单机编排为四平台自动校验或安装唯一工具链锁中的 Node `24.20.0` / ABI `137`；所有 Worker 拒绝宿主机全局版本漂移并把实际版本写入内部 BUILD-INFO 与运行摘要。Parallels 预检异步执行，避免阻塞同进程 TLS Controller；Runtime smoke 的失败输出经过凭据过滤与限长后保留真实诊断尾部。
- Runtime 更新只写入应用数据目录，执行签名与兼容校验、受限解压、启动 smoke、原子切换和自动回滚；安装包内置 Runtime 始终作为最终恢复基线。

## 版本基线

- 项目默认和文档示例版本：`1.0.0`；真实发行版本由 Git tag 或发布环境注入。
- Node：`24.20.0`（四平台精确锁定，module ABI `137`）
- pnpm：`11.7.0`
- Rust：`1.98.0`
- Tauri CLI：`2.11.4`
- Runtime 固定来源、commit 和制品校验和以 `runtime/toolchain-lock.json` 为准，不在本文件重复维护。

## 发行目标

- macOS arm64 / x64
- Windows x64
- Linux x64

未经对应平台真实构建和运行验证，不得将目标矩阵写成已验收平台列表。
