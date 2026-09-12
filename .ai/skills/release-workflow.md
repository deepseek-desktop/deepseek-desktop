# DeepSeek Desktop 发布工作流

本文件是 AI Agent 和发布维护者的唯一发布运行手册。用户文档见 `docs/zh-CN/distributed-release.md`，工具链事实见 `harness/toolchain-lock.json`。

## 决策

- 正式四平台发布只使用 `.github/workflows/community-build.yml` 的 GitHub 官方托管 Runner 原生矩阵。
- Pull Request 和普通分支 push 不触发发布工作流。
- 只有带或不带 `v` 的完整 SemVer Tag 才运行质量门禁、构建安装包和创建 Release。
- Tag 必须是 annotated Tag，并指向实际构建 commit；质量门禁记录 Tag 对象，原生构建及发布前与远端 Tag / peeled commit 再次比对，任何漂移立即失败。不得重建、移动或覆盖旧 Tag。
- 四个平台都调用现有 `package:community`，禁止复制第二套打包逻辑。
- 本机只验证源码、E2E、Harness smoke 和当前 macOS 架构安装包。
- 不把 Parallels、Rosetta、Docker、本地 Controller/Worker 或自托管 Runner 当作正式发布前提。
- 未收到用户明确“发布”命令时，只修复、验证和本地提交，不创建或推送 Tag。

## 工具链

具体发行必须精确使用仓库 lock：

- Node `24.20.0`，module ABI `137`
- pnpm `11.24.0`
- npm `11.19.0`（来自同一份固定 Node 官方归档）
- Rust `1.98.0`
- Tauri CLI `2.11.4`

“最新 LTS”只在维护者显式升级 lock 时解析。一次发行不得动态漂移到未来版本。

## 本地收口

先读取 `AGENTS.md`、`.ai/context.md`、`.ai/todo.md`、`.ai/conventions.md` 和本手册；存在 `.ai/plan.md` 时再读取，不因可选文件不存在创建重复计划。再检查：

```bash
git status --short --branch
git log --oneline --decorate -8
git fetch --tags origin
```

保护现有 WIP，不移动失败或已发布 Tag。完成代码修复后执行：

```bash
corepack pnpm@11.24.0 app:sync --check
corepack pnpm@11.24.0 harness:sync --check
corepack pnpm@11.24.0 verify
corepack pnpm@11.24.0 test:e2e
corepack pnpm@11.24.0 harness:smoke
corepack pnpm@11.24.0 desktop:package
```

尚未获准创建发行 Tag 时使用 `desktop:package` 生成本机验收包，它会记录源码 dirty 状态但不会伪装成社区发行。获准发布后，GitHub Tag 矩阵统一调用门禁更严格的 `package:community`。前面的独立命令用于缩短定位反馈，只报告实际运行过的结果。

macOS 本机至少检查：

1. DMG 已生成，SHA-256 可读取。
2. 包内应用能启动，标题包含真实版本。
3. Harness sidecar 启动且工作台在同一窗口加载。
4. 应用退出后没有遗留 Harness 进程。

用户已取消“每次发布都必须挂载 DMG 并启动 5 秒”的固定门禁，不要自行恢复；遇到安装包相关改动时仍应按风险做对应验证。

## 最短反馈路径

1. 先找到失败 Job 的第一处实际错误，记录 commit、命令、输入环境和阶段；区分产品、装配、测试夹具和 Runner 问题，不把所有失败归因于平台或网络。
2. 新增发布输入时同时核对生产者、Job 传递、配置加载器及消费者。用真实变量名和值形态执行最小入口；本机 `desktop:package` 没有 CI 环境变量，不能证明 `package:community` 的发行身份契约可用。
3. 在可控环境复现修改前失败、修改后通过。优先检查容器 HOME / Git 所有权、LF / CRLF、构建产物而非仓库文件、全新 profile 与已有 profile 的差异；不得清空用户真实数据模拟首次运行。
4. 超时前后必须有可解释状态：受管进程树、窗口标题、相关 UIA 控件和有界脱敏日志。只有能证明准备仍在推进才调整时间预算；不能仅加等待或反复发 Tag 猜原因。
5. 修复后先跑失败阶段及相邻契约，再按改动范围执行仓库规定的验证。仅修改打包后验收脚本时，不应为同一源码反复重建无关的本机 DMG；不得因此省略适用的发行回归、最终原生矩阵或安装验收。
6. 修复与相关证据闭环后及时按 pathspec 提交，避免把可交付修复长期留作 WIP。跨 Agent 接手先读最新 diff 和 CI，复用已经通过的相同源码证据，不重复旧调查或夹带改动。
7. 发布监视器超时不等于 Job 失败。重新查询原 Run 并继续跟踪；只有真实失败才修复、验证并选新 Tag。交付结束点是 Release 及下载包验收，不是推送成功或本机测试总数。

