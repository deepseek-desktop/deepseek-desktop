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
- Rust `1.98.0`
- Tauri CLI `2.11.4`

“最新 LTS”只在维护者显式升级 lock 时解析。一次发行不得动态漂移到未来版本。

## 本地收口

先读取 `AGENTS.md`、`.ai/context.md`、`.ai/todo.md`、`.ai/plan.md`、`.ai/conventions.md`，再检查：

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

任何平台失败都不发布不完整版本。修复后使用下一个未占用 Tag；不能反复移动失败 Tag。

## 常见故障

| 现象 | 处理 |
| --- | --- |
| 普通提交出现发布构建记录 | 工作流只能监听完整 SemVer Tag；禁止添加 PR、分支 push 或手动触发入口 |
| 已签名版本仍被标为 prerelease | 检查生成配置的 `release.signed` 是否为布尔 `true`；`ci-release-prerelease.mjs` 对缺失或非布尔的签名声明一律按未签名处理 |
| Release 多出 BUILD-INFO | 只从五类安装包生成公开目录，发布前检查文件总数为 6 |
| Windows 路径过长 | 保持 Windows Job 在短路径 detached clone 中打包 |
| Windows 重试报 Harness 文件只读 | 恢复内容缓存后只把工作副本递归设为可写，缓存本体仍做哈希核验 |
| Linux AppImage strip 失败 | `NO_STRIP=1` 只能设置在 GitHub Linux 原生打包步骤，不传播到其他平台 |
| 汇总报 `release identity mismatch` | 报错已带字段名。`harness.sha256` 因平台而异属正常（native prebuild 由各主机编译），不参与跨平台比对；其余字段不一致说明四个目标并非同一次发布，必须查明来源而不是放宽比对 |
| `harness:sync` 报 `hardlink different from source` | 本地 clone 默认硬链接 `.git/objects`，与镜像自身的 commit-graph 维护竞争。`harness-sync.mjs` 的缓存检出必须带 `--no-hardlinks`；该失败与平台无关，不要当作单个 Runner 的抖动重试了事 |
| 上传失败 | 不修改已有 Tag；确认权限和资产后用新版本重新闭环 |

## 报告模板

最终报告只写可验证事实：

- 修复范围和本地 commit。
- 本机实际执行的测试与 macOS 安装包路径、摘要。
- GitHub 四个平台的真实状态；未运行时明确写未运行。
- 若已发布，给出不可变 Tag、Release 链接和六个公开资产。
- 签名、公证和目标系统人工验收边界。
