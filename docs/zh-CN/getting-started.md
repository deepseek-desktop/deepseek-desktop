# DeepSeek Desktop

DeepSeek Desktop 是内置锁定版本本地 Runtime 的独立、非官方社区桌面发行版。它将 Vue 桌面 Shell、Tauri 2 原生主程序、固定版本 Node.js 和构建时锁定的 Runtime 打包在一起，不依赖其他框架应用，也不要求用户预装 Node.js、pnpm 或 Rust。本项目与 DeepSeek 不存在隶属、合作或官方背书关系。

桌面 Shell、应用程序和安装包统一使用固定上游提交中的侧边栏鱼形标识及其深色品牌墨色，仅用于识别内置 Runtime，不代表官方发行或品牌授权。

源码默认和文档示例版本固定为 `1.0.0`，实际发行版本以 GitHub Releases 为准。社区版可在本地完整使用；macOS 使用不关联开发者身份的 ad-hoc 完整签名，尚未完成 Apple Developer ID 签名、公证或 Windows Authenticode 签名，桌面安装包自动更新也未启用，因此不能作为已认证 Stable 版本宣传。Runtime 独立更新只会在发行版预置可信签名清单与公钥时启用。

工程源码位于仓库根目录。`runtime/toolchain-lock.json` 固定 Node、Rust、原生依赖、桌面补丁和发布允许的 Runtime 来源；`runtime:sync` 在本地开发且 `RUNTIME_REF` 为空时自动选择 Runtime 仓库最新的 SemVer 版本标签，显式填写时使用指定来源，随后统一解析为不可变 commit。社区版和正式发布还必须匹配仓库内经过审计的固定 Runtime 提交，避免可变标签在无人复核时改变发行内容。同步结果写入当前构建专用的 `target/generated/runtime-lock.json`。Runtime 使用该 lock 组装生产依赖闭包、下载并校验 Node.js 官方归档后生成 sidecar；每个平台制品同时包含确定性 Runtime manifest、完整许可证清单和 SPDX 2.3 SBOM。

## 支持平台

| 平台 | 构建产物 | 当前验收口径 |
| --- | --- | --- |
| macOS arm64 | `.dmg` | 本机完整构建与运行验收 |
| macOS x64 | `.dmg` | CI 原生构建，等待对应机器安装验收 |
| Windows x64 | NSIS `.exe` | CI 原生构建；已在 Windows 11 ARM64 的系统 x64 兼容层完成安装、启动、退出、卸载与重装验收 |
| Linux x64 | AppImage / `.deb` | CI 原生构建，等待对应发行版安装验收 |

当前社区版产物名称和发布说明必须明确带有 `community` / `unsigned`；其中 macOS 的 `unsigned` 表示没有 Apple Developer ID 身份签名和公证，不代表应用 Bundle 缺少本地 ad-hoc 完整性签名。社区版不能作为已认证 Stable 版本对外宣传。

## 开始使用

1. 启动 DeepSeek Desktop。主程序会自动启动本地 Runtime，在 `127.0.0.1` 上申请随机端口，并在就绪后直接进入当前窗口中的工作台。
2. 无需点击启动、预先选择目录、填写端口或打开第二个窗口；界面语言可随时在同一窗口的“设置”中切换。
3. 打开工作台的模型设置，选择 Provider，并写入 API Key 或 OAuth grant。
4. 在工作台中按会话需要添加或切换项目目录，再创建会话并开始任务。模型未配置或外部 Provider 不可用时，Runtime 仍可进入设置和诊断页面，但真实模型请求不会被伪造成成功。

## 模型与插件

模型设置同时支持官方 Provider 和 OpenAI Compatible 自定义 Provider。自定义 Provider 至少需要填写唯一 ID、API 地址、协议和密钥；保存前可先获取模型目录，保存后可在会话输入区切换模型。Provider ID、API 地址和模型名输入框已关闭自动纠错与首字母大写，输入内容不会被系统改写。

