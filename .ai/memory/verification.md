# 验证基线

## 最近可信验证

日期：2026-08-29

修复 OpenAI Responses 兼容流工具身份错配，并补齐 DeepSeek 官方搜索凭据指引后：

- `corepack pnpm@11.7.0 app:sync --check`：通过，生成配置与源码一致。
- `corepack pnpm@11.7.0 runtime:sync --check`：通过，Runtime `0.1.2-alpha.1` 固定到 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，来源、CLI 入口、部署闭包和制品哈希与生成锁一致。
- `corepack pnpm@11.7.0 verify`：通过；配置、分布式发布和 Runtime 更新协议测试 42 项、Vue 测试 7 项、Rust 测试 47 项、Clippy `-D warnings`、3 个 locale / 135 个 key、凭据代理回归和 Runtime manifest 校验全部通过。Runtime 校验会重放“暂态 `read`、最终 `glob`”事件并断言最终工具 ID、名称、参数和 namespace 均被纠正，也会断言缺少官方搜索密钥时返回可操作且不建议复用第三方密钥的提示。
- `corepack pnpm@11.7.0 test:e2e`：通过 1 项 Playwright Shell 测试，覆盖无需选择目录的两步首次引导、启动和重试。
- `corepack pnpm@11.7.0 runtime:smoke`：通过 Runtime 浏览器令牌认证、HTTP readiness、启停和父进程退出清理；Runtime `0.1.2-alpha.1` 完成 1 次完整启停循环，不调用 Runtime 私有工作区 API。
- `corepack pnpm@11.7.0 release:smoke`：通过本地 Controller HTTP、一次性节点票据、短期租约、制品上传、完整性校验和 filesystem 发布闭环。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端和本机 Runtime 启停链路可运行；本轮没有重新生成或安装 macOS 安装包，也没有重新执行四环境构建预检。
- 本轮未写入或使用官方 DeepSeek API 密钥，也未向外部搜索端点发起真实请求；搜索验证覆盖缺失凭据时的安全来源隔离和可操作提示，真实联网搜索仍需使用者配置官方密钥后验收。模型对话沿用用户此前的业务验收结论。
- 它不等于 Apple 公证、Windows 发布者签名，或 macOS x64、Windows x64、Linux x64 安装版的本轮真实业务验收。对应安装包仍应由原生节点构建并由目标系统用户验收。
- 用户已取消“每次发布前必须挂载 DMG、校验签名结构并启动 5 秒”的固定门禁，不恢复为长期强制流程。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
