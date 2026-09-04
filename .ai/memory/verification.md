# 验证基线

## 最近可信验证

日期：2026-09-04

## Harness 仓库候选更新失败

- 已在本机安装的 `v1.0.30` 实际执行准备操作：默认仓库候选 `76fda729799f` 下载、依赖安装和构建完成，但 smoke 在 readiness 前退出；未生成待切换版本，当前内置 `cd5ef8148158` 保持不变。
- 保持统一窗口菜单的本地 `1.0.0` 成品重新通过真实设置按钮执行同一候选准备，仍在 smoke 阶段报 `Runtime smoke closed stdout before readiness`。应用明确显示准备失败，暂存目录自动清理，版本目录为空，未创建 current/pending 指针；运行状态保持已就绪，并可返回原工作台。此次没有强行激活候选或替换已安装应用。
- 仓库内隔离复现发现桌面扩展复制未形成完整依赖闭包，先缺少 `yaml`，补入后又暴露上游 peer 依赖与 profile 中插件解析缺失。尚未修复或完成最新内核激活，不把构建成功当作热更新验收。

## macOS Runtime 仓库代理修复

- 安装版日志确认失败发生于 Git 仓库 HEAD 查询超时，尚未进入候选下载或构建。相同仓库在终端代理环境中约 0.95 秒成功，清除代理环境后 35 秒仍未返回；系统已配置静态代理，但 Finder 启动的 Git 未读取它。
- 修复后的 opt-in 真实仓库测试清除全部代理环境变量，并限制 PATH 为系统目录，1.17 秒成功解析默认仓库 HEAD。环境代理优先级、系统绕过规则、超时分类和辅助进程清理均有回归覆盖。
- `verify` 通过：85 项配置与发行协议测试、21 项 Vue 测试、19 项跟随模型搜索测试、87 项 Rust 测试（另 1 项真实联网测试默认忽略，已单独执行）、Clippy `-D warnings`、三语与 Runtime manifest 校验。`test:e2e` 2 项、`runtime:smoke`、`app:sync --check`、`runtime:sync --check` 与 `release:smoke` 均通过；测试后的生成配置已恢复默认应用标识与版本。
- macOS ARM64 隔离 debug `.app` 通过 Tauri 构建和 `codesign --verify --deep --strict`。使用 LaunchServices、独立应用标识和仓库内测试数据目录启动，实测进程未携带代理环境变量；应用自动检查发现 Runtime commit `76fda729799f`，工作台正常加载，关闭确认后退出。未覆盖用户安装的 `1.0.29`，未下载或激活候选 Runtime；后续发行验证见下节。
- 修复阶段没有 Windows/Linux 人工复测；macOS 静态代理适配不改变 Windows/Linux 既有 Git/环境代理行为。PAC 执行与 pnpm 依赖下载代理不在本轮变更范围。

## v1.0.30 发行验证

- 本机 `DESKTOP_APP_VERSION=1.0.30 corepack pnpm@11.24.0 desktop:package` 完整链路通过，耗时 5 分 24 秒；重新执行依赖准备、同步、`verify`、E2E、Runtime smoke、Tauri release 构建和 77377 文件交付扫描，构建来源为 `197f9410abcf5301ff8e327b9ebd0f366aa6e20d`、`dirty=false`。两份生产依赖 lock 审计均无已知漏洞。
- 本机构建的 ARM64 DMG 通过 `hdiutil verify` 和应用深度完整性签名检查，SHA-256 为 `4cc2e3c3acad8ac7a25181c89f0e26e24a57f6fbce547f2ad82fb58ccbe813bf`。使用 LaunchServices 启动构建目录中的 release `.app`，确认标题为 `v1.0.30`、进程无代理环境变量、工作台与既有会话正常加载；确认退出后 Desktop 与 Runtime 子进程均已结束。未覆盖本机安装的 `1.0.29`，未切换用户 Runtime。
- GitHub Actions Run `33845496695` 绑定上述 commit，六个 Job 全部成功：质量门禁 9 分 32 秒、macOS ARM64 14 分 20 秒、Linux x64 18 分 01 秒、Windows x64 30 分 25 秒、macOS x64 37 分 59 秒、聚合发布 46 秒，总墙钟 48 分 27 秒。四个平台日志均确认 Node `v24.20.0`，各自 E2E 2 项和 Runtime smoke 通过；Rust 测试为两种 macOS 各 87 项、Windows 82 项、Linux 83 项，各另有 1 项真实联网测试默认忽略。
- `v1.0.30` annotated Tag 精确指向上述 commit，Release 保持未签名 prerelease。重新下载全部六个公开资产，五个安装包均通过 `SHA256SUMS`，全部文件的大小、SHA-256 与 GitHub 服务端 digest 一致，正文直接下载链接与文件逐项匹配；没有公开 BUILD-INFO。下载的最终 ARM64 DMG 另经 `hdiutil verify` 通过，其摘要为 `81cd63e9ca2e77c8a1afbe3a339f6dba4277beae652478b3a39d91c181d60183`。
- 本次 macOS release 实测覆盖启动、工作台加载和确认退出；未重新完成全部菜单与输入编辑压力测试。Windows/Linux 本次证据是官方原生 Runner 的构建、测试和 smoke，不是人工桌面交互或安装器全流程验收。