联网搜索默认跟随当前会话使用的模型。添加 Provider 时无需配置联网搜索协议；Runtime 会根据模型 API 协议自动匹配标准搜索协议，并复用已经保存的 API 地址、模型和凭据引用。切换模型后，下一次搜索同步切换；无法可靠识别的非标准接口会给出可操作提示，正常对话仍可继续，也不会为了猜测协议向接口发送额外请求。Provider 开发者和高级用户可查看[跟随当前模型的联网搜索](runtime-web-search.md)。

社区版内置 DSH Market 和固定版本 pnpm。打开“设置 → 插件”即可浏览插件市场并完成安装、更新或卸载，不需要额外安装 Node.js、pnpm 或手动编辑 profile。Runtime 每次启动会合并桌面内置 Bundle 和用户插件配置，已经安装的插件与自定义依赖不会被初始化流程覆盖。

插件来自独立开发者。安装前应查看插件来源、许可证和权限说明，不要安装来源不明或要求超出任务所需权限的插件。

Desktop 不保存、选择或注册项目目录。项目目录完全由 Runtime 工作台自身管理，Desktop 与 Runtime 只通过本地服务启动地址、健康状态和凭据协议连接；上游调整工作区接口时不需要同步修改桌面启动流程。

模型凭据由桌面专用 Credential Provider 写入本机加密凭据库。macOS、Windows 和 Linux 使用同一套 XChaCha20-Poly1305 认证加密、跨进程文件锁和原子写入机制，不访问系统钥匙串，也不会弹出系统凭据授权窗口。凭据库不可用或损坏时会明确失败，不会降级写入 `.credentials.yaml`、`.env`、日志、浏览器存储或其他明文文件。新增自定义 Provider 时，如果凭据写入失败，桌面 Runtime 会回滚本次新增的 Provider 配置，修复凭据库后可以直接重试，不会把失败的首次提交误报为 Provider ID 重复。

Desktop Shell 完整提供简体中文、繁体中文和英文，窗口顶部菜单标题也会随语言同步切换。当前锁定 Runtime 的上游界面只提供 `zh` 和 `en`：启动 Runtime 时，桌面语言桥会将简体中文和繁体中文映射为上游中文，将英文映射为上游英文，并通过原子更新 `dsh/settings.yaml` 保留其他设置与注释。繁体中文用户看到的工作区仍是上游简体中文；工程不会为了制造“全繁体”表象而直接改写上游构建产物。

桌面端只创建一个操作系统窗口。Runtime 就绪后，受管工作台作为无 Tauri 权限的隔离子 WebView 使用固定菜单栏下方的全部区域，不再保留重复的 Logo、状态和管理按钮。macOS、Windows 与 Linux 都在窗口内容区顶部左侧显示唯一的“文件 / 编辑 / 视图 / 窗口 / 帮助”菜单标题，展开项由 Tauri 弹出对应平台的原生菜单；菜单属于稳定 Desktop Shell，不向 Runtime 页面注入脚本或开放 IPC。macOS 系统菜单栏只保留系统要求的最小应用菜单，Windows/Linux 不挂载第二套完整窗口菜单。“设置”、诊断、Desktop 更新、Runtime 更新和关于都在当前窗口的设置层中显示。打开设置只会隐藏工作台，关闭或按 `Esc` 会恢复原来的工作台页面、对话和工作区，不重启 Runtime。应用退出时会保存窗口位置、尺寸、最大化和全屏状态，再次打开时优先恢复到上次使用的显示器；原外接屏仍连接时保留原位置，外接屏已断开时自动居中到当前可见显示器。工作台输入框和可编辑区域会关闭系统拼写检查、自动纠错、自动首字母大写和写作建议，确保 Provider ID、API 地址、模型名、代码和普通对话均按原文输入，不被 WebView 擅自替换。该策略只设置浏览器输入属性，不读取或改写输入值。

