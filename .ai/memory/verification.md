# 验证基线

## 最近可信验证

日期：2026-09-01

正式发布收敛为 GitHub Actions 官方托管 Runner 原生矩阵后：

- `corepack pnpm@11.24.0 app:sync --check`：通过，生成配置与源码一致。
- `corepack pnpm@11.24.0 runtime:sync --check`：通过，Runtime `0.1.2-alpha.1` 固定到 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，来源、CLI 入口、部署闭包和制品哈希与生成锁一致。
- `corepack pnpm@11.24.0 verify`：通过；配置与发行协议测试 73 项、Vue 测试 8 项、Rust 测试 56 项、Clippy `-D warnings`、3 个 locale / 122 个 key、凭据代理回归和 Runtime manifest 校验全部通过；另有 19 项跟随模型搜索测试覆盖自动协议映射、模型切换、多会话隔离、`CredentialRef` 继承、取消、超时、重定向和响应校验。
- `corepack pnpm@11.24.0 audit --prod --registry=https://registry.npmjs.org` 与 Runtime 子目录同项审计：均通过，无已知生产依赖漏洞。
- `corepack pnpm@11.24.0 test:e2e`：通过 1 项 Playwright Shell 测试，覆盖 Runtime 自动启动、语言切换和状态视图。
- `corepack pnpm@11.24.0 runtime:smoke`：通过父进程退出清理与 Runtime `0.1.2-alpha.1` 一次完整启停循环。
- `corepack pnpm@11.24.0 desktop:package`：在当前 macOS ARM64 主机完成同步、完整门禁、Tauri 应用、DMG 构建和 77,369 个交付文件扫描；Runtime 生产闭包为 26,187 个文件，开发测试源码已剔除。产物为 `release/1.0.0/aarch64-apple-darwin/DeepSeek Desktop_1.0.0_aarch64.dmg`，SHA-256 为 `611540d4fc7647c4a466bcba40ba1408bfd9fa9706a0e70aecc99d1f5c9ef87b`。
- 成品应用真实启动：直接启动构建出的 `DeepSeek Desktop.app`，桌面壳无需选择目录或点击启动，即自动拉起安装包内置 Node `24.20.0` 与 Runtime；Runtime 在 `127.0.0.1:49461` 就绪后，同一原生窗口直接呈现 Harness 工作台。首次使用时可见的内测声明和模型 API Key 提示属于 Runtime 工作台自身引导，不是 Desktop 的启动前置步骤；关闭 Desktop 后 Runtime 子进程与监听端口同步清理。
- GitHub 工作流协议：Pull Request 与普通分支 push 不触发发布工作流；完整 SemVer Tag 才执行质量门禁并启动 macOS ARM64、macOS x64、Windows x64、Linux x64 原生矩阵。结构化汇总器只接受四份来源一致的内部构建信息，公开 Release 只输出五个安装包与统一 `SHA256SUMS`。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端、本机 Runtime 启停链路与 macOS ARM64 成品应用可运行。本轮没有写入 `/Applications`，而是直接启动构建目录内的 `.app`；用户已取消固定的 DMG 挂载和五秒签名结构验证门禁。
- 本轮未写入或使用任何真实 Provider API 密钥，也未向外部搜索端点发起新的真实搜索请求；联网搜索使用匿名本地模拟 Provider 验证协议路由、结果归一化和凭据隔离。普通用户无需选择搜索协议；内置映射会按当前模型 API 协议自动路由，非标准接口仍需要 Provider 自身声明可信能力。
- 本机结果不等于 Apple 公证、Windows 发布者签名，或 macOS x64、Windows x64、Linux x64 安装版验收；这些目标必须在未来收到明确发布命令后由对应 GitHub 官方 Runner 原生构建，四平台全部成功才允许创建 Release。
- 本轮没有创建或移动 Tag，没有推送 `master`，也没有创建 GitHub Release。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