## 既有验证基线

正式发布收敛为 GitHub Actions 官方托管 Runner 原生矩阵后：

- `corepack pnpm@11.24.0 app:sync --check`：通过，生成配置与源码一致。
- `corepack pnpm@11.24.0 runtime:sync --check`：通过，Runtime `0.1.2-alpha.1` 固定到 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，来源、CLI 入口、部署闭包和制品哈希与生成锁一致。
- `corepack pnpm@11.24.0 verify`：通过；配置与发行协议测试 80 项、Vue 测试 16 项、Rust 测试 74 项、Clippy `-D warnings`、3 个 locale / 155 个 key、凭据代理回归和 Runtime manifest 校验全部通过；另有 19 项跟随模型搜索测试覆盖自动协议映射、模型切换、多会话隔离、`CredentialRef` 继承、取消、超时、重定向和响应校验。新增回归覆盖菜单键盘访问、未关闭时的重复打开抑制、独立菜单 WebView 的保存语言和实时语言同步、Rust 原生菜单门闩，以及 macOS `TaoView.mouseMoved:` 空事件保护只丢弃空指针而转发正常事件。
- `corepack pnpm@11.24.0 audit --prod --registry=https://registry.npmjs.org` 与 Runtime 子目录同项审计：均通过，无已知生产依赖漏洞。
- `corepack pnpm@11.24.0 test:e2e`：通过 2 项 Playwright 测试；除 Shell 自动启动、语言切换和状态视图外，还在 `1000x700` 的 Windows 尺寸视口验证长 Runtime 设置表单可以滚动到最后一个操作按钮。
- `corepack pnpm@11.24.0 runtime:smoke`：通过父进程退出清理与 Runtime `0.1.2-alpha.1` 一次完整启停循环。
- `corepack pnpm@11.24.0 release:smoke`：通过分布式发布 HTTP 制品流式传输、校验与发布协议回归。
- Runtime 仓库设置回归：默认使用构建仓库；用户只保存一个可选仓库覆盖值，切换时会使旧待安装候选失效。配置迁移、地址校验、诊断脱敏、三语文案、Vue 与 E2E 单字段表单均已验证；维护者可选签名制品通道不进入普通用户设置。
- 当前源码最终门禁：`verify` 通过 85 项配置与发行协议测试、18 项 Vue 测试、19 项跟随模型搜索测试、81 项 macOS Rust 测试和 Clippy `-D warnings`；`app:sync --check`、`runtime:sync --check`、`test:e2e` 2 项、`runtime:smoke` 与 `release:smoke` 均通过。联网搜索协议未配置时继续按当前会话模型 `apiProtocol` 自动匹配，模型提供方表单不再要求用户选择协议。
- `DESKTOP_APP_VERSION=1.0.28-test.2 corepack pnpm@11.24.0 desktop:package`：当前 macOS ARM64 主机重新同步锁定 Runtime 并完成上述完整门禁、E2E、Runtime smoke、Tauri release 编译和 DMG 构建；`DeepSeek Desktop_1.0.28-test.2_aarch64.dmg` 经 `hdiutil verify`、`codesign --verify --deep --strict` 与原生 ARM64 检查通过，SHA-256 为 `d21a67634ad7134cff1a34c272e98d4b0d99648c2d165d7afe28bc58aa7b31fd`。
- macOS `1.0.28-test.2` 安装版通过 LaunchServices 从隔离安装目录启动并自动拉起内置 Runtime。输入框实测粘贴、复制、剪切、撤销、重做与清空均得到预期值，聊天记录拖选“解决方案”后 `Cmd+C` 得到相同文字；窗口编辑菜单显示六项原生命令及快捷键。五组菜单共完成 100 次打开/关闭，Desktop 与 Runtime 全程存活；同窗设置打开和关闭后仍返回原对话，关闭窗口先显示本地化确认，确认后两进程均无残留。本轮没有新增 DeepSeek Desktop `.ips` 崩溃报告。
- `v1.0.28` GitHub Actions 原生矩阵成功，Run `33732293678` 绑定 commit `471101c86de43cc5629c7ddc5a52e436b4538e6a`：质量门禁 10 分 01 秒、Linux x64 17 分 44 秒、macOS ARM64 19 分 43 秒、Windows x64 25 分 23 秒、macOS x64 44 分 44 秒、聚合发布 32 秒，工作流总墙钟 55 分 23 秒。Release 标题为 `v1.0.28`，保持未签名 prerelease；公开资产严格为两份 DMG、一个 EXE、一个 AppImage、一个 DEB 和 `SHA256SUMS`。清单中的五项 SHA-256 与 GitHub 服务端资产 digest 逐项一致，六个公开下载地址均返回 HTTP 200。
- `v1.0.29` GitHub Actions 原生矩阵成功，Run `33787636785` 绑定 commit `de6f88abd61486b93666ee5f187a671ef6dcb8b2`：质量门禁 8 分 29 秒、macOS ARM64 17 分 01 秒、Linux x64 17 分 25 秒、Windows x64 24 分 55 秒、macOS x64 38 分 04 秒、聚合发布 45 秒，工作流总墙钟 47 分 27 秒。Release 保持未签名 prerelease；公开资产严格为两份 DMG、一个 EXE、一个 AppImage、一个 DEB 和 `SHA256SUMS`。重新下载全部资产后，五个安装包的 SHA-256 均与清单及 GitHub 服务端 digest 一致；最终 ARM64 DMG 通过 `hdiutil verify` 和 `codesign --verify --deep --strict`，应用版本为 `1.0.29`，主程序为原生 `arm64`。
- 默认社区 Runtime 仓库与官方上游仓库的默认分支 HEAD 均解析为 `49a606bc5b5934603f22a26957a07dc799ab0291`。默认仓库使用应用内置 Node `24.20.0` / pnpm `11.24.0` 完成克隆、构建、CLI help 与带认证回环服务 smoke，候选 Runtime 版本为 `0.1.2-alpha.5`；未在验证日志中记录仓库凭据或用户 Provider 密钥。
- `DESKTOP_APP_VERSION=1.0.27-test.4 corepack pnpm@11.24.0 desktop:package`：当前 macOS ARM64 主机完成完整门禁和 DMG 构建；`DeepSeek Desktop_1.0.27-test.4_aarch64.dmg` 经 `hdiutil verify`、`codesign --verify --deep --strict` 与原生 `arm64` 检查通过，SHA-256 为 `8dd2c252c9d03cea6ed0796d9b0b06c8c70dfd51055acfddfc358bad5f18b926`。
- macOS `1.0.27-test.4` 安装版实测：标准启动后直接进入工作台，五组窗口菜单逐一打开且进程不退出；通过“文件”菜单打开同窗设置，更新页可完整滚动且只显示一个 Runtime 仓库地址；取消关闭确认后 Desktop 与 Runtime 保持运行，确认关闭后两者均退出且无残留。
- Windows 验证环境为 Parallels Windows 11 ARM64，运行项目的 x64 Node、Rust 目标和应用二进制，因此属于 Windows 系统真实交互加 x64 模拟，不等同原生 x64 硬件。当前提交使用锁定 Node `v24.20.0`、ABI `137` 和 Rust `1.98.0 (x86_64-pc-windows-msvc)` 验证：配置与发行协议测试共 85 项，其中 82 项通过、3 项因非提升权限无法创建符号链接而跳过；3 个 locale / 150 个 key、Vue 18 项、跟随模型搜索 19 项、26225 文件 Runtime manifest、Rust 79 项、Clippy `-D warnings` 与 Playwright E2E 2 项均通过。Runtime smoke 冷启动首次超过固定 20 秒，缓存就绪后 2 个连续启停循环在 8 秒内通过。
- Windows x64 release 应用使用当前提交重新编译并包含 `deepseek-desktop.exe`、Node sidecar 和 Runtime 闭包；NSIS 安装包由 GitHub `windows-2022` 原生 Runner 构建并通过正式矩阵。使用 Windows 当前用户会话启动本机编译的 x64 release 应用后，工作台正常显示首次模型配置界面，没有空白页或 `Failed to load plugins`；通过 UI Automation 逐一展开“文件 / 编辑 / 视图 / 窗口 / 帮助”，Desktop 进程均保持存活。
- `node scripts/with-rust.mjs tauri build --config target/generated/tauri.conf.json --bundles app`：通过，生成 macOS ARM64 `.app`，`codesign --verify --deep --strict` 通过。
- `DESKTOP_APP_VERSION=1.0.23 corepack pnpm@11.24.0 desktop:package`：在当前 macOS ARM64 主机使用锁定 Node `24.20.0` 和 pnpm `11.24.0` 完成 Runtime 同步、完整 `verify`、E2E、Runtime smoke、Tauri 应用和 DMG 构建；产物 `DeepSeek Desktop_1.0.23_aarch64.dmg` 经 `hdiutil verify` 验证，SHA-256 为 `906bd2397d0349954fbfe0a15e6309c437f61892dab89c427f2957040bf31aab`。
- 成品应用真实安装与启动：从 `1.0.23` macOS ARM64 DMG 挂载复制 `.app` 到独立临时安装目录，`codesign --verify --deep --strict` 通过，Mach-O 为原生 `arm64`，`CFBundleShortVersionString` 与 `CFBundleVersion` 均为 `1.0.23`，并通过标准 LaunchServices 启动。应用直接进入 Harness 工作台并自动拉起内置 Node `24.20.0` 与 Runtime `0.1.2-alpha.1`。
- macOS 窗口菜单实测：标题栏安全区下方固定显示唯一“文件 / 编辑 / 视图 / 窗口 / 帮助”，工作台从菜单栏下方完整铺开；系统菜单栏只保留最小应用菜单。通过窗口“文件”菜单进入同窗设置，再用关闭按钮返回工作台，Runtime PID 全程保持 `97537`，工作台子 WebView 未重建。
- macOS 菜单重入回归：修复前使用辅助功能连续触发窗口菜单会在 AppKit `_NSPopUpMenu` / `objc_storeWeak` 路径产生 `SIGABRT`。修复后对安装版同一“文件”菜单连续执行两次成功的 `AXPress`，Desktop PID 保持 `97528`；关闭弹出菜单后仍可正常打开设置，完整验收结束后没有新增 `.ips` 崩溃报告。Vue 待完成保护负责减少重复 IPC，Rust 进程级 RAII 原子门闩负责跨 WebView 拒绝原生菜单循环重入。
- macOS 菜单崩溃根因复核：`1.0.24-test.2` 通过 LaunchServices 标准启动后再次产生 `EXC_BAD_ACCESS` / `SIGSEGV`；主线程栈为 `objc_loadWeakRetained` -> Tao `mouse_motion` / `mouse_moved` -> AppKit `_routeMouseMovedEvent`。后续对 Tao `0.35.3` 源码和 Objective-C 对象状态的复核推翻了“空 `NSEvent`”结论：事件对象有效，但 `TaoView.taoState` 已为空，Tao 仍把它当作 `ViewState` 并从地址零读取首字段 `ns_window`。只改变菜单弹出位置不足以消除该状态竞争；菜单命令没有主动退出应用。
- macOS 窄范围修复：Desktop 初始化时替换锁定 Tao `0.35.3` 的纯事件投递处理器；`TaoView.taoState` 缺失时丢弃事件，状态存在时调用原 Tao 实现。`viewDidMoveToWindow`、`resetCursorRects`、`frameDidChange:` 等生命周期、布局和 tracking rect 回调始终保留；类、方法或实现契约不存在时拒绝启动。该保护仅在 macOS 编译，Windows/Linux 菜单路径不变。
- `DESKTOP_APP_VERSION=1.0.24-test.3 corepack pnpm@11.24.0 desktop:package`：使用 Node `24.20.0` / pnpm `11.24.0` 完成 Runtime 同步、完整 `verify`、E2E、Runtime smoke、Tauri 发布编译和 DMG 构建；`DeepSeek Desktop_1.0.24-test.3_aarch64.dmg` 经 `hdiutil verify` 通过，SHA-256 为 `097818dead790baf4ed36c3aacaa854e2a5e4d1278048715707ea9200deae6db`。应用经 `codesign --verify --deep --strict` 通过，主程序与内置 Node 均为原生 `arm64`，应用版本为 `1.0.24-test.3`，内置 Node 为 `v24.20.0`。
- `1.0.24-test.3` 成品实测：从 DMG 挂载复制到独立临时安装目录并通过 LaunchServices 启动，Runtime sidecar 正常运行；“文件 / 编辑 / 视图 / 窗口 / 帮助”共完成 150 次原生菜单打开与关闭，Desktop 与 Runtime 全程存活。随后实际打开同窗设置、返回工作台、执行视图命令、取消关闭确认并确认退出，均正常完成，验收期间没有新增 `deepseek-desktop-*.ips`。
- macOS 关闭行为实测：点击原生关闭按钮会显示“取消 / 关闭”确认对话框；取消后 Desktop PID `97528` 与 Runtime PID `97537` 均继续运行，确认后两者均退出且无进程残留。
- Desktop 更新实测：GitHub REST API 因共享出口限流返回失败时，客户端只回退读取同一构建时官方仓库的 `releases.atom`；受信任解析器识别到完整 `1.0.20` Release，更新弹窗、发布说明和下载入口正常，Runtime PID 未变化。
- 崩溃边界复核：一次旧测试曾直接执行 `.app/Contents/MacOS` 内部二进制并注入伪造 `HOME`，Tauri 在应用路径初始化阶段主动终止；该方式不是用户安装或 Finder 启动路径，后续安装验收禁止内部二进制直启。标准启动后的菜单辅助功能测试先后暴露了 AppKit 菜单重入和 Tao 空视图状态两条独立崩溃路径，现分别由 Vue 调用抑制、Rust 原生菜单门闩和 macOS Tao 视图状态防护覆盖，并按相同触发方式复测。
- GitHub 工作流协议：Pull Request 与普通分支 push 不触发发布工作流；完整 SemVer Tag 才执行质量门禁并启动 macOS ARM64、macOS x64、Windows x64、Linux x64 原生矩阵。结构化汇总器只接受四份来源一致的内部构建信息，公开 Release 只输出五个安装包与统一 `SHA256SUMS`。
- `v1.0.18` 因跨平台生成 CSS 模块摘要不一致而在质量门禁失败，`v1.0.19` 因 Intel macOS Runner 下载 Node 工具链超时而失败；两次均未创建不完整 Release，旧 Tag 未移动。修复后使用新 Tag `v1.0.20` 恢复。
- `v1.0.20` GitHub Actions 原生矩阵成功，Run `33488866877` 绑定 commit `d41fca2f8db423c587d0a2972f759b1619039440`：质量门禁 9 分 07 秒、Linux x64 14 分 54 秒、macOS ARM64 16 分、Windows x64 28 分 08 秒、macOS x64 53 分 14 秒、发布 59 秒，工作流总墙钟约 1 小时 03 分 28 秒。
- `v1.0.20` Release 为未签名 prerelease，公开资产严格为两份 DMG、一个 EXE、一个 AppImage、一个 DEB 和 `SHA256SUMS`。下载后执行 `shasum -a 256 -c SHA256SUMS`，五个安装包全部返回 `OK`；六个正文直达下载链接均经 GitHub 重定向后返回 HTTP 200，Release 正文无需依赖 `Assets` 展开状态。
- `v1.0.21` 的 Linux 质量门禁发现 macOS 专用 `APP_NAME` 常量缺少条件编译，Clippy `-D warnings` 以 dead code 拒绝构建；原生矩阵和发布任务均未启动，未创建不完整 Release。旧 Tag 保持不变，修复使用新的不可变 Tag。
- `v1.0.24` 发布前独立复核（`41d61a5`）：`app:sync --check`、`runtime:sync --check`、`verify` 12 阶段（80 配置 / 155 键 × 3 locale / 16 Vue / 19 跟随模型搜索 / 73 Rust / Clippy `-D warnings`）、`test:e2e` 2 项、`runtime:smoke` 与 `desktop:package` 全部通过；产物 BUILD-INFO 记录 commit `41d61a5`、`dirty=false`、闭包扫描 77369 个文件、工具链与 lock 一致。
- `v1.0.24` 成品 DMG 本机验收：SHA256SUMS 校验通过，`codesign --verify --deep --strict` 通过，主二进制原生 `arm64`，窗口标题含版本号；LaunchServices 启动后自动拉起 Runtime sidecar，窗口内菜单栏正确渲染「文件 / 编辑 / 视图 / 窗口 / 帮助」；多轮菜单交互尝试期间 Desktop 与 Runtime PID 均未变化，`~/Library/Logs/DiagnosticReports` 中 DeepSeek 崩溃报告保持 5 份未增加；退出后 app 与 Runtime 进程均归零。
- `v1.0.24` 发布前的菜单交互未触发延迟空事件，因而不能证明崩溃路径已清除；后续 `1.0.24-test.2` 标准启动崩溃推翻了此前只依赖弹出位置的修复结论。当前可信回归以 `1.0.24-test.3` 的空事件保护和上文成品压力测试为准。
- `v1.0.24` GitHub Actions 原生矩阵成功，Run `33546669378` 绑定 commit `41d61a5`：`shell-quality` 与四个 `native-build`、`publish-release` 六个 Job 全部成功。Release 为未签名 prerelease，公开资产严格为两份 DMG、一个 EXE、一个 AppImage、一个 DEB 和 `SHA256SUMS`；正文六条直达下载链接与当前 Tag 一致；抽检下载托管的 Windows 安装包，实测 SHA-256 与清单逐字一致、大小 58335442 相符。
- `v1.0.25` 的 macOS x64 目标在 `runtime:sync` 阶段失败：从本地镜像克隆缓存检出时 git 默认硬链接 `.git/objects`，与镜像自身的 commit-graph 维护竞争，报 `hardlink different from source`。该竞态与平台无关，其余三个平台成功、`publish-release` 正确跳过，未创建不完整 Release，旧 Tag 未移动。
- 该克隆改用 `--no-hardlinks`（与工作流中 Windows 短路径克隆一致），并在本机删除缓存检出触发真实重新克隆后验证：`runtime:sync --check` 通过、检出重建成功；新增源码契约测试锁定该参数。
- `v1.0.26` 发布前本机复核（`2bded62`）：`verify` 12 阶段（81 配置 / 155 键 × 3 locale / 16 Vue / 19 跟随模型搜索 / 74 Rust / Clippy `-D warnings`）、`test:e2e` 2 项、`runtime:smoke`、`desktop:package` 全部通过；BUILD-INFO 记录 commit `2bded62`、`dirty=false`、闭包扫描 77369 个文件。成品 DMG 校验和一致、`codesign --verify --deep --strict` 通过、主二进制原生 `arm64`、启动后自动拉起 Runtime sidecar、退出无残留、无新增崩溃报告。
- `v1.0.26` GitHub Actions 原生矩阵成功，Run `33592751008` 绑定 commit `2bded62`：六个 Job 全部成功。Release 标题为 `v1.0.26`（改为直接使用 Tag），未签名 prerelease，公开资产严格为两份 DMG、一个 EXE、一个 AppImage、一个 DEB 和 `SHA256SUMS`；正文六条直达下载链接与当前 Tag 一致；抽检下载托管的 Windows 安装包，实测 SHA-256 与清单逐字一致、大小 58351737 相符。
- macOS 视图菜单崩溃路径在本轮**未**由本会话独立复现清除：合成点击无法使 NSMenu 弹出保持到可采样（已在两块显示器上确认无弹出），F10 疑被系统媒体键拦截，WebView 内容未暴露在辅助功能树中。该结论仍以上文 `1.0.24-test.3` 的 150 次五组菜单开关压力测试为准。

