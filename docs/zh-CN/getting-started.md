# DeepSeek Harness Desktop

DeepSeek Harness Desktop 是基于 DeepSeek Harness 固定版本 Runtime 构建的独立、非官方社区桌面发行版。它将 Vue 桌面 Shell、Tauri 2 原生主程序、固定版本 Node.js 和 Harness Runtime 打包在一起，不依赖 SpringOpen Application，也不要求用户预装 Node.js、pnpm 或 Rust。本项目与 DeepSeek 不存在隶属、合作或官方背书关系。

桌面 Shell、应用程序和安装包统一使用固定上游提交中的 Harness 侧边栏鱼形标识及其深色品牌墨色，仅用于识别内置 Runtime，不代表官方发行或品牌授权。

当前版本为 `0.1.0-community.3`。它是可本地完整使用的社区版；macOS 使用不关联开发者身份的 ad-hoc 完整签名，尚未完成 Apple Developer ID 签名、公证或 Windows Authenticode 签名，自动更新也未启用，因此不能作为已认证 Stable 版本宣传。

工程源码位于仓库根目录。Runtime 使用锁定的 npm 生产依赖闭包，并从 `runtime/runtime-lock.json` 指定的 Node.js 官方归档下载、校验 SHA-256 后生成 sidecar；每个平台制品同时包含确定性 Runtime manifest、完整许可证清单和 SPDX 2.3 SBOM。

## 支持平台

| 平台 | 构建产物 | 当前验收口径 |
| --- | --- | --- |
| macOS arm64 | `.dmg` | 本机完整构建与运行验收 |
| macOS x64 | `.dmg` | CI 原生构建，等待对应机器安装验收 |
| Windows x64 | NSIS `.exe` | CI 原生构建；已在 Windows 11 ARM64 的系统 x64 兼容层完成安装、启动、退出、卸载与重装验收 |
| Linux x64 | AppImage / `.deb` | CI 原生构建，等待对应发行版安装验收 |

当前社区版产物名称和发布说明必须明确带有 `community` / `unsigned`；其中 macOS 的 `unsigned` 表示没有 Apple Developer ID 身份签名和公证，不代表应用 Bundle 缺少本地 ad-hoc 完整性签名。社区版不能作为已认证 Stable 版本对外宣传。

## 首次使用

1. 启动 DeepSeek Harness Desktop，选择界面语言。
2. 选择一个明确的工作区。Agent 的文件操作和命令执行以该目录为边界。
3. 启动本地工作台。主程序会在 `127.0.0.1` 上申请随机端口，不需要填写端口。
4. 打开 Harness 的模型设置，选择 Provider，并写入 API Key 或 OAuth grant。
5. 创建会话并开始任务。模型未配置或外部 Provider 不可用时，Runtime 仍可进入设置和诊断页面，但真实模型请求不会被伪造成成功。

模型凭据由桌面专用 Credential Provider 写入本机加密凭据库。macOS、Windows 和 Linux 使用同一套 XChaCha20-Poly1305 认证加密、跨进程文件锁和原子写入机制，不访问系统钥匙串，也不会弹出系统凭据授权窗口。凭据库不可用或损坏时会明确失败，不会降级写入 `.credentials.yaml`、`.env`、日志、浏览器存储或其他明文文件。新增自定义 Provider 时，如果凭据写入失败，桌面 Runtime 会回滚本次新增的 Provider 配置，修复凭据库后可以直接重试，不会把失败的首次提交误报为 Provider ID 重复。

Desktop Shell 完整提供简体中文、繁体中文和英文。固定的 Harness `0.1.1-rc.2` 上游界面目前只提供 `zh` 和 `en`：启动 Runtime 时，桌面语言桥会将简体中文和繁体中文映射为上游中文，将英文映射为上游英文，并通过原子更新 `dsh/settings.yaml` 保留其他设置与注释。繁体中文用户看到的 Harness 工作区仍是上游简体中文；工程不会为了制造“全繁体”表象而直接改写上游构建产物。

受管 Harness 窗口会关闭输入框和可编辑区域的系统拼写检查、自动纠错、自动首字母大写和写作建议，确保 Provider ID、API 地址、模型名、代码和普通对话均按原文输入，不被 WebView 擅自替换。该策略只设置浏览器输入属性，不读取或改写输入值。

## Runtime 生命周期

Runtime 状态包括 `idle`、`starting`、`ready`、`stopping`、`recovering` 和 `failed`。启动超时为 20 秒；意外退出后最多自动恢复两次，退避为 1 秒和 3 秒。超过上限后进入失败页，并生成诊断关联编号。

主程序退出时会关闭完整 Node/Harness 进程树：macOS 和 Linux 使用独立进程组，并由 Runtime 监控桌面父进程是否仍存活；Windows 使用带 `KILL_ON_JOB_CLOSE` 的 Job Object。即使桌面主进程异常消失，Runtime 也会自行结束。Harness 页面只能访问当前受管回环 Origin，不获得 Tauri shell、文件系统或通用 IPC 权限。