这些规则来自 `v1.1.8` 发布复盘。Codex 的主要失误是引入发布变量却未验证配置入口、新增测试依赖本机行为、用已有用户状态设计首次安装验收，以及重复本机全量验证却延迟了发布关键路径。Claude Code 接手后的有效做法是沿用唯一工作流，补齐诊断，逐个复现并修复阻塞，再跟进矩阵与发布后安装；它并非一次成功，也曾引入首次弹窗提前返回回归。责任和原因应依据 diff / 失败日志记录，不以 Agent 的成功总结替代证据。

## Tag 与矩阵

接受示例：`1.0.0`、`v1.0.0`、`v1.0.0-rc.1`。非法或不完整版本必须在 `ci-release-version.mjs` 失败。

矩阵固定为：

| 目标 | Runner | 公开产物 |
| --- | --- | --- |
| macOS ARM64 | `macos-15` | DMG |
| macOS x64 | `macos-15-intel` | DMG |
| Windows x64 | `windows-2022` | EXE |
| Linux x64 | `ubuntu-22.04` | AppImage、DEB |

四个 Job 全部成功后才能运行 `publish-release`。prerelease 标记由 `scripts/ci-release-prerelease.mjs` 决定：**制品未签名一律标记 prerelease**，已签名版本再按 SemVer prerelease 段判断。GitHub 的 Latest release 是用户默认下载和 `/releases/latest` 的返回值，未签名制品不应占据该位置；签名接入后同一规则自动把正式版本提升为 Latest。

## 公开资产

Release 标题直接使用 Tag 本身，与 Tags 页面一致；不要再拼接产品名，否则 Release 列表侧栏只会显示被截断的同一串产品名，反而看不出版本。

Release 只保留 5 个安装包和 `SHA256SUMS`。矩阵内部可上传 `BUILD-INFO` 供汇总核验，但不得公开。GitHub 的 `Assets` 展开状态由站点界面控制，仓库不能强制默认展开；`prepare-ci-release-notes.mjs` 必须根据当前 Tag 和完整公开资产集合在正文顶部生成 5 个安装包及 `SHA256SUMS` 的直接下载链接，让用户无需展开 `Assets` 也能下载。

汇总门禁必须检查：

- 安装包总数恰好为 5。
- 两份 DMG 分别为 ARM64 和 x64。
- EXE、AppImage、DEB 各一份。
- 文件名无冲突。
- `SHA256SUMS` 覆盖全部 5 个安装包。
- Release 正文中的直接下载链接与当前 Tag、版本和上述 6 个公开文件逐项一致。
- Tag、应用版本和 commit 一致。

## 发布步骤

只有用户明确授权发布后才执行：

1. 查询远程最新 Tag/Release，选择下一个未占用完整 SemVer。
2. 确认 `master`、工作区、验证、提交范围和远端状态。
3. 创建新的 annotated Tag；已有 `v` 时保持，没有时按约定补 `v`。
4. 推送 `master` 和新 Tag，不 force push、不移动旧 Tag。社区预发布显式使用 `--prerelease --latest=false`，不依赖 GitHub 默认 Latest 推断。
5. 等待质量检查、四平台矩阵和汇总发布全部完成。
6. 重新读取 Release，核对 5 个安装包、`SHA256SUMS`、名称、大小、摘要、正文直接下载链接和 Tag/commit。

