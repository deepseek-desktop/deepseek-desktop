# DeepSeek Desktop

[![社区版构建](https://github.com/deepseek-desktop/deepseek-desktop/actions/workflows/community-build.yml/badge.svg)](https://github.com/deepseek-desktop/deepseek-desktop/actions/workflows/community-build.yml)
[![许可证](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

DeepSeek Desktop 是内置锁定版本本地 Runtime 的独立、非官方社区桌面应用。用户无需另外安装 Node.js、pnpm、Rust 或其他框架应用。本项目与 DeepSeek 不存在隶属、合作或官方背书关系。

源码默认和文档示例版本固定为 `1.0.0`，实际发行版本以 GitHub Releases 为准。macOS 安装包使用完整的 ad-hoc 签名，但没有 Apple Developer ID 身份和公证；Windows、Linux 社区版产物目前也没有可信发布者签名。桌面自有源码采用 Apache-2.0，内置 Runtime、Node.js 和 npm 依赖保留各自许可证声明。

安装包发布在 [GitHub Releases](https://github.com/deepseek-desktop/deepseek-desktop/releases)。安装前请使用同版本 `SHA256SUMS` 校验文件完整性。

## 界面预览

![DeepSeek Desktop 工作台](docs/assets/workbench.png)

![DeepSeek Desktop 模型接入](docs/assets/model-provider.png)

![DeepSeek Desktop 插件市场](docs/assets/plugin-market.png)

## 快速使用

1. 从 GitHub Releases 下载当前系统对应的安装包，完成安装后启动 DeepSeek Desktop。
2. 首次使用时选择工作区。Agent 的文件读写和命令执行均以该目录为边界。
3. 进入工作台的“设置 → 模型”，添加官方或自定义 Provider，填写 API 地址和密钥，并获取可用模型。
4. 在对话输入区切换模型，创建会话后即可进行对话、代码修改和工作区文件操作。
5. 在“设置 → 插件”中打开 DSH Market，浏览、安装、更新或卸载插件；桌面版已内置所需包管理器。
6. 通过系统“视图”菜单在“工作台”和“桌面管理”之间切换。运行异常时可在“诊断”页分别导出脱敏日志或诊断包。

模型密钥会加密保存在本机，不进入日志、诊断包或浏览器存储。完整安装、配置和故障排查说明见[中文使用文档](docs/zh-CN/getting-started.md)。

### macOS 提示“Apple 无法验证”怎么办

当前社区版尚未使用 Apple Developer ID 签名和公证，因此首次打开时，macOS 可能提示“Apple 无法验证 DeepSeek Desktop 是否包含可能危害 Mac 安全或泄漏隐私的恶意软件”。该提示本身不代表应用已被检测出恶意代码。请只从本项目的 [GitHub Releases](https://github.com/deepseek-desktop/deepseek-desktop/releases) 下载，并核对同版本 `SHA256SUMS`。

**普通用户：**

1. 将 `DeepSeek Desktop.app` 拖入“应用程序”目录。
2. 在“访达 → 应用程序”中找到 DeepSeek Desktop，按住 `Control` 点击或右键点击应用，选择“打开”。
3. 在再次出现的确认框中选择“打开”。完成一次确认后，后续可正常双击启动。
4. 如果确认框中仍没有“打开”，先点“完成”，再进入“系统设置 → 隐私与安全”，在“安全性”区域找到被阻止的 DeepSeek Desktop，点击“仍要打开”并完成系统验证。

**开发者：**确认安装包来源和 SHA-256 无误后，按以下两步操作。

1. 仅移除 DeepSeek Desktop 的下载隔离标记：

```bash
xattr -dr com.apple.quarantine "/Applications/DeepSeek Desktop.app"
```

2. 启动 DeepSeek Desktop：

```bash
open "/Applications/DeepSeek Desktop.app"
```

不要关闭 macOS 的全局 Gatekeeper、SIP 或 XProtect，也不要对“下载”目录批量移除隔离标记；这些操作会降低整台 Mac 的安全性。

## 架构

```text
Vue 桌面 Shell
  -> 单一原生窗口与隔离工作台 WebView
  -> 类型化 Tauri 命令与脱敏 Runtime 事件
Rust Runtime 管理器
  -> 对应平台的 Node sidecar
  -> 构建时锁定版本的 Runtime 生产依赖闭包
  -> http://127.0.0.1:<随机端口>
桌面 CredentialProvider
  -> 短期会话 + stdin/stdout JSON
  -> 桌面 helper
  -> 本地加密凭据库
```

桌面端只创建一个操作系统窗口。Runtime 就绪后，工作台会在隔离子 WebView 中占满内容区，不保留重复工具栏。原生“视图”菜单可在“工作台”（`Cmd/Ctrl+1`）和“桌面管理”（`Cmd/Ctrl+2`）之间切换；设置、诊断、更新和 Runtime 恢复均在原窗口完成。应用退出时会保存窗口位置、尺寸和全屏状态；下次启动优先恢复到上次使用的显示器，对外接屏幕用户更友好。

工作台 WebView 不获得 Tauri shell、文件系统或通用 IPC 权限，只能访问受管回环 Origin。每次 Runtime 启动都会生成短期凭据会话，真实 token 仅通过标准输入交付，应用数据目录只保存 SHA-256 授权摘要。Runtime 启动后会移除 Helper 相关环境变量，避免普通工具子进程继承短期会话。macOS、Windows 和 Linux 使用同一套 XChaCha20-Poly1305 加密凭据库，并采用原子替换、跨进程锁和私有 Unix 文件权限；不会降级写入 `.env`、YAML、浏览器存储或明文凭据文件。凭据库以当前操作系统用户为信任边界，不能防御已取得同一用户文件权限的恶意程序或 Agent 工具。

## 工具链

- Node.js `24.16.0`
- pnpm `11.7.0`
- Rust `1.98.0`
- Tauri CLI `2.11.4`
- 本地开发默认选择 Harness 仓库最新的 SemVer 标签；社区版和正式发布只接受仓库内经过审计的固定提交

`scripts/with-rust.mjs` 会把 Rust 安装到仓库的 `target/deepseek-desktop-toolchain/`，下载时校验 Rust 官方发布的 `rustup-init` SHA-256，并确认实际 `rustc` 版本与 lock 一致，不会修改用户的全局 Rust 环境。

## 本地开发

```bash
git clone git@github.com:deepseek-desktop/deepseek-desktop.git
cd deepseek-desktop
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 app:sync
corepack pnpm@11.7.0 runtime:sync
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 test:e2e
corepack pnpm@11.7.0 runtime:smoke
corepack pnpm@11.7.0 tauri:dev
```

`runtime/toolchain-lock.json` 固定 Node、Rust、原生依赖、桌面补丁和发布允许的 Runtime 来源。`RUNTIME_REF` 留空时，本地 `runtime:sync` 自动选择仓库中最新的 SemVer 版本标签；显式填写时则使用指定 tag、commit 或开发分支。两种方式都会解析并锁定不可变 commit，并把请求 ref、最终 ref、commit、动态 CLI 入口和 Runtime 哈希写入不提交 Git 的 `target/generated/runtime-lock.json`。社区版和正式发布额外要求解析结果匹配 `runtime/toolchain-lock.json` 中经过审计的固定仓库与提交；上游出现新版本时必须先复核并更新固定来源，不能在无人审查时自动改变安装包内容。Runtime staging 只消费该生成 lock，并且只保留当前原生目标。

staging 会下载目标平台的 Node.js 官方归档到仓库 `target/` 缓存，校验固定 SHA-256，移除安装期时间元数据和非目标平台原生制品，并输出确定性的 `runtime-manifest.json`、`licenses.json` 与 `sbom.spdx.json`。各平台允许使用的 `node-pty` 和 Koffi 原生制品固定在 `runtime/toolchain-lock.json`。

发布稳定性验证可设置 `DEEPSEEK_DESKTOP_SMOKE_CYCLES=100` 后执行 `runtime:smoke`。`DEEPSEEK_DESKTOP_DATA_DIR` 只用于隔离验收数据；正式用户无需配置，应用会自动使用 Tauri 对应平台的数据目录。

桌面 Shell 支持 `zh-CN`、`zh-TW` 和 `en-US`。当前 Runtime 的工作台界面只提供 `zh` 和 `en`，启动桥会把两种中文桌面语言映射到上游中文，把英文映射到上游英文，并原子更新 `dsh/settings.yaml`，不覆盖其他设置或注释。

## 一键打包

推送版本标签前，先在 macOS 本机和 Windows 虚拟机分别执行：

```bash
corepack pnpm@11.7.0 release:preflight
```

该命令先使用与 GitHub Actions 相同的 Playwright Ubuntu 镜像、Node.js 和 pnpm 版本，在 `linux/amd64` Docker 容器中运行质量门禁；随后构建当前操作系统的原生安装包。Docker 负责提前发现通用脚本、依赖、Runtime、Rust、前端和端到端测试问题，macOS 与 Windows 原生步骤负责验证 Docker 无法模拟的 Tauri、WebView、DMG / NSIS 和进程窗口行为。两台环境都通过后再推送版本标签。

Docker 预检固定使用与 GitHub Ubuntu runner 一致的 `linux/amd64` 架构。Apple Silicon 会通过 Docker Desktop 模拟 x64，但直接复用锁定 Playwright 镜像中的浏览器，不重复下载和解压。跨架构模拟下仅将 Runtime 进程 smoke 顺延到紧接着执行的 macOS 原生打包门禁；Runtime 组装、校验、Rust、前端和端到端测试仍会在容器中执行，GitHub 原生 Linux x64 任务不会跳过 Runtime smoke。

只运行容器质量门禁时使用：

```bash
corepack pnpm@11.7.0 preflight:docker
```

在仓库根目录执行：

```bash
corepack pnpm@11.7.0 package:community
```

该命令会安装固定依赖及锁定版本所需的 Chromium Headless Shell，执行应用配置与 Runtime 同步、社区版发布门禁、单元测试、端到端测试、Runtime 校验和 smoke，并构建当前操作系统与架构的安装包。最终文件写入 `release/<version>/<target>/`，同时生成目标平台对应的 `BUILD-INFO.<target>.json` 和 `SHA256SUMS`。打包结束前还会流式扫描前端、平台 Runtime、生成配置、原生 bundle 和主程序，阻断 `.env`、本机绝对路径、真实凭据、私钥及符号链接，并把扫描摘要写入 `BUILD-INFO`。本地浏览器缓存默认位于 `target/playwright-browsers/`；Docker 复用版本锁定的 Playwright 镜像浏览器，GitHub 纯净构建机复用平台级浏览器缓存，三者均由同一打包编排负责依赖准备。macOS 安装包由 Tauri 生成 `.app` 后直接通过 `hdiutil` 创建，不依赖 Finder 或 AppleScript，适合本地终端和 GitHub 无界面构建环境。

制作不要求干净 Git 工作区的本地定制包时使用：

```bash
corepack pnpm@11.7.0 desktop:package
```

可复制 `.env.example` 为 `.env` 来定制应用元数据和 Runtime 来源。配置优先级为“命令行环境变量 > `.env` > 内置默认值”；`.env` 不会进入 Runtime、安装包、诊断包或发布目录。`RUNTIME_REF` 默认留空，本地开发会自动选择最新版本标签；社区版和正式发布仍受仓库内固定 Runtime 来源约束。`DESKTOP_APP_REPOSITORY` 默认留空：GitHub Actions 使用当前工作流仓库地址，本地开发读取公开的 Git `origin`；若 `origin` 只是本机路径，则继续读取 `package.json` 或项目内置仓库地址。作者和仓库地址会显示在关于页，仓库地址可直接用系统浏览器打开。

## Runtime 独立更新

DeepSeek Desktop 将桌面外壳与 Harness Runtime 分开更新。安装包内始终保留一份经过构建验证的 Runtime；可信更新服务可另外发布 macOS arm64、macOS x64、Windows x64 和 Linux x64 的原生 Runtime 生产闭包。用户机器只下载当前平台的压缩制品，不拉取源码、不安装构建工具，也不在本机编译 Runtime。

“桌面管理 → 更新”提供三种方式：自动下载并在下次启动安装、发现后提醒、仅手动检查；也可以固定当前 Runtime 或恢复安装包内置版本。候选版本只有在未过期且未重放的签名清单、发布者、仓库、平台、协议、桌面版本范围、Node ABI、凭据插件、DSH Market、大小和 SHA-256 全部匹配后才会进入 staging。下次启动会在隔离目录真实启动本地服务并完成 readiness、HTTP 探活和工作区注册，再原子切换；启动失败或运行恢复达到上限时自动回滚上一版，上一版不可用时回到安装包内置版。更新器只保留当前、上一版和待安装版本，并清理中断的 staging。更新目录只位于系统应用数据目录，不修改应用安装目录。

默认 `.env.example` 没有配置更新清单和公钥，因此不会连接任何 Runtime 更新服务。发行维护者必须配置 `RUNTIME_UPDATE_MANIFEST_URL`、`RUNTIME_UPDATE_PUBLIC_KEY` 和可信发布者；显式设置 `RUNTIME_REF` 的开发构建默认关闭自动下载，避免联调版本被替换。清单可放在 filesystem/NAS、普通 HTTPS 静态站点、GitHub、GitLab、Gitee、Gitea 或自建服务，不依赖 GitHub Release API。完整用户行为、安全边界、清单格式和发布命令见 [Runtime 独立更新指南](docs/zh-CN/runtime-updates.md)。

单台主机只构建其原生目标。默认和示例版本始终使用 `1.0.0`。符合 SemVer 的标签都会触发 GitHub Actions，可带或不带 `v` 前缀，例如 `1.0.0`、`v1.0.0`、`v0.1.0-community.13`；完整 SemVer 校验会在构建开始时执行，非法标签不会进入发行。全部平台通过后统一发布 macOS arm64/x64、Windows x64 和 Linux x64 安装包。发布构建从标签注入真实版本，不需要修改源码中的默认或示例版本。

## 分布式本地发布

仓库内置平台无关的本地发布系统，不要求 GitHub Actions、自托管 Runner、虚拟机，也不要求任何一位开发者同时拥有四种系统。macOS ARM64、macOS Intel、Windows x64 和 Linux x64 节点只领取本机能够原生完成的任务；Controller 锁定 tag、Desktop commit、Runtime commit 和目标平台，校验各节点上传的 `BUILD-INFO`、目标类型、大小与 SHA-256，全部目标齐备后再汇总发布。

Apple Silicon Mac 也可以把同一台物理电脑上的原生 macOS、Rosetta、Docker 和 Parallels Windows 作为四个隔离 Worker，一条命令并行生成四平台安装包。首次使用先确认环境：

```bash
corepack pnpm@11.7.0 release:local-all -- --check
```

检查通过且版本 tag 已存在、指向当前干净 HEAD 并已推送到源码仓库后执行：

```bash
corepack pnpm@11.7.0 release:local-all -- --tag v1.0.0
```

该入口会自动准备经过 SHA-256 校验的 macOS x64 Node，复用 Docker 构建 Linux x64，并自动识别单个 Parallels Windows 虚拟机；四个 Worker 仍调用现有 `package:community`，一次性票据只通过标准输入传递，跨环境连接使用本次运行临时生成的 TLS。默认产物汇总到 `release/local-all/<tag>/`，各目标耗时写入 `target/local-release/runs/<run-id>/summary.json`。机器配置不同时可复制 `.deepseek-release.local.example.json` 为不提交 Git 的 `.deepseek-release.local.json`。这是一台物理机上的多环境编排，不会把 Windows 或 Linux 安装包伪装成 macOS 直接交叉编译的结果。

常用命令如下：

```bash
# 发布维护者：启动本地 Controller；默认仅监听本机回环地址
corepack pnpm@11.7.0 release:controller

# 各构建节点：查看本机自动识别出的节点 ID 和原生目标
corepack pnpm@11.7.0 release:worker -- --identify

# 发布维护者：从已存在且指向当前干净 HEAD 的 tag 创建四平台任务
corepack pnpm@11.7.0 release:create -- --tag v1.0.0 \
  --trusted-node macos-arm64=mac-arm-node.macos-arm64 \
  --trusted-node macos-x64=mac-intel-node.macos-x64 \
  --trusted-node windows-x64=windows-node.windows-x64 \
  --trusted-node linux-x64=linux-node.linux-x64

# 构建节点：使用私下收到的一次性票据领取并完成本机任务
corepack pnpm@11.7.0 release:worker -- \
  --controller https://release-controller.example \
  --node-id mac-arm-node.macos-arm64 \
  --token-file /private/path/macos-arm64.token

# 发布维护者：全部任务完成后默认发布到本地文件系统或 NAS
corepack pnpm@11.7.0 release:publish -- \
  --release <release-id> \
  --provider filesystem \
  --destination /Volumes/releases/deepseek-desktop
```

源码可通过 `release:create --source <通用 Git URL>` 指向 GitHub、GitLab、Gitee、Gitea 或其他标准 Git 服务。构建与发布上传完全解耦；filesystem 是默认 Provider，GitHub 只是可选 Provider。跨机器运行 Controller 时必须配置 TLS，任务票据只能私下交给预先登记的受信任节点。公开 Pull Request 不会触发或授权本地 Worker 执行代码。

完整的单机四环境准备、多节点部署、TLS、任务重试、Linux 可选旧基线容器、filesystem/GitHub Provider 和故障恢复说明见[分布式本地发布指南](docs/zh-CN/distributed-release.md)。

## 发布边界

当前社区版没有安装包可信发布者身份，因此桌面应用安装包自动更新保持关闭。Runtime 独立更新是另一条边界：只有构建时明确配置可信 Ed25519 清单与发布者的发行版才会启用，未配置时不联网检查。macOS 产物只有 ad-hoc Bundle 签名，没有 Apple Developer ID 签名和公证。未来 Stable 桌面版本必须通过 `pnpm release:check stable`，提供 Updater、Apple 和 Windows 签名材料，并完成对应平台的干净系统安装验收。

本地分布式节点或可选 CI 会构建 macOS arm64/x64、Windows x64 和 Linux x64 产物。macOS arm64 与 Windows x64 还必须完成真实安装、启动、正常退出、孤儿进程、卸载和重装验收；某个平台构建成功不代表其他平台已经完成安装验收。

应用鱼形标识沿用固定上游 Runtime 提交中的侧边栏几何与主墨色，仅用于识别内置 Runtime，不代表官方发行或品牌授权。

更完整的安装、模型配置、数据目录、安全和故障排查说明见 [中文使用文档](docs/zh-CN/getting-started.md)。