关于页面会显示构建版本、Runtime、作者和项目仓库。开发者可以通过 `.env` 的 `DESKTOP_APP_AUTHORS` 自定义作者，通过 `DESKTOP_APP_REPOSITORY` 自定义公开仓库地址；仓库地址留空时，GitHub Actions 使用当前工作流仓库地址，本地开发优先读取公开的 Git `origin`，本机路径类型的 `origin` 会回退到 `package.json` 或项目内置地址。

## Runtime 生命周期

Runtime 状态包括 `idle`、`starting`、`ready`、`stopping`、`recovering` 和 `failed`。启动超时为 45 秒；意外退出后最多自动恢复两次，超过上限后进入失败页，并生成诊断关联编号。

主程序退出时会关闭完整 Node/Runtime 进程树：macOS 和 Linux 使用独立进程组，并由 Runtime 监控桌面父进程是否仍存活；Windows 使用带 `KILL_ON_JOB_CLOSE` 的 Job Object。即使桌面主进程异常消失，Runtime 也会自行结束。工作台页面只能访问当前受管回环 Origin，不获得 Tauri shell、文件系统或通用 IPC 权限。

## 数据目录

DeepSeek Desktop 使用系统应用数据目录，不向安装目录写运行数据：

| 内容 | 说明 |
| --- | --- |
| `settings.json` | Shell 语言、桌面更新与 Runtime 独立更新设置 |
| `dsh/` | Runtime profile、会话、设置和插件数据 |
| `runtime-workdir/` | Runtime 进程的独立内部工作目录，不代表用户项目目录 |
| `credential-vault.json` | XChaCha20-Poly1305 加密后的模型凭据和 record 索引，不包含可读明文 |
| `credential-vault.key` | 当前用户专用的本地凭据库密钥；Unix 权限固定为 `0600` |
| `credential-session.json` | 仅保存当前 Runtime 短期授权 token 的 SHA-256 摘要，不保存 token 或模型凭据 |
| `logs/` | 10 MB 单文件、最多 5 个轮转文件 |
| `backups/` | 设置更新前的最近备份 |
| `diagnostics/` | 用户主动导出的脱敏诊断文档 |
| `updates/runtime/` | Runtime 下载 staging、版本目录和原子切换指针；不包含模型凭据 |

macOS 默认位于 `~/Library/Application Support/deepseek.desktop/`；Windows 和 Linux 使用 Tauri 对应的平台应用数据目录。

加密凭据库以当前操作系统用户的数据目录权限作为本地信任边界：它可以避免密钥以明文出现在配置、日志、诊断或备份预览中，也不会触发反复授权弹窗；但已经控制同一操作系统用户账户的恶意程序或获得文件读取权限的 Agent 工具仍可能读取凭据库密钥和密文。不要在多人共用同一系统账户的设备上保存生产密钥，也不要向不可信任务授予应用数据目录访问权限。

开发者执行隔离启动验收时可以临时设置 `DEEPSEEK_DESKTOP_DATA_DIR`，把测试数据写入指定目录。正式启动无需设置该变量，默认目录会自动创建，不增加用户配置负担。

## 诊断与隐私

诊断页面只在用户主动操作时导出内容。“导出日志”生成便于直接查看的脱敏纯文本日志，“导出诊断包”生成包含状态、版本和最近日志摘要的 JSON 文档。两种导出都会遮蔽 Authorization、API Key、Cookie、password、secret、Bearer token 和本机路径。Credential Provider 调用 helper 时还必须携带每次 Runtime 启动生成的短期会话；真实 token 只通过 Runtime 标准输入交付，应用数据目录仅保存用于校验的 SHA-256 摘要，不进入命令参数或日志。Runtime 启动后会从自身环境中移除 Helper 路径、数据目录和短期会话，避免普通工具子进程通过继承环境直接调用 Helper；工作台 WebView 也没有 Tauri 文件系统或通用 IPC 权限。这些措施用于减少意外泄漏，不构成对同一操作系统用户下任意代码执行的安全隔离。