核验摘要时区分 GitHub 返回的 digest、下载的 `SHA256SUMS` 与实际下载文件计算的 SHA-256；只查询元数据不能写成“全部下载校验通过”。下载后的最终本机包与先前本地构建包也必须分开记录。当前成功实例与证据边界见 [验证基线](../memory/verification.md#当前发布验收)。

任何平台失败都不发布不完整版本。修复后使用下一个未占用 Tag；不能反复移动失败 Tag。

## 常见故障

| 现象 | 处理 |
| --- | --- |
| 容器身份检查报 Git dubious ownership | Checkout 的临时 HOME 安全目录不会自动覆盖后续容器步骤；只在临时 CI Job 中登记实际 `GITHUB_WORKSPACE`，不得使用通配信任、修改本机全局 Git 或跳过 annotated Tag 校验 |
| Git 回归本机通过，Linux 的本地 upload-pack 却报所有权错误 | `GIT_TEST_ASSUME_DIFFERENT_OWNER` 会被本地子进程继承，真实 GitHub 服务端不会继承它；先在模拟环境验证本地身份，再移除测试专用变量验证本地远端。保留未授权目录拒绝断言，不能修改生产校验迎合夹具。修复见 `b7e1731`，夹具为 `scripts/tests/release-identity.test.mjs` |
| 四平台均报未知配置 `RELEASE_TAG_OBJECT` | 该变量是发行身份输入而非构建选项；配置加载器按名字识别，仍拒绝 `RELEASE_CHANEL` 等拼写错误。修复见 `f2e2431`；新增环境变量必须跑配置入口回归 |
| Windows 单条 Provider 表单测试无法提取函数体 | 生成的 JavaScript 可为 CRLF，不受仓库 `.gitattributes` 控制；读入测试产物后归一化行尾，保留实际装配函数行为断言。修复见 `835afdc`；不能删除失败测试或改产品以迎合正则 |
| NSIS 架构或安装后 EXE 检查失败 | NSIS 安装器外壳可以是 x86，实际 `deepseek-desktop.exe` 必须为 x64；规范化注册表安装路径，不按产品显示名称猜可执行文件名 |
| Windows 首次安装后超时，已有用户机器却正常 | 先检查两层引导：“内测声明”后还有 API Key 引导；在隔离测试账户依次处理“继续”“稍后配置”，禁止点击“保存并继续”。`ccc6377` 加入诊断后定位，`60c6693` / `5039dde` 补齐流程，`d56e3d9` 修正检查顺序；安装验收入口为 `scripts/verify-windows-install.ps1` |
| 日志显示关闭 0 个弹窗、短暂就绪，随后又找不到工作台 | 瞬时工作台外壳不是可交互就绪。每轮先检查已知引导按钮，再判断工作台；继续执行实际菜单和设置交互，不能以进程存活或一帧非白像素代替验收 |
| WebView2 菜单找到但 Invoke 失败 | `aria-haspopup` 菜单使用公开 UIA ExpandCollapse，必要时后备 Invoke；根据控件实际模式操作，不因自动化失败修改产品菜单位置 |
| 原生模块携带 node-gyp 构建路径 | 区分必要 `.node` 与开发中间产物；清理器和扫描器一致处理路径拼写及 UTF-8 / UTF-16LE，保持二进制偏移并复验实际加载，不扩大扫描白名单掩盖泄漏 |
| 工作台白屏或 Failed to load plugins | 区分 bundle rev 失效的 404、旧会话 Cookie 累积的 431、脚本异常与服务未启动；检查实际响应及 Harness 启动代次，不靠清空用户数据或进程存活判定修复。现有生产链清理旧认证 Cookie 并按代次重新导航 |
| Chromium 正常但 macOS 历史回放失败 | 检查 WebKit 实际异常及相同会话内容；不能依赖 V8 的内置函数字符串排版。现有修复及双引擎对照见 [ADR-020](../decisions/adr-020-webkit-json-intrinsics.md)，不要用 Chromium 通过替代 WebKit |
| 普通提交出现发布构建记录 | 工作流只能监听完整 SemVer Tag；禁止添加 PR、分支 push 或手动触发入口 |
| 已签名版本仍被标为 prerelease | 检查生成配置的 `release.signed` 是否为布尔 `true`；`ci-release-prerelease.mjs` 对缺失或非布尔的签名声明一律按未签名处理 |
| Release 多出 BUILD-INFO | 只从五类安装包生成公开目录，发布前检查文件总数为 6 |
| Windows 路径过长 | 保持 Windows Job 在短路径 detached clone 中打包 |
| Windows 重试报 Harness 文件只读 | 恢复内容缓存后只把工作副本递归设为可写，缓存本体仍做哈希核验 |
| Linux AppImage strip 失败 | `prepareLinuxAppImageLdd` 只向单次 Linux Tauri 子进程设置 `NO_STRIP=1`，同时覆盖托管 CI 和本地 Linux worker；不得设为跨平台或全局构建环境 |
| Linux AppImage 在检查 musl `system.node` 时报 `failed to run linuxdeploy` | 官方平台包同时携带 glibc 和 musl 原生模块，Ubuntu 的 glibc `ldd` 不能可靠检查 musl 二进制。准备阶段用选定的绝对 `patchelf` 对已验证暂存源副本写入 `$ORIGIN`，以 `readelf --dynamic --wide` 要求原始模块只有 `DT_NEEDED=libc.so` 且无动态路径，修改后只有相同依赖、唯一 `DT_RUNPATH=$ORIGIN` 且无 `DT_RPATH`，并固定两份 SHA-256。只向 Linux Tauri 子进程设置 `NO_STRIP=1`，再把同一 `PATCHELF` 和临时 `ldd` wrapper 传给 linuxdeploy；wrapper 只允许 AppDir 精确路径按“原始 SHA → 预计算 SHA”单调转换，其他调用原样委托系统 `ldd`。顺序、字节或结构漂移必须失败并打印诊断，Tauri 成功后还须复核最终 SHA 与阶段，结束后清理 wrapper。复验 AppImage、DEB 与交付扫描均保留官方 musl 载荷且不携带宿主 `libc.so`。 |
| Windows 精确补丁后只出现 CRLF 差异 | `git apply` 会继承 Runner 的 `core.autocrlf`。在单次补丁命令上固定 `core.autocrlf=input`，用实际字节回归 LF / CRLF 输入；不修改用户或 Runner 的全局 Git 配置。 |
| 汇总报 `release identity mismatch` | 报错已带字段名。`harness.sha256` 因平台而异属正常（native prebuild 由各主机编译），不参与跨平台比对；其余字段不一致说明四个目标并非同一次发布，必须查明来源而不是放宽比对 |
| `harness:sync` 报 `hardlink different from source` | 本地 clone 默认硬链接 `.git/objects`，与镜像自身的 commit-graph 维护竞争。`harness-sync.mjs` 的缓存检出必须带 `--no-hardlinks`；该失败与平台无关，不要当作单个 Runner 的抖动重试了事 |
| Linux 原生平台包 prepack 报缺少 `landlock-run` 或安装后无法执行 | `build:official` 只生成当前 libc 的 host addon；在打包当前平台包前执行原生 workspace 的完整 `build:native`，Linux Runner 安装 `musl-tools`。平台包沿用官方 `npm pack` 保留执行位，其余 workspace 包使用 pnpm；安装后复核声明载荷与权限，不能跳过 prepack 或删除 optional 平台包。 |
| 上传失败 | 不修改已有 Tag；确认权限和资产后用新版本重新闭环 |

## 防止错误经验固化

- 成功提交中的解释也要核实。`d56e3d9` 的提交说明误称 PowerShell `continue` 在 `do/while` 中必然退出循环；[官方语义](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_continue)是终止当前迭代并继续循环，[do/while](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_do)仍按条件决定是否继续。已证实的失败是弹窗前的工作台瞬时帧触发提前返回，不应把错误语言规则复制到后续代码。
- macOS AX 旧引用、断言类型错误、系统对话框属于独立进程，都可能使测试失败而产品正常；重新定位、刷新引用、核验实际行为。原生崩溃必须保留因果证据，不附加调试器暂停用户正在使用的实例；见 [生命周期验收](../memory/macos-lifecycle.md)。
- 测试总数、构建成功、ARM64 上的 Windows x64 仿真、工作台像素非白，各自只能证明对应层。Windows 原生安装成功也不等于真实供应商搜索、所有菜单、高 DPI 和升级回滚全部验收。
- 接手时更新当前状态，移除已解决的发布阻塞；历史失败由 Git / Actions 追溯。不能让 `.ai` 仍指向旧候选，也不能照抄聊天中的旧“SIGABRT 未闭环”覆盖后来的因果修复证据。

## 报告模板

最终报告只写可验证事实：

- 修复范围和本地 commit。
- 本机实际执行的测试与 macOS 安装包路径、摘要。
- GitHub 四个平台的真实状态；未运行时明确写未运行。
- 若已发布，给出不可变 Tag、Release 链接和六个公开资产。
- 签名、公证和目标系统人工验收边界。
