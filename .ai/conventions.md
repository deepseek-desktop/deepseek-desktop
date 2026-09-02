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
- 正式发布源码由 GitHub Actions 从不可变 Tag 对应 commit 检出；工作流不得接受可移动分支或含嵌入凭据的 Git URL 作为发行来源。
- 普通用户只配置 Runtime 仓库覆盖值；留空时使用构建时的 `RUNTIME_REPOSITORY`。可选的预构建更新清单和制品可由 filesystem 或普通 HTTP 服务承载，并继续使用配置公钥验证 Ed25519 签名；`RUNTIME_REF` 显式固定时默认关闭自动准备。

## 实现

- 公共 IPC 必须在 Rust 与 TypeScript 两端保持类型一致。
- 用户可见文案同步维护 `zh-CN`、`zh-TW`、`en-US`，禁止硬编码单语提示。
- 只在系统边界处理可发生的失败；错误信息应分类、脱敏并保留诊断关联能力。
- 设置、索引和生成配置采用原子写入；损坏数据应隔离，不静默覆盖。
- 不引入明文凭据 fallback，不通过命令参数、长期环境变量或日志传递 API Key。
- 不为临时验证修改产品源码；Runtime 补丁必须与锁定版本、marker 和验证脚本一起维护。
- Pull Request 和普通分支 push 不触发发布工作流；只有带或不带 `v` 前缀的完整 SemVer Tag 才触发质量门禁与正式四平台构建。
- macOS ARM64、macOS x64、Windows x64 和 Linux x64 必须分别由对应 GitHub 官方托管 Runner 原生打包，并统一复用 `package:community`。
- 公开 Release 必须等待四个平台全部成功，只上传两份 DMG、一个 EXE、一个 AppImage、一个 DEB 和 `SHA256SUMS`；内部 BUILD-INFO 不作为公开资产。
- Runtime 更新不得写应用安装目录。仓库模式只能在应用数据目录浅克隆、使用安装包内置 Node/pnpm 准备候选并完成真实 smoke；失败必须保留当前 Runtime。Windows 的 Git、构建、smoke、替换和重启进程必须保持无控制台窗口。

## 验证

日常修改运行与范围匹配的检查。发行相关或跨边界变更至少执行：

```bash
corepack pnpm@11.24.0 verify
corepack pnpm@11.24.0 test:e2e
corepack pnpm@11.24.0 runtime:smoke
```

配置和 Runtime 来源变更还应执行：

```bash
corepack pnpm@11.24.0 app:sync --check
corepack pnpm@11.24.0 runtime:sync --check
corepack pnpm@11.24.0 release:smoke
```

只报告实际执行过的验证。当前机器不能替代其他操作系统的真机安装与运行结论。

## Git

- 本仓库独立提交；不要从 SpringOpen 父仓库暂存或提交本目录。
- 提交前检查 `git status --short`、`git diff --check` 和实际 staged diff。
- `target/`、`dist/`、`release/`、诊断、工具链缓存和上游审计检出不得进入提交。
- 不提交 `.env`、凭据、用户工作区数据或含本机绝对路径的生成文件。
