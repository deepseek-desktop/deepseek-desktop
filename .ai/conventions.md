# 开发约定

## 配置

- 优先级固定为：命令行环境变量 > `.env` > 内置默认值。
- 只接受构建配置加载器声明的变量；未知项、非法格式和必填空值应直接失败。
- Runtime 来源变量统一使用 `RUNTIME_REPOSITORY` / `RUNTIME_REF`，不恢复旧 `HARNESS_*` 兼容。
- `RUNTIME_REF` 本地为空时可解析最新 SemVer；社区版和正式发布必须命中 `runtime/toolchain-lock.json` 的审计 commit。
- 默认和示例版本使用 `1.0.0`，真实版本由发布流程注入，避免文档散落维护发行号。
- 原生窗口和浏览器标题显示真实桌面版本；显示值有 `v` 时保持不变，没有时自动补齐，构建元数据中的 SemVer 本身不增加前缀。
- 发行标签接受带或不带 `v` 前缀的完整 SemVer，例如 `1.0.0`、`v1.0.0` 和 `v0.1.0-community.13`；工作流入口必须执行严格 SemVer 校验。
- GitHub Actions 的应用仓库地址必须来自工作流仓库上下文，不能使用 Windows 短路径副本或其他本地 clone 的文件型 `origin`。
- 分布式发布源码必须使用不含嵌入凭据的通用 Git URL；构建、Controller 状态和发布 Provider 不得假定 GitHub 存在。

## 实现

- 公共 IPC 必须在 Rust 与 TypeScript 两端保持类型一致。
- 用户可见文案同步维护 `zh-CN`、`zh-TW`、`en-US`，禁止硬编码单语提示。
- 只在系统边界处理可发生的失败；错误信息应分类、脱敏并保留诊断关联能力。
- 设置、索引和生成配置采用原子写入；损坏数据应隔离，不静默覆盖。
- 不引入明文凭据 fallback，不通过命令参数、长期环境变量或日志传递 API Key。
- 不为临时验证修改产品源码；Runtime 补丁必须与锁定版本、marker 和验证脚本一起维护。
- community/stable 分布式任务必须绑定受信任节点 ID；一次性票据和短期租约只保存摘要，公开 PR 不得自动触发本地 Worker。

## 验证

日常修改运行与范围匹配的检查。发行相关或跨边界变更至少执行：

```bash
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 test:e2e
corepack pnpm@11.7.0 runtime:smoke
```

配置和 Runtime 来源变更还应执行：

```bash
corepack pnpm@11.7.0 app:sync --check
corepack pnpm@11.7.0 runtime:sync --check
corepack pnpm@11.7.0 release:smoke
```

只报告实际执行过的验证。当前机器不能替代其他操作系统的真机安装与运行结论。

## Git

- 本仓库独立提交；不要从 SpringOpen 父仓库暂存或提交本目录。
- 提交前检查 `git status --short`、`git diff --check` 和实际 staged diff。
- `target/`、`dist/`、`release/`、诊断、工具链缓存和上游审计检出不得进入提交。
- 不提交 `.env`、凭据、用户工作区数据或含本机绝对路径的生成文件。
