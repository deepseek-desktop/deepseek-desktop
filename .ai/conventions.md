# 开发约定

## 配置

- 优先级固定为：命令行环境变量 > `.env` > 内置默认值。
- 只接受构建配置加载器声明的变量；未知项、非法格式和必填空值应直接失败。
- Harness 来源变量统一使用 `HARNESS_REPOSITORY` / `HARNESS_REF`，按全新配置契约开发，不提供历史别名与迁移分支。
- `HARNESS_REF` 本地为空时可解析最新 SemVer；社区版和正式发布必须命中 `harness/toolchain-lock.json` 的审计 commit。Tag CI 入口从该 lock 显式导出仓库与 ref，解析结果继续校验 commit；质量门禁及原生构建使用同一份来源，包括直接按 commit 锁定的官方 master 提交。
- 公开版本固定为四段数字：前三段等于工具链 lock 的 Harness 正式版本，第四段是从 `1` 开始递增的 Desktop 修订号；当前默认示例为 `0.1.6.1`。
- 原生窗口、浏览器标题、更新提示、安装包名称与构建事实显示同一个四段公开版本；生成器负责转换 Tauri 所需的内部 SemVer 和平台版本字段。
- 发行标签接受带或不带 `v` 前缀的四段数字，例如 `0.1.6.1`、`v0.1.6.2`；工作流入口必须同时校验格式和前三段 Harness 映射。
- GitHub Actions 的应用仓库地址必须来自工作流仓库上下文，不能使用 Windows 短路径副本或其他本地 clone 的文件型 `origin`。
- 正式发布源码由 GitHub Actions 从不可变 Tag 对应 commit 检出；工作流不得接受可移动分支或含嵌入凭据的 Git URL 作为发行来源。
- 普通用户只配置 Harness 仓库覆盖值；留空时使用构建时的 `HARNESS_REPOSITORY`。可选的预构建更新清单和制品可由 filesystem 或普通 HTTP 服务承载，并继续使用配置公钥验证 Ed25519 签名；`HARNESS_REF` 显式固定时默认关闭自动准备。

## 实现

- 公共 IPC 必须在 Rust 与 TypeScript 两端保持类型一致。
- 用户可见文案同步维护 `zh-CN`、`zh-TW`、`en-US`，禁止硬编码单语提示。
- 只在系统边界处理可发生的失败；错误信息应分类、脱敏并保留诊断关联能力。
- 设置、索引和生成配置采用原子写入；损坏数据应隔离，不静默覆盖。
- 桌面自身不引入明文凭据 fallback：不由桌面把 API Key 写入命令参数、长期环境变量或日志，桌面保管的凭据只经加密保险库与受限 helper 会话传递。这不限制用户自己 export 的变量，Harness sidecar 继承完整环境（见 ADR-025），并在其下垫入用户登录 shell 报告的环境（见 ADR-026）。
- 不为临时验证修改产品源码；Harness 补丁必须与锁定版本、marker 和验证脚本一起维护。
- Pull Request 和普通分支 push 不触发发布工作流；只有带或不带 `v` 前缀的四段数字 Tag 才触发质量门禁与正式四平台构建。
- macOS ARM64、macOS x64、Windows x64 和 Linux x64 必须分别由对应 GitHub 官方托管 Runner 原生打包，并统一复用 `package:community`。
- 公开 Release 必须等待四个平台全部成功，只上传两份 DMG、一个 EXE、一个 AppImage、一个 DEB 和 `SHA256SUMS`；内部 BUILD-INFO 不作为公开资产。
- Harness 更新不得写应用安装目录。仓库模式只能在应用数据目录浅克隆，使用安装包内置 Node/pnpm/npm 与 Node-API 头准备候选；macOS/Linux 按当前原生声明预检系统编译器，完整构建平台包并完成真实 smoke，失败必须保留当前 Harness。Windows 的 Git、构建、smoke、替换和重启进程必须保持无控制台窗口。

## 验证

日常修改运行与范围匹配的检查。发行相关或跨边界变更至少执行：

```bash
corepack pnpm@11.24.0 verify
corepack pnpm@11.24.0 test:e2e
corepack pnpm@11.24.0 harness:smoke
```

配置和 Harness 来源变更还应执行：

```bash
corepack pnpm@11.24.0 app:sync --check
corepack pnpm@11.24.0 harness:sync --check
corepack pnpm@11.24.0 release:smoke
```

只报告实际执行过的验证。当前机器不能替代其他操作系统的真机安装与运行结论。

测试断言的是行为，不是源码文本。对仓库源码做字符串匹配的「测试」不执行任何代码，抓不到行为回归，却会被 `cargo fmt`、重命名和无害重构打断。只有两种情况例外：一是**否定约束**（某段代码不得出现），编译器无法表达且没有别的兜底；二是断言打在**产物**上（生成的配置、workflow YAML、无法在本机运行的平台脚本），那里没有可执行的替代路径。除此之外，值得固定的行为写成会真正运行它的测试。

## Git

- 本仓库独立提交；不要从 SpringOpen 父仓库暂存或提交本目录。
- 提交前检查 `git status --short`、`git diff --check` 和实际 staged diff。
- `target/`、`dist/`、`release/`、诊断、工具链缓存和上游审计检出不得进入提交。
- 不提交 `.env`、凭据、用户工作区数据或含本机绝对路径的生成文件。

## 测试范围

只维护 Desktop 自有行为和必要的官方集成边界：凭据隔离、内核候选/回滚、依赖闭包、用户插件同步、发布身份/制品、Shell 交互及实际兼容补丁。不要复制上游测试套件，不为无桌面补丁的上游 CSS 另造模拟页面；实验 Controller/Worker、Docker/Parallels 编排不进入日常回归。同类短测试归入现有边界文件。`release:smoke` 验证正式 GitHub 发布的身份、版本、资产和说明，不再测试实验 HTTP 发布服务。
