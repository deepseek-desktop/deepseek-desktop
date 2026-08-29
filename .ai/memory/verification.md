# 验证基线

## 最近可信验证

日期：2026-08-30

正式发布收敛为 GitHub Actions 官方托管 Runner 原生矩阵后：

- `corepack pnpm@11.7.0 app:sync --check`：通过，生成配置与源码一致。
- `corepack pnpm@11.7.0 runtime:sync --check`：通过，Runtime `0.1.2-alpha.1` 固定到 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，来源、CLI 入口、部署闭包和制品哈希与生成锁一致。
- `node --test scripts/tests/release-tag.test.mjs scripts/tests/ci-release-assets.test.mjs scripts/tests/release-system.test.mjs`：32 项通过，覆盖严格 SemVer、预发布判定、四目标来源一致性、目标与制品类型匹配、哈希校验、公开资产收敛、损坏缓存和符号链接拒绝。
- `corepack pnpm@11.7.0 verify`：通过；配置与发行协议测试 62 项、Vue 测试 7 项、Rust 测试 49 项、Clippy `-D warnings`、3 个 locale / 135 个 key、凭据代理回归和 Runtime manifest 校验全部通过；另有 15 项跟随模型搜索测试覆盖协议路由、模型切换、多会话隔离、`CredentialRef` 继承、取消、超时、重定向和响应校验。
- `corepack pnpm@11.7.0 test:e2e`：通过 1 项 Playwright Shell 测试，覆盖首次引导、语言切换和状态视图。
- `corepack pnpm@11.7.0 runtime:smoke`：通过父进程退出清理与 Runtime `0.1.2-alpha.1` 一次完整启停循环。
- `corepack pnpm@11.7.0 desktop:package`：在当前 macOS ARM64 主机完成同步、完整门禁、Tauri 应用和 DMG 构建；产物为 `release/1.0.0/aarch64-apple-darwin/DeepSeek Desktop_1.0.0_aarch64.dmg`，SHA-256 为 `b1cab0b21b8d4064f1d3875aa14f0ae85493d0c8dc84bc9d1f02b7d831fa8b0f`。
- 成品应用真实启动：直接启动构建出的 `DeepSeek Desktop.app`，窗口恢复到外接屏幕；点击启动后拉起安装包内置 Node `24.20.0` 和 Runtime，并在同一个原生窗口进入 Harness 工作台；退出 Desktop 后 Runtime 子进程同步结束。
- GitHub 工作流协议：Pull Request 与 `master` 只执行质量检查；完整 SemVer Tag 才启动 macOS ARM64、macOS x64、Windows x64、Linux x64 原生矩阵。结构化汇总器只接受四份来源一致的内部构建信息，公开 Release 只输出五个安装包与统一 `SHA256SUMS`。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端、本机 Runtime 启停链路与 macOS ARM64 成品应用可运行。本轮没有写入 `/Applications`，而是直接启动构建目录内的 `.app`；用户已取消固定的 DMG 挂载和五秒签名结构验证门禁。
- 本轮未写入或使用任何真实 Provider API 密钥，也未向外部搜索端点发起真实请求；联网搜索使用匿名本地模拟 Provider 验证协议路由、结果归一化和凭据隔离。真实第三方兼容性仍需由使用者选择对应标准协议并在实际 Provider 上验收，阿里百炼等服务不属于默认产品路由。
- 本机结果不等于 Apple 公证、Windows 发布者签名，或 macOS x64、Windows x64、Linux x64 安装版验收；这些目标必须在未来收到明确发布命令后由对应 GitHub 官方 Runner 原生构建，四平台全部成功才允许创建 Release。
- 本轮没有创建或移动 Tag，没有推送 `master`，也没有创建 GitHub Release。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
