# 当前上下文

## 项目定位

DeepSeek Desktop 是 DeepSeek Harness 的独立社区桌面发行版。它使用 Tauri 2 管理本地 Harness，在单个原生窗口中嵌入 Harness 工作台，并提供自动启动、模型凭据、诊断、关于和更新状态等桌面能力。

本仓库是独立 Git 仓库。虽然当前目录位于 SpringOpen 的 `views/` 下，但不得从 SpringOpen 父仓库接管、暂存或提交本仓库文件，也不得修改相邻的 `views/deepseek-harness`。

## 当前边界

- 2026-09-05 审计修复验证包（本地默认版本 `1.0.0`）已备份后安装，内置 Harness 以当前 lock 为准。完整本地打包与搜索/设置 smoke 通过，但实际全屏再次触发 SIGABRT；macOS 整体验收、Windows x64 原生验收和可信签名尚未闭环。用户授权条件满足后发布 `1.1.0`，目前不得创建 Tag/Release；以下旧版本记录不代表当前已通过发布验收，逐缺陷证据见 [审计修复验收](memory/audit-remediation.md)。

- 跟随模型搜索现为 Desktop 独立 host/client 扩展，通过公开 Agent 异步上下文、模型目录、搜索 Provider 注册和设置插槽接入。官方搜索源码、设置和启用状态遵循上游及用户配置；Desktop 的单一选择可以映射为 `follow-model`、已注册的独立搜索 Provider 或关闭搜索，不再补丁修改官方搜索卡片或 Harness 搜索核心。候选闭包验证扩展前后端及 Harness 依赖，详见 ADR-017。`1.0.32` macOS ARM64 安装候选已完成真实安装与交互验收，发布仍必须等待本次 Tag 的 Windows x64 原生安装门禁和四平台矩阵。

- `v1.0.31` 已通过 GitHub 原生四平台矩阵并发布，六个公开资产下载校验一致。用户授权备份后，本机安装版已更新至 `1.0.31` 并通过原生交互验收；本机 Harness 已升级至 `0.1.2-rc.1` / `76fda729799f`。安装包内置基线仍以工具链 lock 为准，平台与测试边界见验证基线。

- Desktop 更新摘要的 API Markdown 使用锁定的 markdown-it 渲染；备用 Atom HTML 只重建排版白名单，不执行原始 HTML、不请求外部图片，也不允许非 HTTP(S) 链接。保留有界完整正文，不按字符截断 Markdown；网页链接走专用原生校验命令，同窗设置和原有官方下载入口不变。见 ADR-016。

- 项目自有文案、配置、命令、路径、IPC、状态和更新元数据统一使用 Harness，按全新契约开发，不实现旧配置兼容、迁移或专项提示。保留常规配置校验与损坏文件保护。第三方 API、锁定依赖与补丁上下文保留真实标识，详见 ADR-014。