## 已闭环崩溃来源

- macOS 历史崩溃报告中的弱引用致命中止共观察到三个来源，已分别处理：
  - 菜单弹出经 `NSMenu popUpMenuPositioningItem:atLocation:inView:` 传入视图，`_NSPopUpMenu` 对其建立弱引用。仅在 `1.0.23` 出现，改为按光标位置弹出后未再复现。
  - `-[NSWindow _setFirstResponderIvar:]` 对正在释放的响应者建立弱引用，由菜单弹出或界面切换期间的 `set_focus()` 触发。在 `1.0.26` 全屏进出压力过程中观察到一次；这些过渡本身不依赖主动聚焦，因此已删除对应调用，只保留第二实例激活现有窗口时的系统聚焦语义。源码契约测试锁定菜单和 Runtime surface 切换不再调用 `set_focus()`。
  - `___NSViewUpdateConstraints_block_invoke` 路径，由一次过宽的 `TaoView` 防护引入：丢弃 `viewDidMoveToWindow` 与 `resetCursorRects` 会留下陈旧 tracking rect。防护收窄后消失，已由用例锁定边界。
- 当前安装版按相同高风险区域执行 100 次菜单开关、设置往返、输入编辑和关闭确认后没有生成新崩溃报告；该证据证明 Desktop 已移除已知主动聚焦触发点，不等同于承诺 AppKit、WebKit 或 Tao 内部不会出现其他未知崩溃。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端、本机 Runtime 启停链路与 macOS ARM64 安装版可运行；macOS 系统菜单、设置覆盖层、会话保持、关闭确认、Desktop 更新和外部文档打开已实测。Windows 11 ARM64 虚拟机中的 x64 应用模拟已覆盖工作台启动、Runtime sidecar、设置滚动、五组菜单与关闭确认，但不能替代 Windows x64 原生硬件安装器验收；Linux 原生应用仍未人工启动。
- 本轮未写入或使用任何真实 Provider API 密钥，也未向外部搜索端点发起新的真实搜索请求；联网搜索使用匿名本地模拟 Provider 验证协议路由、结果归一化和凭据隔离。普通用户无需选择搜索协议；内置映射会按当前模型 API 协议自动路由，非标准接口仍需要 Provider 自身声明可信能力。
- 本机结果不等于 Apple 公证、Windows 发布者签名，或 macOS x64、Windows x64 原生硬件、Linux x64 真机安装验收；正式 Tag 仍必须由对应 GitHub 官方 Runner 原生构建并通过制品核验。社区制品仍未签名、公证，因此保持 prerelease 且自动更新关闭。
- GitHub 站点自身控制 `Assets` 的折叠状态，仓库无法强制默认展开；可控且已验证的产品入口是 Release 正文中的平台直达下载链接。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。

