# 验证基线

## 最近可信验证

日期：2026-09-02

正式发布收敛为 GitHub Actions 官方托管 Runner 原生矩阵后：

- `corepack pnpm@11.24.0 app:sync --check`：通过，生成配置与源码一致。
- `corepack pnpm@11.24.0 runtime:sync --check`：通过，Runtime `0.1.2-alpha.1` 固定到 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，来源、CLI 入口、部署闭包和制品哈希与生成锁一致。
- `corepack pnpm@11.24.0 verify`：通过；配置与发行协议测试 80 项、Vue 测试 16 项、Rust 测试 73 项、Clippy `-D warnings`、3 个 locale / 155 个 key、凭据代理回归和 Runtime manifest 校验全部通过；另有 19 项跟随模型搜索测试覆盖自动协议映射、模型切换、多会话隔离、`CredentialRef` 继承、取消、超时、重定向和响应校验。新增回归覆盖菜单键盘访问、未关闭时的重复打开抑制、独立菜单 WebView 的保存语言和实时语言同步，以及 Rust 原生菜单门闩的重入拒绝和释放。
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
- macOS 关闭行为实测：点击原生关闭按钮会显示“取消 / 关闭”确认对话框；取消后 Desktop PID `97528` 与 Runtime PID `97537` 均继续运行，确认后两者均退出且无进程残留。
- Desktop 更新实测：GitHub REST API 因共享出口限流返回失败时，客户端只回退读取同一构建时官方仓库的 `releases.atom`；受信任解析器识别到完整 `1.0.20` Release，更新弹窗、发布说明和下载入口正常，Runtime PID 未变化。
- 崩溃边界复核：一次旧测试曾直接执行 `.app/Contents/MacOS` 内部二进制并注入伪造 `HOME`，Tauri 在应用路径初始化阶段主动终止；该方式不是用户安装或 Finder 启动路径，后续安装验收禁止内部二进制直启。另一次标准启动后的菜单辅助功能重入真实暴露了 AppKit 崩溃，现已按上文通过前端与 Rust 双层门闩修复并在相同触发方式下复测。
- GitHub 工作流协议：Pull Request 与普通分支 push 不触发发布工作流；完整 SemVer Tag 才执行质量门禁并启动 macOS ARM64、macOS x64、Windows x64、Linux x64 原生矩阵。结构化汇总器只接受四份来源一致的内部构建信息，公开 Release 只输出五个安装包与统一 `SHA256SUMS`。
- `v1.0.18` 因跨平台生成 CSS 模块摘要不一致而在质量门禁失败，`v1.0.19` 因 Intel macOS Runner 下载 Node 工具链超时而失败；两次均未创建不完整 Release，旧 Tag 未移动。修复后使用新 Tag `v1.0.20` 恢复。
- `v1.0.20` GitHub Actions 原生矩阵成功，Run `33488866877` 绑定 commit `d41fca2f8db423c587d0a2972f759b1619039440`：质量门禁 9 分 07 秒、Linux x64 14 分 54 秒、macOS ARM64 16 分、Windows x64 28 分 08 秒、macOS x64 53 分 14 秒、发布 59 秒，工作流总墙钟约 1 小时 03 分 28 秒。
- `v1.0.20` Release 为未签名 prerelease，公开资产严格为两份 DMG、一个 EXE、一个 AppImage、一个 DEB 和 `SHA256SUMS`。下载后执行 `shasum -a 256 -c SHA256SUMS`，五个安装包全部返回 `OK`；六个正文直达下载链接均经 GitHub 重定向后返回 HTTP 200，Release 正文无需依赖 `Assets` 展开状态。
- `v1.0.21` 的 Linux 质量门禁发现 macOS 专用 `APP_NAME` 常量缺少条件编译，Clippy `-D warnings` 以 dead code 拒绝构建；原生矩阵和发布任务均未启动，未创建不完整 Release。旧 Tag 保持不变，修复使用新的不可变 Tag。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端、本机 Runtime 启停链路与 macOS ARM64 安装版可运行；macOS 系统菜单、设置覆盖层、会话保持、关闭确认、Desktop 更新和外部文档打开已实测。Windows 设置页滚动由对应尺寸的浏览器回归覆盖，仍不能替代 Windows/Linux 原生应用真机视觉、菜单和关闭行为验收。
- 本轮未写入或使用任何真实 Provider API 密钥，也未向外部搜索端点发起新的真实搜索请求；联网搜索使用匿名本地模拟 Provider 验证协议路由、结果归一化和凭据隔离。普通用户无需选择搜索协议；内置映射会按当前模型 API 协议自动路由，非标准接口仍需要 Provider 自身声明可信能力。
- 本机结果不等于 Apple 公证、Windows 发布者签名，或 macOS x64、Windows x64、Linux x64 真机安装验收；`v1.0.20` 已由对应 GitHub 官方 Runner 原生构建并通过制品核验，但社区制品仍未签名、公证，因此保持 prerelease 且自动更新关闭。
- GitHub 站点自身控制 `Assets` 的折叠状态，仓库无法强制默认展开；可控且已验证的产品入口是 Release 正文中的平台直达下载链接。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
