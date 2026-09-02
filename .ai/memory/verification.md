# 验证基线

## 最近可信验证

日期：2026-09-02

正式发布收敛为 GitHub Actions 官方托管 Runner 原生矩阵后：

- `corepack pnpm@11.24.0 app:sync --check`：通过，生成配置与源码一致。
- `corepack pnpm@11.24.0 runtime:sync --check`：通过，Runtime `0.1.2-alpha.1` 固定到 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，来源、CLI 入口、部署闭包和制品哈希与生成锁一致。
- `corepack pnpm@11.24.0 verify`：通过；配置与发行协议测试 80 项、Vue 测试 16 项、Rust 测试 74 项、Clippy `-D warnings`、3 个 locale / 155 个 key、凭据代理回归和 Runtime manifest 校验全部通过；另有 19 项跟随模型搜索测试覆盖自动协议映射、模型切换、多会话隔离、`CredentialRef` 继承、取消、超时、重定向和响应校验。新增回归覆盖菜单键盘访问、未关闭时的重复打开抑制、独立菜单 WebView 的保存语言和实时语言同步、Rust 原生菜单门闩，以及 macOS `TaoView.mouseMoved:` 空事件保护只丢弃空指针而转发正常事件。
- `corepack pnpm@11.24.0 audit --prod --registry=https://registry.npmjs.org` 与 Runtime 子目录同项审计：均通过，无已知生产依赖漏洞。
- `corepack pnpm@11.24.0 test:e2e`：通过 2 项 Playwright 测试；除 Shell 自动启动、语言切换和状态视图外，还在 `1000x700` 的 Windows 尺寸视口验证长 Runtime 设置表单可以滚动到最后一个操作按钮。
- `corepack pnpm@11.24.0 runtime:smoke`：通过父进程退出清理与 Runtime `0.1.2-alpha.1` 一次完整启停循环。
- `corepack pnpm@11.24.0 release:smoke`：通过分布式发布 HTTP 制品流式传输、校验与发布协议回归。
- Runtime 更新源设置回归：官方档案保持默认；自定义档案原子绑定签名清单 URL、Runtime 仓库身份、发布者与 Ed25519 公钥。配置、来源切换、候选失效、缺失字段禁用且不跨源回退、诊断脱敏、三语文案和 E2E 表单均已验证。
- `node scripts/with-rust.mjs tauri build --config target/generated/tauri.conf.json --bundles app`：通过，生成 macOS ARM64 `.app`，`codesign --verify --deep --strict` 通过。
- `DESKTOP_APP_VERSION=1.0.23 corepack pnpm@11.24.0 desktop:package`：在当前 macOS ARM64 主机使用锁定 Node `24.20.0` 和 pnpm `11.24.0` 完成 Runtime 同步、完整 `verify`、E2E、Runtime smoke、Tauri 应用和 DMG 构建；产物 `DeepSeek Desktop_1.0.23_aarch64.dmg` 经 `hdiutil verify` 验证，SHA-256 为 `906bd2397d0349954fbfe0a15e6309c437f61892dab89c427f2957040bf31aab`。
- 成品应用真实安装与启动：从 `1.0.23` macOS ARM64 DMG 挂载复制 `.app` 到独立临时安装目录，`codesign --verify --deep --strict` 通过，Mach-O 为原生 `arm64`，`CFBundleShortVersionString` 与 `CFBundleVersion` 均为 `1.0.23`，并通过标准 LaunchServices 启动。应用直接进入 Harness 工作台并自动拉起内置 Node `24.20.0` 与 Runtime `0.1.2-alpha.1`。
- macOS 窗口菜单实测：标题栏安全区下方固定显示唯一“文件 / 编辑 / 视图 / 窗口 / 帮助”，工作台从菜单栏下方完整铺开；系统菜单栏只保留最小应用菜单。通过窗口“文件”菜单进入同窗设置，再用关闭按钮返回工作台，Runtime PID 全程保持 `97537`，工作台子 WebView 未重建。
- macOS 菜单重入回归：修复前使用辅助功能连续触发窗口菜单会在 AppKit `_NSPopUpMenu` / `objc_storeWeak` 路径产生 `SIGABRT`。修复后对安装版同一“文件”菜单连续执行两次成功的 `AXPress`，Desktop PID 保持 `97528`；关闭弹出菜单后仍可正常打开设置，完整验收结束后没有新增 `.ips` 崩溃报告。Vue 待完成保护负责减少重复 IPC，Rust 进程级 RAII 原子门闩负责跨 WebView 拒绝原生菜单循环重入。
- macOS 菜单崩溃根因：`1.0.24-test.2` 通过 LaunchServices 标准启动后再次产生 `EXC_BAD_ACCESS` / `SIGSEGV`；主线程栈为 `objc_loadWeakRetained` -> Tao `mouse_motion` / `mouse_moved` -> AppKit `_routeMouseMovedEvent`，寄存器中的 `NSEvent` 参数为空。事实证明只改为系统光标位置弹出仍不足以消除 macOS 26 的延迟空事件；菜单命令没有主动退出应用。
- macOS 窄范围修复：Desktop 初始化时替换锁定 Tao `0.35.3` 的 `TaoView.mouseMoved:` 实现，仅在 AppKit 传入空事件时返回，其他事件调用原 Tao 实现；类、方法或实现契约不存在时拒绝启动。该保护仅在 macOS 编译，Windows/Linux 菜单路径不变。
- `DESKTOP_APP_VERSION=1.0.24-test.3 corepack pnpm@11.24.0 desktop:package`：使用 Node `24.20.0` / pnpm `11.24.0` 完成 Runtime 同步、完整 `verify`、E2E、Runtime smoke、Tauri 发布编译和 DMG 构建；`DeepSeek Desktop_1.0.24-test.3_aarch64.dmg` 经 `hdiutil verify` 通过，SHA-256 为 `097818dead790baf4ed36c3aacaa854e2a5e4d1278048715707ea9200deae6db`。应用经 `codesign --verify --deep --strict` 通过，主程序与内置 Node 均为原生 `arm64`，应用版本为 `1.0.24-test.3`，内置 Node 为 `v24.20.0`。
- `1.0.24-test.3` 成品实测：从 DMG 挂载复制到独立临时安装目录并通过 LaunchServices 启动，Runtime sidecar 正常运行；“文件 / 编辑 / 视图 / 窗口 / 帮助”共完成 150 次原生菜单打开与关闭，Desktop 与 Runtime 全程存活。随后实际打开同窗设置、返回工作台、执行视图命令、取消关闭确认并确认退出，均正常完成，验收期间没有新增 `deepseek-desktop-*.ips`。
- macOS 关闭行为实测：点击原生关闭按钮会显示“取消 / 关闭”确认对话框；取消后 Desktop PID `97528` 与 Runtime PID `97537` 均继续运行，确认后两者均退出且无进程残留。
- Desktop 更新实测：GitHub REST API 因共享出口限流返回失败时，客户端只回退读取同一构建时官方仓库的 `releases.atom`；受信任解析器识别到完整 `1.0.20` Release，更新弹窗、发布说明和下载入口正常，Runtime PID 未变化。
- 崩溃边界复核：一次旧测试曾直接执行 `.app/Contents/MacOS` 内部二进制并注入伪造 `HOME`，Tauri 在应用路径初始化阶段主动终止；该方式不是用户安装或 Finder 启动路径，后续安装验收禁止内部二进制直启。标准启动后的菜单辅助功能测试先后暴露了 AppKit 菜单重入和 Tao 空鼠标事件两条独立崩溃路径，现分别由 Vue 调用抑制、Rust 原生菜单门闩和 macOS Tao 空事件保护覆盖，并按相同触发方式复测。
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

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端、本机 Runtime 启停链路与 macOS ARM64 安装版可运行；macOS 系统菜单、设置覆盖层、会话保持、关闭确认、Desktop 更新和外部文档打开已实测。Windows 设置页滚动由对应尺寸的浏览器回归覆盖，仍不能替代 Windows/Linux 原生应用真机视觉、菜单和关闭行为验收。
- 本轮未写入或使用任何真实 Provider API 密钥，也未向外部搜索端点发起新的真实搜索请求；联网搜索使用匿名本地模拟 Provider 验证协议路由、结果归一化和凭据隔离。普通用户无需选择搜索协议；内置映射会按当前模型 API 协议自动路由，非标准接口仍需要 Provider 自身声明可信能力。
- 本机结果不等于 Apple 公证、Windows 发布者签名，或 macOS x64、Windows x64、Linux x64 真机安装验收；`v1.0.20` 已由对应 GitHub 官方 Runner 原生构建并通过制品核验，但社区制品仍未签名、公证，因此保持 prerelease 且自动更新关闭。
- GitHub 站点自身控制 `Assets` 的折叠状态，仓库无法强制默认展开；可控且已验证的产品入口是 Release 正文中的平台直达下载链接。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