## 工作台插件 bundle 失效（已闭环）

`/plugins/??<模块列表>&rev=<哈希>` 的 `rev` 是插件集合内容哈希，不是每次启动的随机数。实测：

- 同一 profile 连续两次启动，`rev` 稳定为 `d2f23e9786ce`，旧 URL 向新实例请求返回 200。
- 从 profile `dsh.profile.bundles` 移除 `dshmarket` 后 `rev` 变为 `7d4ed138d5fd`，旧 `rev` 返回 **HTTP 404 / 0 字节**，新 `rev` 返回 200。

因此失效条件是「插件集合变化 + 上一代工作台页面仍在」，Runtime 更新和恢复内置基线都满足。修复按 Runtime 启动代次记账工作台页面，重启后回到工作台强制重新导航；仅比对 Origin 无法覆盖重启复用同端口的情况。

另一路实机故障来自 WebKit 的 Cookie 作用域：Runtime 每次随机端口启动生成新的 `dsh-auth-*` Cookie 名称，但这些 Cookie 均属于 `127.0.0.1`，会被发送给后续端口。累计请求头接近 Node 16 KiB 默认上限时，短页面请求仍返回 200，约 3 KiB 的 `/plugins/??...` 请求先返回 **HTTP 431 / 0 字节**。Runtime smoke 现在预置 60 个旧会话 Cookie，验证令牌交换只保留当前 Cookie，并实际请求 HTML 引用的全部插件脚本；修复后的脚本请求均返回 2xx JavaScript。
