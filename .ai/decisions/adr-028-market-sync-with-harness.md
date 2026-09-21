# ADR-028：随 Harness 更新同步 DSH Market

## 决策

首次使用或 Harness commit 变化时，在工作台启动前，用当前内核的 Node/CLI、应用自己的 `DSH_HOME` 和随包 pnpm 执行 `dsh plugin --profile desktop-web add dshmarket@latest`。这覆盖内核独立更新和 Desktop 安装包升级。沿用市场官方推荐的 `dsh plugin ... add` 机制；显式 `@latest` 是必要的，实测裸包名会保留已安装的固定版本。

市场是用户 profile 依赖，不加入内置 Harness 清单，不改写市场源码、私有 API 或 Bundle 配置。官方 CLI 负责依赖与启用声明，并保留已安装插件的主动禁用状态；只同步市场，不调用全量插件更新。pnpm 执行后复用正常 profile 准备，恢复可能被包管理器清理的 Desktop 自有扩展。

只有 CLI 成功才原子记录对应 commit。失败不记录成功，在运行状态显示三语提示，下次普通启动重试；成功的普通重启不再联网。使用后台启动流程及共享有界命令执行器，三分钟超时清理进程树，原始 CLI 输出不进入 Desktop 诊断。市场同步失败不否定已经验证的内核，仍继续尝试启动；不声称官方 pnpm 操作具有 Desktop 自行实现的整体事务回滚。

崩溃自动恢复和当次恢复内置内核不执行市场联网同步。该规则不保证未知未来市场版本与任意用户 fork 兼容；加载错误继续走正常 Harness 启动诊断和恢复。

## 验证

保留按 commit 去重、失败重试、官方命令参数与环境的必要回归。显式联网验收调用同一同步函数，在隔离 profile 中验证安装、旧版升级、配置保留及真实服务启动；不修改用户当前 profile。日常测试不依赖 npm 的即时可用性。
