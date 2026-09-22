# 参与贡献

感谢你帮助改进 DeepSeek Desktop。

## 提交修改前

1. 先搜索已有 Issue 和 Pull Request。
2. 每次修改只聚焦一个行为或工程问题。
3. 禁止提交凭据、本地工作区、生成的 Harness 暂存目录、构建产物或上游审计检出。
4. 除非本次修改明确升级 Harness，并同步更新校验和、许可证、测试和文档，否则保持锁定 Harness 契约不变。

## 开发环境

- Node.js `24.20.0`
- pnpm `11.24.0`
- npm `11.19.0`（随固定 Node 官方归档提供）
- Rust `1.98.0`
- Tauri CLI `2.11.4`
- 本地开发默认选择 Harness 仓库最新的 SemVer 标签，暂时仅忽略 `alpha`、`beta`，允许 `rc` 及其他类型；社区版和正式发布只接受仓库内经过审计的固定提交

`scripts/with-rust.mjs` 会把 Rust 安装到仓库的 `target/deepseek-desktop-toolchain/`，下载时校验 Rust 官方发布的 `rustup-init` SHA-256，并确认实际 `rustc` 版本与 lock 一致，不会修改用户的全局 Rust 环境。

先安装依赖：

```bash
corepack pnpm@11.24.0 install --frozen-lockfile
```

以下命令按任务选择，无需每次全部执行：

| 目的 | 命令 |
| --- | --- |
| 启动桌面开发环境 | `corepack pnpm@11.24.0 tauri:dev` |
| 完整构建当前平台桌面应用 | `corepack pnpm@11.24.0 run build` |
| 只构建前端 | `corepack pnpm@11.24.0 frontend:build` |
| 配置、前端、Harness 与 Rust 检查 | `corepack pnpm@11.24.0 verify` |
| 安装 E2E 所需浏览器 | `corepack pnpm@11.24.0 playwright:install` |
| 桌面 Shell 端到端测试 | `corepack pnpm@11.24.0 test:e2e` |
| 真实 Harness 启停与设置检查 | `corepack pnpm@11.24.0 harness:smoke` |

涉及发行的修改须完成 `verify`、`test:e2e` 和 `harness:smoke`。安装包相关修改再执行当前原生平台打包验收。正式多平台发布使用 GitHub 官方 Runner，不要求本机虚拟机、Rosetta 或 Docker。

## Harness 构建与配置

`pnpm install` 按根目录 lock 安装固定依赖；标准 `pnpm run build` 会依次生成应用配置、从当前 Harness lock 安装依赖并执行官方 `build:official`、组装生产闭包、暂存目标平台 Harness，再调用 Tauri 构建。`verify` 和 `test:e2e` 也会在消费 Harness 前重新同步，因此不会读取历史 `target/generated` 中可能过期、损坏或不完整的依赖树；Playwright 启动预览时只调用 `frontend:build`，避免在服务器启动时重复触发完整桌面打包。

`harness/toolchain-lock.json` 固定 Node、Rust、原生依赖、桌面补丁和发布允许的 Harness 来源。`HARNESS_REF` 留空时，本地 `harness:sync` 自动选择仓库中最新的 SemVer 版本标签（暂时仅忽略 `alpha`、`beta`，允许 `rc` 及其他类型）；显式填写时则使用指定 tag、commit 或开发分支。两种方式都在依赖安装和构建前检查实际 CLI 版本，拒绝 `alpha`、`beta`，显式 pin 和本地源码也不例外；随后解析并锁定不可变 commit，并把请求 ref、最终 ref、commit、动态 CLI 入口和 Harness 哈希写入不提交 Git 的 `target/generated/harness-lock.json`。社区版和正式发布额外要求解析结果匹配 `harness/toolchain-lock.json` 中经过审计的固定仓库与提交；上游出现新版本时必须先复核并更新固定来源，不能在无人审查时自动改变安装包内容。Harness staging 只消费该生成 lock，并且只保留当前原生目标。

复验当前发行基线时，显式将 `HARNESS_REF` 设为工具链 lock 的 `harnessSource.ref`。过滤后最新候选可能早于内置基线；不要为了匹配候选标签自动回退内核、扩展 peer 或兼容补丁。

staging 会下载目标平台的 Node.js 官方归档到仓库 `target/` 缓存，校验固定 SHA-256，保留锁定的 npm 与当前平台构建所需的最小 Node-API 头文件，移除安装期时间元数据和非目标平台原生制品，并输出确定性的 `harness-manifest.json`、`licenses.json` 与 `sbom.spdx.json`。各平台允许使用的 `node-pty` 和 Koffi 原生制品固定在 `harness/toolchain-lock.json`。

发布稳定性验证可设置 `DEEPSEEK_DESKTOP_SMOKE_CYCLES=100` 后执行 `harness:smoke`。`DEEPSEEK_DESKTOP_DATA_DIR` 只用于隔离验收数据；正式用户无需配置，应用会自动使用 Tauri 对应平台的数据目录。

