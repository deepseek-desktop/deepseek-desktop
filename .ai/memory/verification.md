# 验证基线

## 最近可信验证

日期：2026-08-28

同步官方 Runtime `dsh-v0.1.2-alpha.1`（`cd5ef8148158c3a752a658978873241fdf8e2bbc`），并完成分布式本地发布系统与 Runtime 独立更新协议后：

- `corepack pnpm@11.7.0 app:sync --check`：通过，生成配置与工作区一致。
- `corepack pnpm@11.7.0 runtime:sync --check`：通过，来源、commit、CLI 入口、部署闭包和制品哈希均与生成锁一致。
- `corepack pnpm@11.7.0 verify`：通过；配置、分布式发布和 Runtime 更新协议测试 38 项、Vue 测试 7 项、Rust 测试 43 项、Clippy `-D warnings`、3 个 locale / 136 个 key、凭据代理回归和 Runtime manifest 校验全部通过。
- `corepack pnpm@11.7.0 release:smoke`：通过本地 Controller HTTP、一次性节点票据、短期租约、制品上传、完整性校验和 filesystem 发布闭环。
- `corepack pnpm@11.7.0 release:local-all -- --check`：通过真实四环境预检；macOS ARM64 原生、Rosetta macOS x64、Docker Linux x64 和 Parallels Windows x64 均成功识别目标并访问同一临时 TLS Controller，单环境探测耗时约 0.5 至 0.7 秒。
- `corepack pnpm@11.7.0 release:worker -- --identify`：当前 macOS ARM64 节点可正确识别为 `macos-arm64`，不会领取其他平台任务。
- 当前 macOS 原生 Runtime 闭包：24925 个文件、494 个包；`corepack pnpm@11.7.0 runtime:smoke` 完成启动、父进程退出清理验证。
- `corepack pnpm@11.7.0 test:e2e`：1 项 Playwright 测试通过。
- `corepack pnpm@11.7.0 runtime:update:package -- --output <目录>`：通过公开一键入口同步并生成 macOS ARM64 Runtime 更新制品；制品为 88,724,342 字节，描述中的大小和 SHA-256 与实际文件一致，归档安全扫描未发现绝对路径、父目录逃逸或 `.env`。
- `corepack pnpm@11.7.0 preflight:docker`：通过，在 GitHub 兼容的 Linux/amd64 模拟环境完成官方 Runtime 构建、Desktop 公共 CI 门禁、24841 个文件 / 495 个包的 Runtime 闭包校验及 Playwright 测试；容器按约定跳过仅适合原生宿主执行的 Runtime smoke。
- 窗口标题版本格式已覆盖测试：版本已有 `v` 时保持不变，没有 `v` 时补齐；默认和示例版本仍为 `1.0.0`。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端和当前 macOS 开发环境的验证链路可运行。
- 它不等于 Apple 公证、Windows 发布者签名、四目标完整安装包构建与安装验收、外部更新服务下载，或四平台安装版中的真实 Runtime 切换与回滚验收。macOS x64 当前通过 Rosetta，Linux x64 当前通过 Docker `linux/amd64`，Windows x64 当前通过 Parallels Windows ARM 的 x64 模拟运行构建工具，均不是对应架构的独立物理机。
- 用户此前明确取消“每次发布前必须挂载 DMG、校验签名结构并启动 5 秒”的固定流程；不要把该流程重新设为完成门槛，除非任务明确要求。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
