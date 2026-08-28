# 验证基线

## 最近可信验证

日期：2026-08-29

Desktop 壳与 Runtime 项目目录解耦、移除私有工作区注册 RPC，并补齐多显示器窗口可达性修复后：

- `corepack pnpm@11.7.0 app:sync --check`：通过，生成配置与源码一致。
- `corepack pnpm@11.7.0 runtime:sync --check`：通过，Runtime `0.1.2-alpha.1` 固定到 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，来源、CLI 入口、部署闭包和制品哈希与生成锁一致。
- `corepack pnpm@11.7.0 verify`：通过；配置、分布式发布和 Runtime 更新协议测试 42 项、Vue 测试 7 项、Rust 测试 47 项、Clippy `-D warnings`、3 个 locale / 135 个 key、凭据代理回归和 Runtime manifest 校验全部通过。
- `corepack pnpm@11.7.0 test:e2e`：通过 1 项 Playwright Shell 测试，覆盖无需选择目录的两步首次引导、启动和重试。
- `corepack pnpm@11.7.0 runtime:smoke`：通过 Runtime 浏览器令牌认证、HTTP readiness、启停和父进程退出清理；不调用 Runtime 私有工作区 API。
- `corepack pnpm@11.7.0 release:smoke`：通过本地 Controller HTTP、一次性节点票据、短期租约、制品上传、完整性校验和 filesystem 发布闭环。
- `corepack pnpm@11.7.0 release:local-all -- --check`：通过真实四环境预检；macOS ARM64、Rosetta macOS x64、Docker Linux x64 和 Parallels Windows x64 均识别正确目标并访问同一 Controller。
- `DESKTOP_APP_VERSION=1.0.5 corepack pnpm@11.7.0 desktop:package`：通过完整 Runtime 同步、发布门禁、重复完整验证、E2E、Runtime smoke、macOS ARM64 应用和 DMG 构建。
- macOS ARM64 真实安装验证：最终 `DeepSeek Desktop_1.0.5_aarch64.dmg` 安装到 `/Applications` 后可启动，原生标题显示 `DeepSeek Desktop v1.0.5`；保存的外接屏位置仍有效时窗口恢复到该显示器；点击启动后 Runtime 进程稳定运行，API 配置引导与工作台均嵌入同一原生窗口，项目目录入口仅由 Runtime 工作台提供。
- 真实安装版 Runtime 的当前目录为应用数据目录内的 `runtime-workdir`，不再使用 Desktop 选择的项目目录；日志未再产生 `runtime-workspace-registration-failed`。
- 窗口位置回归覆盖“已连接外接屏保持原位置”和“目标显示器断开时居中回主屏”两种情况。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端、macOS ARM64 安装版和本机可用四环境预检链路可运行。
- 模型凭据未在本轮重新写入，真实模型对话沿用用户此前的业务验收结论；本轮变更只调整 Desktop 壳、Runtime 启动边界和窗口恢复。
- 它不等于 Apple 公证、Windows 发布者签名，或 macOS x64、Windows x64、Linux x64 安装版的本轮真实业务验收。对应安装包仍应由原生节点构建并由目标系统用户验收。
- 用户已取消“每次发布前必须挂载 DMG、校验签名结构并启动 5 秒”的固定门禁；本轮真实安装仅因任务明确要求执行，不恢复为长期强制流程。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