桌面 Shell 支持 `zh-CN`、`zh-TW` 和 `en-US`。当前 Harness 的工作台界面只提供 `zh` 和 `en`，启动桥会把两种中文桌面语言映射到上游中文，把英文映射到上游英文，并原子更新 `dsh/settings.yaml`，不覆盖其他设置或注释。

## 当前平台打包

在仓库根目录执行：

```bash
corepack pnpm@11.24.0 package:community
```

该命令会安装固定依赖及锁定版本所需的 Chromium Headless Shell，执行应用配置与 Harness 同步、社区版发布门禁、单元测试、端到端测试、Harness 校验和 smoke，并构建当前操作系统与架构的安装包。最终文件写入 `release/<version>/<target>/`，同时生成目标平台对应的内部 `BUILD-INFO.<target>.json` 和 `SHA256SUMS`。打包结束前还会扫描实际交付闭包，阻断 `.env`、本机绝对路径、真实凭据、私钥及逃逸符号链接。macOS 安装包由 Tauri 生成 `.app` 后直接通过 `hdiutil` 创建，不依赖 Finder 或 AppleScript。

制作不要求干净 Git 工作区的本地定制包时使用：

```bash
corepack pnpm@11.24.0 desktop:package
```

可复制 [`.env.example`](.env.example) 为 `.env` 来定制应用元数据和 Harness 来源。配置优先级为“命令行环境变量 > `.env` > 内置默认值”；`.env` 不会进入 Harness、安装包、诊断包或发布目录。`HARNESS_REF` 默认留空，本地开发会自动选择最新的非 alpha/beta 版本标签；社区版和正式发布仍受仓库内固定 Harness 来源约束。`DESKTOP_APP_REPOSITORY` 默认留空：GitHub Actions 使用当前工作流仓库地址，本地开发读取公开的 Git `origin`；若 `origin` 只是本机路径，则继续读取 `package.json` 或项目内置仓库地址。作者和仓库地址会显示在关于页，仓库地址可直接用系统浏览器打开。

正式发行步骤见 [多平台发布指南](docs/zh-CN/distributed-release.md)，正文格式与维护方式见 [发布说明规范](docs/releases/README.md)。

## 架构与安全边界

```text
Vue 桌面 Shell
  -> 单一原生窗口与隔离工作台 WebView
  -> 类型化 Tauri 命令与脱敏 Harness 事件
Rust Harness 管理器
  -> 对应平台的 Node sidecar
  -> 构建时锁定版本的 Harness 生产依赖闭包
  -> 应用数据目录中的独立运行目录
  -> http://127.0.0.1:<随机端口>
桌面 CredentialProvider
  -> 短期会话 + stdin/stdout JSON
  -> 桌面 helper
  -> 本地加密凭据库
```

桌面端只创建一个操作系统窗口。Harness 就绪后，工作台会在隔离子 WebView 中使用菜单栏下方的全部内容区。Desktop 只负责 Harness 生命周期、更新、凭据和原生窗口，不保存或注册用户项目目录；项目目录由 Harness 工作台自己的会话和工作区能力管理。Harness 从应用数据目录内的独立运行目录启动，避免把 Desktop 壳的路径语义传给 Harness。macOS、Windows 和 Linux 都在窗口内容区顶部固定显示唯一的“文件 / 编辑 / 视图 / 窗口 / 帮助”菜单标题，展开项使用各平台原生菜单；不会向 Harness 页面注入菜单或桌面命令。设置、诊断、Desktop 更新、Harness 更新和关于均在当前窗口的设置层中打开。打开设置只隐藏工作台，关闭设置直接恢复同一个工作台页面，不重新导航、不丢失会话状态。macOS 系统菜单栏仅保留系统要求的最小应用菜单，Windows/Linux 不再挂载重复的完整窗口菜单。应用退出时会保存窗口位置、尺寸和最大化状态，但不会自动恢复全屏；下次启动优先恢复到上次使用的显示器，原显示器已断开时自动回到当前可见显示器。

工作台 WebView 不获得 Tauri shell、文件系统或通用 IPC 权限，只能访问受管回环 Origin。每次 Harness 启动都会生成短期凭据会话，真实 token 仅通过标准输入交付，应用数据目录只保存 SHA-256 授权摘要。Harness 启动后会移除 Helper 相关环境变量，避免普通工具子进程继承短期会话。macOS、Windows 和 Linux 使用同一套 XChaCha20-Poly1305 加密凭据库，并采用原子替换、跨进程锁和私有 Unix 文件权限；不会降级写入 `.env`、YAML、浏览器存储或明文凭据文件。凭据库以当前操作系统用户为信任边界，不能防御已取得同一用户文件权限的恶意程序或 Agent 工具。

## Pull Request

- 文档、Issue / Pull Request 和发布说明以简体中文为主，必要时可附英文摘要。
- 说明用户可见行为和安全影响。
- 用户可见文案必须同时更新 `zh-CN`、`zh-TW` 和 `en-US`。
- 运行与改动范围匹配的检查，并附上结果。
- 工作台 WebView 不得获得通用 Tauri Shell、文件系统或 IPC capability。
- 未经真实验证，不得宣称已完成签名、公证、平台支持或外部 Provider 兼容。

提交贡献即表示你同意以 Apache-2.0 许可证提供该贡献。