## 数据目录

DeepSeek Harness Desktop 使用系统应用数据目录，不向安装目录写运行数据：

| 内容 | 说明 |
| --- | --- |
| `settings.json` | Shell 语言、主题、工作区和更新通道 |
| `dsh/` | Harness profile、会话、设置和插件数据 |
| `credential-vault.json` | XChaCha20-Poly1305 加密后的模型凭据，不包含可读明文 |
| `credential-vault.key` | 当前用户专用的本地凭据库密钥；Unix 权限固定为 `0600` |
| `credential-index.json` | 仅保存非敏感 record 索引，不保存密钥明文 |
| `credential-session.json` | 仅保存当前 Runtime 短期授权 token 的 SHA-256 摘要，不保存 token 或模型凭据 |
| `logs/` | 10 MB 单文件、最多 5 个轮转文件 |
| `backups/` | 设置更新前的最近备份 |
| `diagnostics/` | 用户主动导出的脱敏诊断文档 |
| `updates/` | 未来签名更新的临时目录 |

macOS 默认位于 `~/Library/Application Support/com.springopen.deepseek-harness-desktop/`；Windows 和 Linux 使用 Tauri 对应的平台应用数据目录。

加密凭据库以当前操作系统用户的数据目录权限作为本地信任边界：它可以避免密钥以明文出现在配置、日志、诊断或备份预览中，也不会触发反复授权弹窗；但已经控制同一操作系统用户账户的恶意程序仍可能读取应用数据。不要在多人共用同一系统账户的设备上保存生产密钥。

开发者执行隔离启动验收时可以临时设置 `DEEPSEEK_HARNESS_DESKTOP_DATA_DIR`，把测试数据写入指定目录。正式启动无需设置该变量，默认目录会自动创建，不增加用户配置负担。

## 诊断与隐私

诊断页面只在用户主动操作时导出状态、版本和最近日志。导出前会遮蔽 Authorization、API Key、Cookie、password、secret、Bearer token 和工作区路径。Credential Provider 调用 helper 时还必须携带每次 Runtime 启动生成的短期会话；真实 token 只通过 Runtime 标准输入交付，应用数据目录仅保存用于校验的 SHA-256 摘要，不进入命令参数、环境变量或日志。Agent Shell、工具子进程和 Harness WebView 均不能直接读取桌面主程序中的明文凭据。

出现启动失败时依次检查：

1. 所选工作区是否仍存在并可读写。
2. 诊断编号和导出的脱敏日志中是否出现 `runtime-artifact-missing`、`runtime-timeout`、`runtime-exited` 或 `restart-limit-reached`。
3. 应用数据目录中的加密凭据库是否可读写、是否被安全软件隔离或损坏。
4. 外部模型 Provider 的地址、模型名、账号权限和网络是否可用。

## 更新与卸载

当前社区版构建默认并强制关闭自动更新。工程已保留 Tauri Updater 和 GitHub Releases 签名检查实现，但只有安装包签名、Updater 私钥、公钥、Apple/Windows 证书全部就绪，Stable 构建门禁才允许继续；社区版配置不会请求更新地址或安装未签名产物。

卸载应用不会自动删除工作区或应用数据。需要完全清理时，先卸载 DeepSeek Harness Desktop，再由用户主动删除系统应用数据目录。曾安装 `0.1.0-community.1` 的 macOS 用户还可以在“钥匙串访问”中删除旧的 `com.springopen.dshdesktop.credentials` 条目；新版不会再读取这些旧条目。

## 开发者验证

完整构建命令、Runtime lock、测试入口和发行门禁见仓库根目录 `README.md`。本地验证至少包括三语 parity、语言桥保真测试、Vue 单测、Playwright Shell E2E、Rust 单测、Runtime manifest 校验、真实 Harness readiness smoke 和目标平台安装包构建。连续启停验收使用 `DEEPSEEK_HARNESS_DESKTOP_SMOKE_CYCLES=100 corepack pnpm@11.7.0 runtime:smoke`。

需要主动生成当前电脑对应的桌面安装包时，在仓库根目录执行：

```bash
corepack pnpm@11.7.0 package:community
```

该命令会自动安装锁定依赖，执行社区版发行门禁、单元测试、端到端测试、Runtime 校验和真实 readiness smoke，再构建当前操作系统及 CPU 架构对应的安装包。结果统一输出到 `release/<版本>/`，同时生成 `BUILD-INFO.json` 和 `SHA256SUMS`。macOS 会额外校验应用签名结构和 DMG 完整性。

单台电脑只生成当前平台安装包。维护者推送与工程版本完全一致的标签（例如 `v0.1.0-community.3`）后，GitHub 工作流会分别构建 macOS arm64、macOS x64、Windows x64 和 Linux x64；只有全部成功才会创建包含安装包和 `SHA256SUMS` 的 GitHub Release。
