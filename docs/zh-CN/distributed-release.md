# 分布式本地发布指南

DeepSeek Desktop 的分布式发布系统用开发者自己的原生计算机完成四平台构建。它不依赖 GitHub Actions、自托管 Runner 或某个代码托管平台，也不要求单个开发者安装虚拟机或拥有全部操作系统。

## 组成

```text
标准 Git 仓库
  -> Release Controller 锁定 tag / Desktop commit / Runtime commit / targets
  -> 一次性任务票据
  -> macOS ARM64 / macOS x64 / Windows x64 / Linux x64 原生 Worker
  -> 现有 app:sync / runtime:sync / verify / desktop:package
  -> Worker 扫描交付闭包，Controller 流式接收并校验目标、BUILD-INFO 和 SHA-256
  -> filesystem / NAS（默认）或可选 GitHub Provider
```

- **Controller**：保存发布状态、分配任务、签发一次性票据与短期租约、接收制品、校验来源、Worker 安全扫描摘要和完整性、汇总 `SHA256SUMS`、调用发布 Provider。HTTP 客户端为 JSON 响应和制品上传设置总时限，并限制响应大小，异常 Controller 不能无限占用 Worker。
- **Worker**：自动识别本机平台，只领取与本机原生目标一致的任务，从锁定 Git commit 做干净 detached checkout，再调用现有打包命令。
- **Provider**：只负责发布已经验证的制品。构建过程不知道最终上传到 filesystem、NAS 还是 GitHub。
- **targets 配置**：`scripts/release-system/targets.json` 是目标 ID、宿主平台、Rust triple 和安装包类型的唯一映射。

Controller 状态、一次性票据、Worker 临时检出和待发布制品均位于 `target/` 或系统临时目录，不提交 Git。Provider 只发布安装包与汇总后的 `SHA256SUMS`，不会把节点票据、租约、`BUILD-INFO`、本机路径或 `.env` 作为公开附件。

## 普通开发者

普通开发者仍然只需在自己的系统执行当前平台打包，不需要启动分布式服务：

```bash
corepack pnpm@11.7.0 desktop:package
```

该命令继续负责配置同步、Runtime 同步、验证、E2E、Runtime smoke 和当前原生平台安装包构建。分布式 Worker 复用的也是这条链路，没有第二套 Tauri 打包实现。

## 一台 Apple Silicon Mac 构建四平台

`release:local-all` 是分布式协议之上的单机便捷编排器。它把一台物理 Mac 中的四个隔离执行环境视为四个受信任节点：

| 目标 | 执行环境 | 产物 |
| --- | --- | --- |
| macOS ARM64 | 当前 macOS 原生 Node / Rust | ARM64 DMG |
| macOS x64 | Rosetta 2 + 锁定并校验的 x64 Node / Rust | Intel DMG |
| Linux x64 | Docker Desktop `linux/amd64` 容器 | AppImage、DEB |
| Windows x64 | Parallels Windows 中的 x64 Node / MSVC | NSIS EXE |

需要准备：

1. Apple Silicon Mac 已安装 Rosetta 2。
2. Docker Desktop 已启动。
3. Parallels Desktop 已安装 Tools；Windows 虚拟机中已有 x64 Node.js、Git、Corepack 和包含 C++ x64 工具的 Visual Studio Build Tools。
4. Windows 使用 Parallels Shared Network，并能访问宿主机地址；默认是 `10.211.55.2`。
5. 发行 tag 已存在、指向当前干净 HEAD，并已推送到 Worker 可访问的标准 Git 仓库。

先执行不会创建发行任务的真实网络与工具链检查：

```bash
corepack pnpm@11.7.0 release:local-all -- --check
```

该检查会自动下载 `runtime/toolchain-lock.json` 固定的 macOS x64 Node 归档并校验 SHA-256，准备或复用 Linux x64 Docker 镜像，检查 Windows x64 Node / Git / Corepack / MSVC，并让四个环境分别通过临时 TLS 请求同一个 Controller 健康接口。

检查通过后，一键创建、并行构建、校验和汇总四平台社区版：

```bash
corepack pnpm@11.7.0 release:local-all -- --tag v1.0.0
```

默认结果位于 `release/local-all/v1.0.0/`，每个 Worker 的真实耗时和最终状态位于 `target/local-release/runs/<run-id>/summary.json`。也可以只验证或构建一个目标：

```bash
corepack pnpm@11.7.0 release:local-all -- --check --target windows-x64
corepack pnpm@11.7.0 release:local-all -- --tag v1.0.0 --target linux-x64
```

机器设置与默认值不同时，将 `.deepseek-release.local.example.json` 复制为 `.deepseek-release.local.json`，修改 Docker 镜像、Windows 虚拟机名称、宿主机地址、Windows 工作目录或汇总目录。该本地文件已被 Git 忽略，不得放入密码、令牌或其他凭据。命令行的 `--windows-vm`、`--windows-host`、`--docker-image` 和 `--destination` 可以临时覆盖配置；`--rebuild-docker` 强制重建 Linux Worker 镜像。

