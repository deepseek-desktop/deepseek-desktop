# 验证基线

## 最近可信验证

日期：2026-08-27

源码审计治理提交 `b693290` 上完成：

- `corepack pnpm@11.7.0 verify`：通过。
- 配置测试：19 项通过。
- Vue 测试：6 项通过。
- Rust 测试：33 项通过。
- Clippy `-D warnings`：通过。
- 国际化一致性：3 个 locale、99 个 key 通过。
- `corepack pnpm@11.7.0 test:e2e`：通过。
- `corepack pnpm@11.7.0 runtime:smoke`：通过。
- 使用锁定来源执行真实 `runtime:sync`：通过，解析到 `runtime/toolchain-lock.json` 中固定 commit。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端和当前 macOS 开发环境的验证链路可运行。
- 它不等于 Apple 公证、Windows 发布者签名、Linux 真机安装或所有外部 Provider 已通过验收。
- 用户此前明确取消“每次发布前必须挂载 DMG、校验签名结构并启动 5 秒”的固定流程；不要把该流程重新设为完成门槛，除非任务明确要求。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
