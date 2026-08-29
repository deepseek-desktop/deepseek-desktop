# ADR-004：平台无关的分布式本地发布

## 状态

已被 ADR-009 取代；仅保留历史背景。

## 决策

Desktop 在 `scripts/release-system/` 内维护代码托管平台无关的 Controller、Worker、目标配置和发布 Provider。Controller 通过通用 Git URL 锁定 tag、Desktop commit、Runtime commit 和原生目标；受信任 Worker 使用一次性票据领取与本机平台一致的任务，调用现有 `app:sync`、`runtime:sync`、`verify` 和 `desktop:package` 链路，并把带哈希的制品流式回传。

filesystem 是默认发布 Provider。GitHub 是可选适配器，不参与构建；未来 GitLab、Gitee 或 Gitea 适配器遵循相同的“只发布已验证制品”接口。GitHub Actions 可以作为兼容构建入口继续存在，但不是分布式发布系统的运行依赖。

## 理由

- 不要求单个维护者拥有四种系统、安装虚拟机或长期占用托管 Runner。
- 原生节点只构建自身可靠支持的目标，避免不受支持的跨平台打包。
- 源码托管、构建和制品发布彼此解耦，迁移代码托管平台不改变打包链路。
- Controller 统一验证来源、节点、目标、BUILD-INFO 和 SHA-256，避免人工汇总时混入旧包或错误平台制品。

## 安全边界

- community 和 stable 任务必须绑定受信任节点 ID，并通过私下分发的短期一次性票据领取。
- Controller 非回环监听必须启用 TLS；管理员令牌、Worker 票据和 Provider 令牌不得进入 Git、日志或发布附件。
- 公开 Pull Request 和外部 Webhook 不自动签发票据或触发本地 Worker。
- 任务绑定完整 Desktop/Runtime commit、tag、目标 triple、channel、signed 和制品哈希；脏来源、来源漂移、错误目标和本机路径泄漏直接失败。
- Linux 旧基线容器只作为显式可选能力，不成为普通开发者或其他平台的依赖。

## 单机便捷编排

Apple Silicon 维护者可以选择 `release:local-all`，在同一台物理 Mac 上把原生 macOS、Rosetta、Docker 和 Parallels Windows 作为四个隔离 Worker。该命令仍使用本 ADR 的 Controller、目标绑定、一次性票据、不可变源码和制品校验；它只负责准备环境、临时 TLS、并行启动及 filesystem 汇总，不增加交叉打包捷径，也不改变多台原生节点仍是最高可信发行方式的判断。