Controller 只在本次运行期间监听，非回环流量始终使用临时 CA 签发的 TLS。Worker 票据绑定目标和节点，只通过进程标准输入传递，不写入 Docker 参数、Parallels 命令或日志。Controller 状态保存在对应 run 目录，构建失败时不会发布残缺目标。

这条命令证明的是一台物理机完成四种隔离环境打包，不等同于四种真实硬件验收。尤其 Apple Silicon 上的 Windows x64 与 Linux x64 使用系统模拟层，发行前仍应在目标系统完成安装、启动、Runtime、凭据和卸载验证。缺少任何环境时命令会明确失败，不会偷偷改用错误目标。

## 发布维护者

### 1. 准备 tag 和受信任节点

创建符合 SemVer 的 tag，并确保 tag 已推送到作为源码来源的标准 Git 仓库。发行任务要求 Desktop 工作区干净，tag 必须指向当前 HEAD。

每台节点先执行以下命令，把输出的 `nodeId` 和 `targetId` 私下交给发布维护者：

```bash
corepack pnpm@11.7.0 release:worker -- --identify
```

社区版与 Stable 任务必须把每个目标绑定到明确的受信任节点 ID。节点 ID 是审计身份；真正的领取授权来自仅向该节点分发、短期有效且只能使用一次的任务票据。

### 2. 启动 Controller

同机试用时直接执行：

```bash
corepack pnpm@11.7.0 release:controller
```

默认监听 `127.0.0.1:47821`，状态在 `target/release-controller/`，管理员令牌在权限为 `0600` 的 `admin-token` 文件中。命令只打印令牌文件路径，不打印令牌值。

多节点局域网或公网部署必须使用 TLS：

```bash
corepack pnpm@11.7.0 release:controller -- \
  --host 0.0.0.0 \
  --port 47821 \
  --tls-cert /private/path/controller.crt \
  --tls-key /private/path/controller.key
```

非回环地址没有 TLS 时 Controller 会拒绝启动。生产环境应使用组织签发或公开可信的证书，并通过防火墙、VPN 或零信任网络只允许受信任节点访问。不要把管理员令牌、Worker 票据或 TLS 私钥提交到仓库、聊天群或公开 CI 日志。

### 3. 创建发布任务

以下示例创建四平台社区版任务：

```bash
corepack pnpm@11.7.0 release:create -- \
  --controller https://release-controller.example:47821 \
  --admin-token-file /private/path/admin-token \
  --tag v1.0.0 \
  --trusted-node macos-arm64=mac-arm-node.macos-arm64 \
  --trusted-node macos-x64=mac-intel-node.macos-x64 \
  --trusted-node windows-x64=windows-node.windows-x64 \
  --trusted-node linux-x64=linux-node.linux-x64
```

默认源码来自当前仓库 `origin`。迁移到 GitLab、Gitee、Gitea 或其他 Git 服务时，只需指定普通 Git URL：

```bash
corepack pnpm@11.7.0 release:create -- \
  --controller https://release-controller.example:47821 \
  --admin-token-file /private/path/admin-token \
  --source ssh://git@git.example.com/team/deepseek-desktop.git \
  --tag v1.0.0 \
  --target linux-x64 \
  --trusted-node linux-x64=linux-node.linux-x64
```

Controller 会通过 `git ls-remote` 再次确认远程 tag 确实解析到计划中的完整 40 位 Desktop commit。Runtime 仓库、ref 和完整 commit 读取自当前 tag 内的 `runtime/toolchain-lock.json`，Worker 还会在构建前后重复核对。

命令会为每个目标写出独立的 `*.token` 文件。通过受控文件传输、密码管理器或组织密钥系统把每个文件交给对应节点，不要把四个票据放在公共共享目录。

### 4. 节点执行任务

节点只需执行一次命令：

```bash
corepack pnpm@11.7.0 release:worker -- \
  --controller https://release-controller.example:47821 \
  --node-id mac-arm-node.macos-arm64 \
  --token-file /private/path/macos-arm64.token
```

Worker 会：

1. 自动识别操作系统和 CPU 架构。
2. 使用目标绑定的一次性票据领取任务；成功领取后本地票据文件会删除，服务端票据立即失效。
3. 从通用 Git URL 克隆源码，detached checkout 到锁定 Desktop commit，并验证 tag 与干净状态。
4. 核对锁定 Runtime 仓库、ref 和 commit。
5. 调用现有 `package:community` 或 `desktop:package` 完成全部门禁与原生打包。
6. 流式上传安装包、`BUILD-INFO` 和平台 `SHA256SUMS`；上传过程同时校验声明大小和 SHA-256。
7. Worker 对前端、平台 Runtime、生成配置、原生 bundle 和主程序执行流式敏感信息扫描；Controller 验证扫描摘要、Desktop commit、Runtime commit、目标 triple、channel、signed、dirty 状态、安装包及敏感路径后才把任务标记为完成。

