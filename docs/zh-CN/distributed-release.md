# 分布式本地发布指南

DeepSeek Desktop 的分布式发布系统用开发者自己的原生计算机完成四平台构建。它不依赖 GitHub Actions、自托管 Runner 或某个代码托管平台，也不要求单个开发者安装虚拟机或拥有全部操作系统。

## 组成

```text
标准 Git 仓库
  -> release:prepare 一次性完成公共门禁并生成签名准备凭据
  -> Release Controller 锁定 tag / Desktop commit / Runtime commit / targets / 准备凭据
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
- **发行准备凭据**：绑定不可变源码、Runtime、配置、补丁、lock、工具链与 channel；只能由仓库内 `release:prepare` 生成并由 Worker 复核，不能用环境变量伪造跳过测试。

Controller 状态、一次性票据、Worker 临时检出和待发布制品均位于 `target/` 或系统临时目录，不提交 Git。Provider 只发布安装包与汇总后的 `SHA256SUMS`，不会把节点票据、租约、`BUILD-INFO`、本机路径或 `.env` 作为公开附件。

## 普通开发者

普通开发者仍然只需在自己的系统执行当前平台打包，不需要启动分布式服务：

```bash
corepack pnpm@11.7.0 desktop:package
```

该命令继续负责配置同步、Runtime 同步、验证、E2E、Runtime smoke 和当前原生平台安装包构建。分布式 Worker 复用的也是这条链路，没有第二套 Tauri 打包实现。

正式发行先在干净、已打 tag 的源码上执行一次公共准备：

```bash
corepack pnpm@11.7.0 release:prepare -- --tag v1.0.0
```

准备阶段执行固定依赖安装、`app:sync`、`runtime:sync`、发行门禁、`verify` 和 E2E，并将经过核验的生成配置与公共 Runtime 闭包写入内容寻址缓存。输出的 descriptor 和签名 receipt 绑定 tag、Desktop/Runtime 完整 commit、目标集合、源码树、Runtime 补丁与 lock、精确 Node/ABI、Rust/pnpm/Tauri 版本、channel、签名模式、dirty 状态和 24 小时有效期。Worker 仍调用 `desktop:package`，但只有 receipt 与任务完全一致时才省略已经完成的公共门禁；否则自动回到完整构建或拒绝正式发行。

## 一台 Apple Silicon Mac 构建四平台

`release:local-all` 是分布式协议之上的单机便捷编排器。它把一台物理 Mac 中的四个隔离执行环境视为四个受信任节点：

| 目标 | 执行环境 | 产物 |
| --- | --- | --- |
| macOS ARM64 | 锁定并校验的 ARM64 Node / Rust | ARM64 DMG |
| macOS x64 | Rosetta 2 + 锁定并校验的 x64 Node / Rust | Intel DMG |
| Linux x64 | 固定 `linux/amd64` Docker + 锁定 Node / Rust | AppImage、DEB |
| Windows x64 | Parallels Windows + 锁定 Node / MSVC | NSIS EXE |

需要准备：

1. Apple Silicon Mac 已安装 Rosetta 2。
2. Docker Desktop 已启动。
3. Parallels Desktop 已安装 Tools；Windows 虚拟机中已有 Git 和包含 C++ x64 工具的 Visual Studio Build Tools。四个平台的 Node.js 与 Corepack 都由编排器按 `runtime/toolchain-lock.json` 自动下载或准备、校验和复用，不读取宿主机或虚拟机全局 Node 版本。
4. Windows 使用 Parallels Shared Network，并能访问宿主机地址；默认是 `10.211.55.2`。
5. 发行 tag 已存在、指向当前干净 HEAD，并已推送到 Worker 可访问的标准 Git 仓库。

先执行不会创建发行任务的真实网络与工具链检查：

```bash
corepack pnpm@11.7.0 release:local-all -- --check
```

该检查会自动下载或准备 `runtime/toolchain-lock.json` 固定的四平台 Node 归档并校验 SHA-256、精确版本和 module ABI，准备或复用 Linux x64 Docker 镜像，检查 Windows Git / MSVC，并让四个环境分别通过临时 TLS 请求同一个 Controller 健康接口。每个 Worker 都必须输出实际 `node --version` 与 ABI；Parallels 预检异步运行，不能冻结同进程 Controller 的 TLS 响应。

检查通过后，一键创建、并行构建、校验和汇总四平台社区版：

```bash
corepack pnpm@11.7.0 release:local-all -- --tag v1.0.0 --concurrency 2
```

命令会先调用 `release:prepare`，成功后才创建任务和启动 Worker。默认并发根据宿主机内存自适应；16 GB Mac 建议使用 `--concurrency 2`，32 GB 可从 `3` 开始观察，任何机器都不建议盲目同时跑满四环境。

默认结果位于 `release/local-all/v1.0.0/`，准备阶段、每个 Worker、Runtime/Cargo 缓存状态、打包和发布的真实耗时与最终状态位于 `target/local-release/runs/<run-id>/summary.json`。也可以只验证或构建一个目标：

```bash
corepack pnpm@11.7.0 release:local-all -- --check --target windows-x64
corepack pnpm@11.7.0 release:local-all -- --tag v1.0.0 --target linux-x64
```

机器设置与默认值不同时，将 `.deepseek-release.local.example.json` 复制为 `.deepseek-release.local.json`，修改 Docker 镜像、Windows 虚拟机名称、宿主机地址、Windows 工作目录或汇总目录。该本地文件已被 Git 忽略，不得放入密码、令牌或其他凭据。命令行的 `--windows-vm`、`--windows-host`、`--docker-image` 和 `--destination` 可以临时覆盖配置；`--rebuild-docker` 强制重建 Linux Worker 镜像。

Controller 只在本次运行期间监听，非回环流量始终使用临时 CA 签发的 TLS。Worker 票据绑定目标和节点，只通过进程标准输入传递，不写入 Docker 参数、Parallels 命令或日志。Controller 状态保存在对应 run 目录，构建失败时不会发布残缺目标。

### 缓存与失败恢复

- Runtime 闭包缓存键包含 Runtime commit、Desktop Runtime 补丁/本地包、lock、工具链、Node ABI、目标 triple 和影响闭包的配置；命中前逐文件复核清单、大小和 SHA-256。
- 公共 Runtime 部署显式保留四个发行目标的 Koffi、Sharp/libvips 等可选原生包；每个 Worker 只在目标 staging 中保留与自身 triple 匹配的制品，避免准备主机架构决定其他平台的闭包。
- Cargo 使用按目标 triple、Rust flags 和签名模式隔离的持久 `CARGO_TARGET_DIR`；不同目标不会共享可执行输出。
- pnpm store、Playwright 浏览器、Docker 镜像和 volume、Node/Rust 工具链长期复用。只有 Dockerfile、系统依赖或工具链契约变化时才使用 `--rebuild-docker`。
- 当前精确 Node 锁为 `24.20.0`、module ABI `137`。缓存身份包含 Node 版本、ABI 和目标 triple；升级 lock 会自然使旧缓存失效。“最新 LTS”只能由维护者显式更新单一 lock，具体发行禁止动态解析未来版本。
- 缓存不完整、哈希不符或含符号链接时自动废弃并重建；不要用手工清空全部缓存解决普通源码错误。
- 同一 run 重试时只调度失败目标；已完成目标保留。filesystem/NAS 已汇总且校验通过后，远程 Provider 上传失败只重试 `release:publish`。
- 当前方案评估过 `sccache`，但暂未引入额外跨平台二进制分发和签名信任面；稳定、隔离的 Cargo target 已覆盖主要 Rust 增量收益。后续只有经过四平台固定版本验证才接入。

单机四环境编排会从当前干净 HEAD 生成只包含发行 tag 的本地 Git bundle，并让 Rosetta、Docker 和 Parallels Worker 从该 bundle 做 detached checkout。任务中仍保留并核验原始通用 Git URL 作为来源身份，但节点不再依赖宿主机 SSH agent、known_hosts 或代码托管平台在线状态。跨机器 Worker 仍可直接使用计划中的通用 Git URL。

Git bundle 在所有平台都通过临时 bare Git 仓库执行 `git bundle verify`，因此校验不依赖 Worker 当前目录是否已经位于某个仓库。Runtime 平台 smoke 只访问 `http://127.0.0.1:<port>`，打印 readiness 后还会在进程存活边界内等待端口真正接受请求；该实现使用 Node 原生 HTTP 客户端，避免 Rosetta 下 Undici 的套接字服务类型兼容问题。启动后退出时仅输出经过凭据关键词过滤和长度限制的诊断尾部，既保留真实错误栈，也不泄漏浏览器 token 或 API 凭据。两项检查都不能通过跳过 bundle 校验、改用外网地址或固定长时间休眠来规避。

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

多节点也复用准备结果。先执行 `release:prepare`，再将其输出的 descriptor 文件传给 `release:create --prepared-descriptor <文件>`；Worker 同时通过私有共享存储或受控同步目录获得 `--prepared-root <目录>`。Controller 会把 descriptor 固定进任务，任何 commit、Runtime、配置或 receipt 哈希不一致都会拒绝领取或上传。未提供有效准备凭据时 Worker 走完整 `desktop:package` 门禁，不存在可随意设置的“跳过测试”开关。

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
5. 调用现有 `package:community` 或 `desktop:package`；有效准备凭据只复用已通过的公共门禁，当前目标仍必须完成 Runtime 原生闭包、平台 smoke、Tauri 打包和安装包审计。
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
