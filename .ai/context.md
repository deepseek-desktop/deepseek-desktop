# 当前上下文

## 项目定位

DeepSeek Desktop 是 DeepSeek Harness 的独立社区桌面发行版。它使用 Tauri 2 管理本地 Runtime，在单个原生窗口中嵌入 Harness 工作台，并提供自动启动、模型凭据、诊断、关于和更新状态等桌面能力。

本仓库是独立 Git 仓库。虽然当前目录位于 SpringOpen 的 `views/` 下，但不得从 SpringOpen 父仓库接管、暂存或提交本仓库文件，也不得修改相邻的 `views/deepseek-harness`。

## 当前边界

- Runtime 仅监听 `127.0.0.1` 随机端口，由 Rust Supervisor 启停、完成浏览器令牌握手、探活和回收；令牌化启动 URL 仅保存在进程内私有状态，公开状态与诊断只保留无令牌根地址。
- Desktop 是稳定原生外壳，不选择、保存或注册用户项目目录；Runtime 工作台自行管理项目目录。Runtime 从应用数据目录内的独立 `runtime-workdir` 启动，Desktop 只依赖公开启动、健康和凭据协议。
- OpenAI Responses 兼容流的最终 `output_item.done` 事件是工具调用 ID、名称、参数和 namespace 的权威事实；不得沿用 `output_item.added` 中可能过期的工具身份，否则会把 `glob` 等调用误派发为 `read`。
- Harness 工作台与桌面管理界面共用一个原生窗口，通过受控视图和原生菜单切换。
- Desktop 初始化后自动启动空闲 Runtime，并在 readiness 通过后直接打开工作台；已就绪 Runtime 不重复启动，启动失败时保留桌面管理页、重试和诊断入口。
- 窗口状态按显示器恢复；保存位置仍能落在已连接显示器时保持不变，目标显示器断开时回到当前主显示器可见区域。
- 工作台 WebView 不获得通用 Tauri Shell、文件系统或任意 IPC 权限。
- 模型凭据保存在跨平台本地加密凭据库中，不使用系统钥匙串，也不降级为 `.env` 或明文文件。
- 联网搜索默认跟随当前会话模型 Provider：显式 `capabilities.webSearch` 可作高级覆盖，否则根据当前模型 `apiProtocol` 自动映射标准搜索协议，并复用该 Provider 的 endpoint、model 和 `CredentialRef`；模型 Provider 表单不显示重复的搜索协议控件。Provider 请求使用 90 秒预算，外层工具使用 100 秒预算并区分取消与超时；核心路由不识别厂商、域名或 Provider ID，未知接口不盲试协议，也不跨 Provider 传递凭据。
- Desktop 仅承载并隔离 Runtime 工作台，不改写页面交互：受管 loopback 页面在内嵌 WebView 中正常导航，外部 HTTP/HTTPS 链接优先交给系统默认浏览器，打开失败或其他原生导航行为由 WebView 继续处理。
- 导航判定按当前受管 Origin 实时进行，不使用 WebView 创建时的快照；Runtime 未就绪期间没有可信 Origin，HTTP/HTTPS 导航一律拒绝而不转交系统浏览器，避免把带令牌的 loopback 地址交给外部程序。
- Runtime 进程以 `--expose-internals` 启动：这是 Harness 插件加载器与 HMR 的硬性契约，同时意味着 Runtime 内所有代码（含第三方市场插件）都能访问 Node 内部模块，属于已知且被接受的边界放宽。
- 加密凭据库主要防止意外明文泄漏；它不承诺抵御已经取得同一操作系统用户权限的恶意进程。
- 社区版默认关闭桌面安装包自动更新；Runtime 独立更新默认采用“发现后提醒”，且只有在构建时配置可信 Ed25519 清单、公钥和发布者后才启用，二者不共用信任边界。
- 未签名制品发布时一律标记 GitHub prerelease，不占据 Latest release 位置；该判断取自生成配置的 `release.signed`，与 SemVer 版本号形态无关，签名接入后自动恢复为正式发布。
- 正式四平台发行统一由 GitHub Actions 官方托管 Runner 原生构建：Pull Request 与普通分支 push 不触发发布工作流，只有完整 SemVer Tag 才运行质量门禁并进入 macOS ARM64/x64、Windows x64、Linux x64 矩阵。
- 四个平台复用唯一 `package:community` / `desktop:package` 构建事实；全部成功后才创建 Release，公开资产只包含 5 个安装包和 `SHA256SUMS`。
- 本机只执行源码验证、E2E、Runtime smoke 和当前 macOS 架构打包/启动测试；不以 Parallels、Rosetta、Docker、本地 Controller/Worker 或自托管 Runner 作为正式发布前提。
- 四平台统一使用工具链 lock 中的 Node `24.20.0` / ABI `137`，Runner 不得依赖全局版本漂移；内部 BUILD-INFO 用于矩阵汇总核验但不公开发布。
- Runtime 更新只写入应用数据目录，执行签名与兼容校验、受限解压、启动 smoke、原子切换和自动回滚；安装包内置 Runtime 始终作为最终恢复基线。
- 清单反回放在检查阶段只做校验，接受记录直到制品真正暂存成功才落盘；「恢复内置 Runtime」同时清除接受历史，使撤回后同版本换 commit 重新签发仍可安装。
- 待安装 Runtime 的激活 smoke 与自动检查在后台线程串行执行，不占用驱动窗口的线程；激活期间对外发布 `applying` 状态。
- 签名清单请求使用 30 秒预算，与制品下载的 20 分钟预算分离，避免更新服务停滞长时间占用更新操作锁。

## 版本基线

- 项目默认和文档示例版本：`1.0.0`；真实发行版本由 Git tag 或发布环境注入。
- Node：`24.20.0`（四平台精确锁定，module ABI `137`）
- pnpm：`11.24.0`
- Rust：`1.98.0`
- Tauri CLI：`2.11.4`
- Runtime 固定来源、commit 和制品校验和以 `runtime/toolchain-lock.json` 为准，不在本文件重复维护。

## 发行目标

- macOS arm64 / x64
- Windows x64
- Linux x64

未经对应平台真实构建和运行验证，不得将目标矩阵写成已验收平台列表。
