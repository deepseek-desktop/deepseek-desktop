# 验证基线

## 最近可信验证

日期：2026-09-01

正式发布收敛为 GitHub Actions 官方托管 Runner 原生矩阵后：

- `corepack pnpm@11.24.0 app:sync --check`：通过，生成配置与源码一致。
- `corepack pnpm@11.24.0 runtime:sync --check`：通过，Runtime `0.1.2-alpha.1` 固定到 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，来源、CLI 入口、部署闭包和制品哈希与生成锁一致。
- `corepack pnpm@11.24.0 verify`：通过；配置与发行协议测试 80 项、Vue 测试 13 项、Rust 测试 72 项、Clippy `-D warnings`、3 个 locale / 148 个 key、凭据代理回归和 Runtime manifest 校验全部通过；另有 19 项跟随模型搜索测试覆盖自动协议映射、模型切换、多会话隔离、`CredentialRef` 继承、取消、超时、重定向和响应校验。
- `corepack pnpm@11.24.0 audit --prod --registry=https://registry.npmjs.org` 与 Runtime 子目录同项审计：均通过，无已知生产依赖漏洞。
- `corepack pnpm@11.24.0 test:e2e`：通过 2 项 Playwright 测试；除 Shell 自动启动、语言切换和状态视图外，还在 `1000x700` 的 Windows 尺寸视口验证长 Runtime 设置表单可以滚动到最后一个操作按钮。
- `corepack pnpm@11.24.0 runtime:smoke`：通过父进程退出清理与 Runtime `0.1.2-alpha.1` 一次完整启停循环。
- `corepack pnpm@11.24.0 release:smoke`：通过分布式发布 HTTP 制品流式传输、校验与发布协议回归。
- Runtime 更新源设置回归：官方档案保持默认；自定义档案原子绑定签名清单 URL、Runtime 仓库身份、发布者与 Ed25519 公钥。配置、来源切换、候选失效、缺失字段禁用且不跨源回退、诊断脱敏、三语文案和 E2E 表单均已验证。
- `node scripts/with-rust.mjs tauri build --config target/generated/tauri.conf.json --bundles app`：通过，生成 macOS ARM64 `.app`，`codesign --verify --deep --strict` 通过。
- `corepack pnpm@11.24.0 desktop:package`：在当前 macOS ARM64 主机以默认开发版本 `1.0.0` 完成同步、完整门禁、Tauri 应用和 DMG 构建；产物 `DeepSeek Desktop_1.0.0_aarch64.dmg` 经 `hdiutil verify` 验证，SHA-256 为 `7a924326c8c3597236c114cd34ad59362d07905f9d96d296a846f6381ce932e5`。
- 成品应用真实安装与启动：从本机构建的 macOS ARM64 DMG 挂载复制 `.app`，`codesign --verify --deep --strict` 通过，并通过标准 LaunchServices 启动。应用直接进入 Harness 工作台，自动拉起内置 Node `24.20.0` 与 Runtime `0.1.2-alpha.1`；设置覆盖层开启和关闭前后 Runtime PID 保持不变，原工作台和会话列表未被重建。
- macOS 原生菜单实测：系统菜单栏唯一显示应用菜单及“文件 / 编辑 / 视图 / 窗口 / 帮助”，窗口内不再绘制第二套菜单；设置、工作台、Desktop 更新、Runtime 更新、诊断、关于、文档、关闭和退出命令均位于原生菜单体系。
- macOS 关闭行为实测：文件菜单的“关闭窗口”弹出原生确认对话框，取消后应用与 Runtime 继续运行；确认关闭后 Desktop、Runtime 子进程和监听端口均无残留。帮助菜单的“使用文档”由系统默认浏览器打开官方仓库 README。
- Desktop 更新实测：GitHub REST API 因共享出口限流返回失败时，客户端只回退读取同一构建时官方仓库的 `releases.atom`；受信任解析器识别到完整 `1.0.20` Release，更新弹窗、发布说明和下载入口正常，Runtime PID 未变化。
- 崩溃边界复核：一次旧测试曾直接执行 `.app/Contents/MacOS` 内部二进制并注入伪造 `HOME`，Tauri 在应用路径初始化阶段主动终止并生成崩溃报告；该方式不是用户安装或 Finder 启动路径。改用标准 LaunchServices 后未复现，验收期间没有新增崩溃报告，后续安装验收禁止内部二进制直启。
- GitHub 工作流协议：Pull Request 与普通分支 push 不触发发布工作流；完整 SemVer Tag 才执行质量门禁并启动 macOS ARM64、macOS x64、Windows x64、Linux x64 原生矩阵。结构化汇总器只接受四份来源一致的内部构建信息，公开 Release 只输出五个安装包与统一 `SHA256SUMS`。
- `v1.0.18` 因跨平台生成 CSS 模块摘要不一致而在质量门禁失败，`v1.0.19` 因 Intel macOS Runner 下载 Node 工具链超时而失败；两次均未创建不完整 Release，旧 Tag 未移动。修复后使用新 Tag `v1.0.20` 恢复。
- `v1.0.20` GitHub Actions 原生矩阵成功，Run `33488866877` 绑定 commit `d41fca2f8db423c587d0a2972f759b1619039440`：质量门禁 9 分 07 秒、Linux x64 14 分 54 秒、macOS ARM64 16 分、Windows x64 28 分 08 秒、macOS x64 53 分 14 秒、发布 59 秒，工作流总墙钟约 1 小时 03 分 28 秒。
- `v1.0.20` Release 为未签名 prerelease，公开资产严格为两份 DMG、一个 EXE、一个 AppImage、一个 DEB 和 `SHA256SUMS`。下载后执行 `shasum -a 256 -c SHA256SUMS`，五个安装包全部返回 `OK`；六个正文直达下载链接均经 GitHub 重定向后返回 HTTP 200，Release 正文无需依赖 `Assets` 展开状态。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端、本机 Runtime 启停链路与 macOS ARM64 安装版可运行；macOS 系统菜单、设置覆盖层、会话保持、关闭确认、Desktop 更新和外部文档打开已实测。Windows 设置页滚动由对应尺寸的浏览器回归覆盖，仍不能替代 Windows/Linux 原生应用真机视觉、菜单和关闭行为验收。
- 本轮未写入或使用任何真实 Provider API 密钥，也未向外部搜索端点发起新的真实搜索请求；联网搜索使用匿名本地模拟 Provider 验证协议路由、结果归一化和凭据隔离。普通用户无需选择搜索协议；内置映射会按当前模型 API 协议自动路由，非标准接口仍需要 Provider 自身声明可信能力。
- 本机结果不等于 Apple 公证、Windows 发布者签名，或 macOS x64、Windows x64、Linux x64 真机安装验收；`v1.0.20` 已由对应 GitHub 官方 Runner 原生构建并通过制品核验，但社区制品仍未签名、公证，因此保持 prerelease 且自动更新关闭。
- GitHub 站点自身控制 `Assets` 的折叠状态，仓库无法强制默认展开；可控且已验证的产品入口是 Release 正文中的平台直达下载链接。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
