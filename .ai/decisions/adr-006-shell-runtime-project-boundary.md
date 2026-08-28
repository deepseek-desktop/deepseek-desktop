# ADR-006：Desktop 壳与 Runtime 项目目录解耦

## 状态

已采用。

## 决策

DeepSeek Desktop 是 Runtime 的原生生命周期与安全外壳，不是项目工作区管理器。首次启动不要求用户选择目录，Desktop 设置、IPC、命令行、状态和诊断契约都不保存用户项目目录，也不调用 Runtime 私有工作区注册接口。会话、项目目录和文件边界完全由 Runtime 工作台自身管理。

Runtime 进程以系统应用数据目录内的 `runtime-workdir` 作为内部当前目录。该目录只隔离进程启动上下文，不代表用户项目目录；Desktop 与 Runtime 只依赖本地启动地址、认证健康检查、凭据协议和版本兼容协议。

## 理由

- 用户安装后可直接启动工作台，减少无意义的首次配置步骤。
- Runtime 的工作区 API 或内部数据模型变化不会阻断 Desktop 启动。
- Desktop 不再重复保存一份项目目录状态，避免壳层与工作台状态不一致。
- Runtime 更新 smoke 只验证可启动和可认证探活，不依赖业务页面的私有 RPC。

## 约束

- 不得重新加入 Desktop 目录选择器、`--workspace` 参数或工作区注册 RPC。
- `runtime-workdir` 必须位于应用数据目录，并在启动前创建；创建失败以明确错误码终止。
- 用户项目目录仍受 Runtime 工作台自身权限与沙箱策略约束，Desktop 不扩大其文件访问范围。