默认临时检出位于操作系统临时目录。排查失败时可增加 `--keep-work` 保留现场，也可用 `--work-root <目录>` 指定位置。

### 5. 查看、重试和发布

查看任务：

```bash
corepack pnpm@11.7.0 release:status -- \
  --controller https://release-controller.example:47821 \
  --admin-token-file /private/path/admin-token \
  --release <release-id>
```

失败或租约过期后，为单一目标生成替换票据：

```bash
corepack pnpm@11.7.0 release:retry -- \
  --controller https://release-controller.example:47821 \
  --admin-token-file /private/path/admin-token \
  --release <release-id> \
  --target windows-x64
```

旧票据和旧租约不能继续上传。Controller 会清理该目标已接收的不完整制品，其他已经完成的平台不需要重建。

全部目标为 `completed` 后，release 状态变为 `ready`。默认 filesystem Provider 可写入本机目录、挂载的 NAS 或共享磁盘：

```bash
corepack pnpm@11.7.0 release:publish -- \
  --controller https://release-controller.example:47821 \
  --admin-token-file /private/path/admin-token \
  --release <release-id> \
  --provider filesystem \
  --destination /Volumes/releases/deepseek-desktop
```

目标目录按 tag 分组。Provider 使用临时目录完成复制后再原子改名，已存在的同名发行不会被静默覆盖。

## 可选 GitHub Provider

GitHub 只是发布适配器，不参与 Worker 构建。先在 Controller 主机的私有环境中设置令牌：

```bash
export DISTRIBUTED_RELEASE_GITHUB_TOKEN='<GitHub token>'
```

再执行：

```bash
corepack pnpm@11.7.0 release:publish -- \
  --controller https://release-controller.example:47821 \
  --admin-token-file /private/path/admin-token \
  --release <release-id> \
  --provider github \
  --repository owner/deepseek-desktop
```

GitHub Provider 调用本机 `gh`，令牌只从 Controller 进程环境读取，不写入 Controller 状态或发布附件。未来 GitLab、Gitee 或 Gitea Provider 可以实现同一个发布接口，不需要修改 Worker 和打包链路。

## Linux 可选旧基线容器

Linux Worker 默认在真实 Linux x64 主机原生构建。需要控制 glibc 等兼容基线时，可以显式提供已经安装本项目固定工具链和 WebKitGTK 依赖的容器镜像：

```bash
corepack pnpm@11.7.0 release:worker -- \
  --controller https://release-controller.example:47821 \
  --node-id linux-node.linux-x64 \
  --token-file /private/path/linux-x64.token \
  --container-image organization/deepseek-desktop-linux-builder:1.0.0
```

`--container-image` 只允许 Linux 目标显式使用，不是普通开发者或其他平台的依赖。缺少 Linux 节点时任务保持 `waiting`，Controller 不会用 macOS 或 Windows 交叉生成 Linux 安装包。

## 安全与故障恢复

- Stable 和社区版任务必须绑定受信任节点；本地试验 channel 才允许不绑定节点 ID。
- 一次性票据默认 30 分钟有效，只能领取一个固定目标；领取后换取默认 6 小时有效、绑定任务的租约。
- Controller 仅保存票据和租约的 SHA-256 摘要，不保存明文凭证。
- 源码必须来自不含嵌入凭据的标准 Git URL；tag、Desktop commit、Runtime commit 和目标均写入不可变任务计划。
- Worker 只能上传与目标配置匹配的安装包、一个 `BUILD-INFO.<triple>.json` 和一个 `SHA256SUMS`。
- Controller 拒绝脏 Desktop 来源、错误 Runtime、错误目标、大小或哈希不一致、`.env`、API Key 和常见本机用户绝对路径。
- 公开 Pull Request、外部分支或代码托管 Webhook 不会自动创建票据，也不会让本地节点执行代码。发布维护者必须在干净、已审查且已打 tag 的源码上手工创建任务。
- Controller 状态应定期备份到受控存储。恢复时使用同一状态目录重新启动；已完成任务保留，失败或过期任务通过 `release:retry` 单独恢复。
- `release:publish` 只接受所有目标均完成的 release。某类节点缺失时状态会明确显示 `waiting`，不会静默降级到错误平台或缺少安装包的发行。

## 本地协议验证

不构建真实安装包即可验证 Controller、一次性票据、HTTP 流式上传、来源校验和 filesystem Provider：

```bash
corepack pnpm@11.7.0 release:smoke
```

涉及发布系统的改动还应运行现有完整验证：

```bash
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 test:e2e
corepack pnpm@11.7.0 runtime:smoke
```
