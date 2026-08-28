# 验证基线

## 最近可信验证

日期：2026-08-28

同步官方 Runtime `dsh-v0.1.2-alpha.1`（`cd5ef8148158c3a752a658978873241fdf8e2bbc`）并完成 Desktop 适配后：

- `corepack pnpm@11.7.0 runtime:sync --check`：通过，来源、commit、CLI 入口、部署闭包和制品哈希均与生成锁一致。
- `corepack pnpm@11.7.0 verify`：通过；配置测试 26 项、Vue 测试 6 项、Rust 测试 33 项、Clippy `-D warnings`、3 个 locale / 99 个 key、凭据代理回归和 Runtime manifest 校验全部通过。
- 当前 macOS 原生 Runtime 闭包：24925 个文件、494 个包；`corepack pnpm@11.7.0 runtime:smoke` 完成 2/2 稳定性循环及父进程退出清理验证。
- `corepack pnpm@11.7.0 test:e2e`：1 项 Playwright 测试通过。
- `corepack pnpm@11.7.0 preflight:docker`：通过，在 GitHub 兼容的 Linux/amd64 模拟环境完成官方 Runtime 构建、Desktop 公共 CI 门禁、24841 个文件 / 495 个包的 Runtime 闭包校验及 Playwright 测试；容器按约定跳过仅适合原生宿主执行的 Runtime smoke。
- 窗口标题版本格式已覆盖测试：版本已有 `v` 时保持不变，没有 `v` 时补齐；默认和示例版本仍为 `1.0.0`。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端和当前 macOS 开发环境的验证链路可运行。
- 它不等于 Apple 公证、Windows 发布者签名、Linux 真机安装或所有外部 Provider 已通过验收。
- 用户此前明确取消“每次发布前必须挂载 DMG、校验签名结构并启动 5 秒”的固定流程；不要把该流程重新设为完成门槛，除非任务明确要求。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