出现启动失败时依次检查：

1. 诊断编号和导出的脱敏日志中是否出现 `runtime-artifact-missing`、`runtime-workdir-unavailable`、`runtime-timeout`、`runtime-exited` 或 `restart-limit-reached`。
2. 应用数据目录是否可读写、是否被安全软件隔离或损坏。
3. 外部模型 Provider 的地址、模型名、账号权限和网络是否可用。

## 更新与卸载

桌面安装包和 Runtime 使用两条独立更新链路。Desktop 启动后每天最多静默检查一次自身版本，也可从“帮助 → 检查 Desktop 更新”手动检查。社区版只读取构建时固定的官方 GitHub 仓库 Release 列表，按完整 SemVer、发布时间及五个平台安装包完整性选择候选；发现新版后显示版本、时间与摘要，可选择前往官方 Release、稍后提醒或忽略该版本。当前社区版未签名，因此不会自动下载安装，也不会使用远端提供的任意下载地址。

Runtime 更新可在“设置 → 更新 → Runtime 独立更新”中选择“自动下载并在下次启动安装”“发现后提醒”或“仅手动检查”，也可以固定当前版本。只有发行版内置了可信 Runtime 清单地址、公钥和发布者身份时该功能才会启用；默认社区配置不连接更新服务。下载的新 Runtime 会在应用数据目录中完成 SHA-256、签名、平台与协议校验，启动 smoke 通过后才切换；失败会保留当前版本并自动回滚，用户也可随时恢复安装包内置 Runtime。更详细的维护与离线恢复说明见 [Runtime 独立更新指南](runtime-updates.md)。

卸载应用不会自动删除 Runtime 工作台管理的项目目录或应用数据。需要完全清理时，先卸载 DeepSeek Desktop，再由用户主动删除系统应用数据目录。新版只使用社区版内置的本地加密凭据库，不访问系统钥匙串。

## 开发者验证

完整构建命令、Runtime lock、测试入口和发行门禁见仓库根目录 `README.md`。本地验证至少包括三语 parity、语言桥保真测试、Vue 单测、Playwright Shell E2E、Rust 单测、Runtime manifest 校验、真实 Runtime readiness smoke 和目标平台安装包构建。连续启停验收使用 `DEEPSEEK_DESKTOP_SMOKE_CYCLES=100 corepack pnpm@11.24.0 runtime:smoke`。

需要主动生成当前电脑对应的桌面安装包时，在仓库根目录执行：

```bash
corepack pnpm@11.24.0 package:community
```

该命令会自动安装锁定依赖，执行应用配置与 Runtime 同步、社区版发行门禁、单元测试、端到端测试、Runtime 校验和真实 readiness smoke，再构建当前操作系统及 CPU 架构对应的安装包。结果统一输出到 `release/<版本>/<目标平台>/`，同时生成 `BUILD-INFO.<目标平台>.json` 和 `SHA256SUMS`。macOS 构建先由 Tauri 生成 `.app`，再通过不依赖 Finder 或 AppleScript 的 `hdiutil` 创建 DMG，避免无界面构建机因窗口美化流程阻塞。

单台电脑只生成当前平台安装包。默认和示例版本始终使用 `1.0.0`。维护者推送符合 SemVer 的标签后，GitHub 工作流会从标签注入真实发行版本；标签可带或不带 `v` 前缀，例如 `1.0.0`、`v1.0.0`、`v0.1.0-community.13`。完整 SemVer 校验会在构建开始时执行，随后分别构建 macOS arm64、macOS x64、Windows x64 和 Linux x64；只有全部成功才会创建包含安装包和 `SHA256SUMS` 的 GitHub Release。
