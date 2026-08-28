# 当前交付摘要

- 单原生窗口承载桌面管理与 Harness 工作台，支持原生菜单切换。
- Runtime Supervisor 支持随机端口、readiness、有限恢复、主动停止和进程树清理。
- 支持首次引导、工作区选择、模型 Provider 配置、模型切换、对话、文件操作和插件市场。
- 使用跨平台本地加密凭据库，具备短期会话授权、记录枚举、失败回滚和旧明文索引迁移。
- 提供三语界面、诊断脱敏导出、设置恢复、关于页与社区版更新边界。
- 建立统一应用配置、Runtime 来源同步、不可变发布 pin、工具链校验和一键平台打包链路。
- Runtime 已同步到官方 `0.1.2-alpha.1`（`cd5ef8148158`），新版部署根包名、桌面补丁及 HTTP Web Fetch 运行时闭包均已适配。
- 原生窗口标题读取构建注入的真实桌面版本，并统一使用单个 `v` 前缀，方便问题反馈定位。
- 已建立不依赖托管 Runner 的分布式本地发布协议：四平台原生节点、一次性票据、短期租约、通用 Git 来源、流式制品校验、filesystem 默认发布和可选 GitHub Provider。
- Apple Silicon 单机可通过 `release:local-all` 协调原生 macOS ARM64、Rosetta macOS x64、Docker Linux x64 和 Parallels Windows x64 四个隔离 Worker，并汇总真实目标耗时。
- `.ai/skills/release-workflow.md` 已作为 Agent 统一发布运行手册，固化方案选择、最短反馈路径、提速、安全门禁、故障恢复、验收边界和报告格式。
- 已建立 Runtime 独立更新协议：四平台原生生产闭包、Ed25519 签名清单、流式下载、兼容性与包版本验证、受限解压、版本化安装、启动 smoke、原子切换、上一版回滚和内置基线恢复。
- 后续判断必须以当前 HEAD、生成锁和实际 diff 为准，不能用历史发行结果替代当前验证。