- 三平台功能菜单栏统一保留在应用窗口顶部，不能因优化 macOS 子菜单而搬回系统屏幕顶部。macOS 子菜单按标题左下角转换为屏幕坐标，通过空 `inView` 的 NSMenu 调用展开，避免绑定 Tao 根视图；定位实现与升级注意事项见 ADR-013。
- Harness 仅监听 `127.0.0.1` 随机端口，由 Rust Supervisor 启停、完成浏览器令牌握手、探活和回收；令牌化启动 URL 仅保存在进程内私有状态，公开状态与诊断只保留无令牌根地址。
- Desktop 是稳定原生外壳，不选择、保存或注册用户项目目录；Harness 工作台自行管理项目目录。Harness 从应用数据目录内的独立 `harness-workdir` 启动，Desktop 只依赖公开启动、健康和凭据协议。
- OpenAI Responses 兼容流的最终 `output_item.done` 事件是工具调用 ID、名称、参数和 namespace 的权威事实；不得沿用 `output_item.added` 中可能过期的工具身份，否则会把 `glob` 等调用误派发为 `read`。
- Harness 工作台是唯一主界面；运行状态、诊断、Desktop 更新、Harness 更新和关于按需显示为同一原生窗口中的设置层。设置打开时只隐藏工作台子 WebView，关闭时在同一次 Harness 启动内复用原页面，不重新导航或丢失会话状态；但工作台页面按 Harness 启动代次记账，Harness 每次重启后回到工作台一律重新导航。Harness 的插件 bundle URL 携带插件集合哈希 `rev`，更新或恢复基线改变插件集合后旧 rev 一律返回 404，表现为工作台「Failed to load plugins」；仅比对 Origin 不足以发现这种失效，重启复用同端口时尤其如此。
- Harness 浏览器会话 Cookie 的名称包含随机端口派生值，但 WebKit 按主机而非端口发送 Cookie；反复启动会积累旧 `dsh-auth-*` Cookie，较长的插件组合 URL 会先越过 Node 请求头上限并返回 431，同样表现为「Failed to load plugins」。Desktop Harness 在新会话握手时清除旧会话 Cookie，并限制单条插件组合 URL，为请求头保留稳定余量。
- 唯一完整功能菜单由 Desktop Shell 固定显示在窗口内容区顶部左侧，macOS、Windows、Linux 统一为“文件 / 编辑 / 视图 / 窗口 / 帮助”；标题由 Vue 三语渲染，展开项由 Tauri 弹出原生菜单。Harness 子 WebView 从菜单栏下方开始，不注入菜单脚本也不获得 IPC；macOS 系统栏可见部分只保留最小应用菜单，但在应用菜单中注册并隐藏系统预定义的撤销、重做、剪切、复制、粘贴和全选 responder，使 `Cmd` 编辑快捷键可以原生路由到当前 WKWebView；Windows/Linux 不挂载重复的完整原生窗口菜单。
- macOS 26 可能在 Tao `0.35.3` 的 `TaoView` 已脱离窗口或状态已替换后继续投递输入事件；Tao 随后从失效弱引用读取窗口并在 `objc_loadWeakRetained` 崩溃。Desktop 只在 macOS 初始化时保护纯事件投递处理器：视图必须仍登记同一个 `taoState` 且仍挂载 NSWindow 才转发原实现，否则丢弃事件；生命周期、布局和 tracking rect 回调不得拦截。菜单弹出和工作台/设置切换不主动调用 `set_focus()`，避免 AppKit 过渡期把正在释放的 responder 设为 first responder。Windows/Linux 不受影响，依赖升级后必须重新核对 `TaoView` 方法契约与该防护是否仍有必要。
- Desktop 初始化后自动启动空闲 Harness，并在 readiness 通过后直接打开工作台；已就绪 Harness 不重复启动，启动失败时打开设置层中的重试、恢复和诊断入口。
- 窗口状态按显示器恢复；保存位置仍能落在已连接显示器时保持不变，目标显示器断开时回到当前主显示器可见区域。
- 工作台 WebView 不获得通用 Tauri Shell、文件系统或任意 IPC 权限。
- 模型凭据保存在跨平台本地加密凭据库中，不使用系统钥匙串，也不降级为 `.env` 或明文文件。
- 联网搜索默认跟随当前会话模型 Provider：显式 `capabilities.webSearch` 可作高级覆盖；已审计的 DeepSeek 与 Alibaba MaaS 精确端点可自动选择其标准搜索协议，其他提供方根据当前模型显式 `apiProtocol` 映射，并始终复用该会话的 endpoint、model 和 `CredentialRef`。模型 Provider 表单不显示重复协议控件。Provider 请求使用 55 秒预算，并服从当前 Agent preset 的外层工具预算（内置 preset 为 60 秒）；未知端点和接口不盲试协议，也不跨 Provider 传递凭据。
- 图片输入能力按具体模型和端点声明，不按提供方品牌整体放开。模型设置的高级区域可以显式保存 `text + image` 输入能力；只有模型目录已声明或用户确认该精确模型及 API 地址支持图片时，工作台才允许发送图片。
- Desktop 仅承载并隔离 Harness 工作台，不改写页面交互：受管 loopback 页面在内嵌 WebView 中正常导航，外部 HTTP/HTTPS 链接优先交给系统默认浏览器，打开失败或其他原生导航行为由 WebView 继续处理。
- 导航判定按当前受管 Origin 实时进行，不使用 WebView 创建时的快照；Harness 未就绪期间没有可信 Origin，HTTP/HTTPS 导航一律拒绝而不转交系统浏览器，避免把带令牌的 loopback 地址交给外部程序。
- Harness 进程以 `--expose-internals` 启动：这是 Harness 插件加载器与 HMR 的硬性契约，同时意味着 Harness 内所有代码（含第三方市场插件）都能访问 Node 内部模块，属于已知且被接受的边界放宽。
- 加密凭据库主要防止意外明文泄漏；它不承诺抵御已经取得同一操作系统用户权限的恶意进程。
- 社区版保持关闭 Desktop 自动下载安装，但每天最多从构建时固定的官方 GitHub 仓库静默检查一次 Release，也允许手动检查；候选按完整 SemVer、发布时间、draft/prerelease 状态和五个平台资产完整性选择，不使用 `latest`，提醒只打开由固定仓库和验证后 tag 构造的官方 Release 页面。Harness 独立更新默认采用“发现后提醒”，默认跟随构建时的 Harness 仓库；用户只需替换仓库地址即可改用官方上游或自己的兼容 fork，二者不共用更新边界。
- 未签名制品发布时一律标记 GitHub prerelease，不占据 Latest release 位置；该判断取自生成配置的 `release.signed`，与 SemVer 版本号形态无关，签名接入后自动恢复为正式发布。
- 正式四平台发行统一由 GitHub Actions 官方托管 Runner 原生构建：Pull Request 与普通分支 push 不触发发布工作流，只有完整 SemVer Tag 才运行质量门禁并进入 macOS ARM64/x64、Windows x64、Linux x64 矩阵。
- 四个平台复用唯一 `package:community` / `desktop:package` 构建事实；全部成功后才创建 Release，公开资产只包含 5 个安装包和 `SHA256SUMS`。
- Windows x64 矩阵在上传制品前必须实际安装 NSIS 包并验证 x64 PE、工作台、设置菜单、关闭确认、Harness 子进程退出与卸载；只构建成功不能进入汇总发布。
- GitHub Release 正文根据当前 Tag 和已汇总的完整公开资产集合生成直接下载链接；站点自身的 `Assets` 折叠状态不作为用户下载入口前提。
- 本机只执行源码验证、E2E、Harness smoke 和当前 macOS 架构打包/启动测试；不以 Parallels、Rosetta、Docker、本地 Controller/Worker 或自托管 Runner 作为正式发布前提。
- 四平台统一使用工具链 lock 中的 Node `24.20.0` / ABI `137`，Runner 不得依赖全局版本漂移；内部 BUILD-INFO 用于矩阵汇总核验但不公开发布。
- Harness 更新只写入应用数据目录；仓库模式复用内置 Node/pnpm 拉取、构建并 smoke 候选，可选签名制品模式继续执行签名、兼容和受限解压校验，两者共用原子切换与自动回滚。安装包内置 Harness 始终作为最终恢复基线。设置 schema 只保存可选仓库覆盖值，切换仓库会使旧候选失效并清空界面中的候选/待安装版本和进度，当前运行版本不变；诊断导出不包含仓库地址。
- 仓库候选与正式打包共用生产 deploy helper，不把完整源码 checkout 当作安装目录；CLI 入口和版本按 `bin.dsh` 声明识别。桌面扩展随传递依赖装配，核心 peer 由新 Harness 提供；市场和搜索扩展适配公共设置服务的新接口，未知模型路由不盲猜。工作台跨启动代次导航前仅重置受管 Harness 认证 Cookie，避免未经桌面补丁处理的仓库积累旧 Cookie；同代次设置切换不清理页面数据。详见 ADR-015。
- macOS 仓库 HTTP(S) 检查和克隆在没有显式环境代理时，通过 CFNetwork 按仓库 URL 继承系统静态代理与绕过规则；不修改全局 Git 或网络设置。Git 配置优先，PAC、SSH 和 Windows/Linux 保持既有行为。仓库检查超时单独提示网络/代理原因，并终止 Git 辅助进程。
- 清单反回放在检查阶段只做校验，接受记录直到制品真正暂存成功才落盘；「恢复内置 Harness」同时清除接受历史，使撤回后同版本换 commit 重新签发仍可安装。
- 待安装 Harness 的激活 smoke 与自动检查在后台线程串行执行，不占用驱动窗口的线程；激活期间对外发布 `applying` 状态。工作台首次启动与后台维护共享一次性激活门闩，确保完成 pending 校验和原子切换后才拉起服务，避免实际运行版本与 current 指针不一致。
- 签名清单请求使用 30 秒预算，与制品下载的 20 分钟预算分离，避免更新服务停滞长时间占用更新操作锁。

## 版本基线

- 项目默认和文档示例版本：`1.0.0`；真实发行版本由 Git tag 或发布环境注入。
- Node：`24.20.0`（四平台精确锁定，module ABI `137`）
- pnpm：`11.24.0`
- Rust：`1.98.0`
- Tauri CLI：`2.11.4`
- Harness 固定来源、commit 和制品校验和以 `harness/toolchain-lock.json` 为准，不在本文件重复维护。

## 发行目标

- macOS arm64 / x64
- Windows x64
- Linux x64

未经对应平台真实构建和运行验证，不得将目标矩阵写成已验收平台列表。
