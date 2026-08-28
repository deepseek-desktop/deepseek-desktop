# DeepSeek Desktop 发布工作流

本文件是 AI Agent 处理 DeepSeek Desktop 构建与发布任务的统一运行手册。它记录稳定流程、判断顺序和安全边界，不记录某次发行日志。源码、Git 状态、`runtime/toolchain-lock.json`、`scripts/release-system/targets.json` 和实际命令结果始终高于本文件。

面向维护者的详细参数与部署说明见 `docs/zh-CN/distributed-release.md`；最近一次可信验证见 `.ai/memory/verification.md`。

## 不可改变的事实

1. 只有一套打包事实来源：`app:sync -> runtime:sync -> verify -> test:e2e -> runtime:smoke -> desktop:package`。Worker 和单机四环境编排必须复用它，不能另写简化打包脚本。
2. 四个发行目标只由 `scripts/release-system/targets.json` 定义：`macos-arm64`、`macos-x64`、`windows-x64`、`linux-x64`。
3. Controller 负责锁定 tag、Desktop commit、Runtime commit、目标和节点；Worker 只构建本机能够可靠报告的目标；Provider 只上传已经校验的制品。
4. GitHub、GitLab、Gitee、Gitea 或本地 Git 只是可替换源码来源。filesystem/NAS 是默认发布 Provider，GitHub 是可选适配器，构建不能依赖托管 Runner。
5. 默认和示例版本号使用 `1.0.0`；发行 tag 接受 `1.0.0`、`v1.0.0`、`v0.1.0-community.13` 等完整 SemVer。显示层已有 `v` 时保留，没有时补齐，Git tag 本身不得由显示规则改写。
6. `RUNTIME_REF` 为空时开发构建可解析最新 SemVer；发行必须使用 `runtime/toolchain-lock.json` 中已审计的不可变 Runtime commit。
7. 未经用户明确授权，Agent 不创建或推送 tag，不创建正式 Release，不推送受保护分支。

## 先选择正确路径

| 场景 | 使用方式 | 结论边界 |
| --- | --- | --- |
| 开发者只构建当前系统 | `desktop:package` | 只证明当前原生目标可构建 |
| Apple Silicon Mac 快速生成四目标 | `release:local-all` | 一台物理机中的原生、Rosetta、Docker 和 Parallels 四环境 |
| 正式高可信多平台发行 | 持久 Controller + 多台受信任原生 Worker | 每个目标由对应原生节点完成，推荐用于 stable |
| 只验证发布协议 | `release:smoke` | 不生成真实安装包 |
| 只模拟 Linux 公共 CI | `preflight:docker` | 不替代 macOS、Windows 或真机安装验收 |

优先使用 `release:local-all` 做日常社区版四目标打包和耗时定位；需要签名、公证、真实 Intel Mac、真实 Windows x64 或严格 Linux 基线时，切换到多原生节点模式。不能为了凑齐目标，把错误平台生成的文件改名成目标安装包。

## Agent 启动检查

进入独立仓库后先读取：

```bash
git status --short --branch
```

然后读取 `AGENTS.md`、`.ai/README.md`、`.ai/context.md`、`.ai/todo.md`、本文件、`.ai/memory/verification.md` 和 `runtime/toolchain-lock.json`。确认当前操作的是 DeepSeek Desktop 独立 Git 仓库，不从 SpringOpen 父仓库暂存或提交。

继续前必须确认：

- 没有其他 Agent 的未提交改动。
- `master`、tag 和远程来源符合本次任务要求。
- Runtime lock 指向预期仓库、ref 和完整 commit。
- 本次任务是否只有构建、是否允许 tag、是否允许发布已经由用户明确说明。

## 最短反馈路径

开发阶段不要每改一处就执行四平台完整打包。按下面顺序尽早发现便宜错误：

1. 运行受影响脚本的 `node --check` 和对应 `node --test`。
2. 发布协议变化运行 `corepack pnpm@11.7.0 release:smoke`。
3. 配置变化运行 `app:sync --check`；Runtime 来源或闭包变化运行 `runtime:sync --check`。
4. 功能簇收口时只运行一轮完整 `verify`、`test:e2e` 和 `runtime:smoke`。
5. 创建 tag 前运行四环境工具链与网络预检。

```bash
corepack pnpm@11.7.0 release:local-all -- --check
```

该预检不会创建发行任务，也不会生成安装包。它会检查 Rosetta x64 Node、Docker Linux x64、Parallels Windows x64 的 Node/Git/Corepack/MSVC，以及四个环境到临时 TLS Controller 的连接。任一环境失败时先修环境，不要创建 tag 后再反复等待完整构建失败。

## GitHub 托管社区版发布

这是当前已经跑通的远程兜底与公开发布路径。它不替代本地 Controller / Worker 架构，但适合在没有四台长期在线原生节点时完成一次公开社区版发行。唯一工作流是 `.github/workflows/community-build.yml`：普通 `master` 推送只运行公共质量门禁，符合完整 SemVer 的 tag 才会在门禁通过后并行构建四个平台并创建预发行 Release。

### 1. 创建 tag 前

先在本地完成便宜验证，再进入远程长任务：

```bash
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 test:e2e
corepack pnpm@11.7.0 runtime:smoke
corepack pnpm@11.7.0 release:local-all -- --check
git diff --check
git status --short --branch
```

发布协议、路径或制品扫描变化时，必须在对应原生系统补跑相关 Node 测试。尤其是 Windows 路径断言，应通过 `node:path` 的 `resolve()` 生成平台期望值，不能把 Unix 风格字面量直接作为跨平台期望。

发布前刷新远程事实，确认工作区干净、`master` 已同步、候选 tag 未被占用：

```bash
git fetch origin --tags
git rev-list --left-right --count master...origin/master
git status --porcelain
git ls-remote --tags origin refs/tags/v1.0.0
```

`git rev-list` 预期为 `0 0`，`git status --porcelain` 和 `git ls-remote` 预期为空。若 tag 已存在，不移动、不删除、不强推；修复后选择下一个未使用的 SemVer。

### 2. 推送发行

仅在用户已经明确授权发布时，创建指向当前已验证 commit 的 annotated tag：

```bash
tag="v1.0.0"
git tag -a "$tag" -m 'DeepSeek Desktop 1.0.0'
git push origin master "$tag"
```

带 `v` 和不带 `v` 的完整 SemVer 都受支持；显示层补 `v` 的规则不改变实际 tag。推送 `master` 和 tag 会产生两个不同 ref 的工作流：tag run 是正式候选，`master` run 只有公共门禁。确认 tag run 已创建后，可以取消同一 commit 的 `master` 重复 run，不能取消 tag run：

```bash
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
sha="$(git rev-parse HEAD)"
tag_run_id=""
for ((attempt = 1; attempt <= 30; attempt++)); do
  tag_run_id="$(gh run list --repo "$repo" --commit "$sha" --branch "$tag" \
    --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [ -n "$tag_run_id" ] && break
  sleep 2
done
master_run_id="$(gh run list --repo "$repo" --commit "$sha" --branch master \
  --limit 10 --json databaseId,status --jq \
  'map(select(.status != "completed")) | first | .databaseId // empty')"
if [ -n "$master_run_id" ]; then
  gh run cancel "$master_run_id" --repo "$repo"
fi
test -n "$tag_run_id"
```

### 3. 跟踪与失败恢复

按 `shell-quality -> native-build 四平台 -> publish-release` 的顺序观察，不要只看工作流总状态：

```bash
gh run view "$tag_run_id" --repo "$repo" --json status,conclusion,jobs
```

失败时先下载失败 job 的完整日志，再按第一次有效错误定位：

```bash
failed_job_id="$(gh run view "$tag_run_id" --repo "$repo" --json jobs --jq \
  '.jobs[] | select(.conclusion == "failure") | .databaseId' | head -n 1)"
test -n "$failed_job_id"
job_log="$(mktemp)"
gh api "repos/$repo/actions/jobs/$failed_job_id/logs" > "$job_log"
rg -in -C 4 'error|failed|AssertionError|forbidden' "$job_log"
```

已经成功的平台不证明失败平台也可用，但可以帮助缩小范围。修复后完成本地与对应原生系统验证，创建新 commit，并使用下一个未使用的 SemVer tag。绝不把失败 tag 移到新 commit，也不在失败 run 上手工拼接不同源码生成的资产。`publish-release` 依赖四个平台全部成功；矩阵不完整时应保持无 Release。

`v1.0.3` 的一次成功观测基线是：公共门禁约 9 分钟，macOS ARM64 约 13 分钟，Linux x64 约 16 分钟，Windows x64 约 28 分钟，macOS x64 约 38 分钟，Release 汇总约 30 秒；矩阵并行后的总时长约 49 分钟。该数据只用于判断明显卡住或评估本地提速，不能作为固定 SLA。

### 4. 发布验收

`publish-release` 成功后必须再次读取 Release，而不是只依赖绿色工作流：

```bash
gh release view "$tag" --repo "$repo" \
  --json name,tagName,url,isDraft,isPrerelease,publishedAt,assets
```

社区版预期为非草稿预发行版，并且只公开以下六项：

- macOS Apple 芯片 DMG。
- macOS Intel DMG。
- Windows x64 NSIS EXE。
- Linux x64 AppImage。
- Linux x64 DEB。
- 汇总 `SHA256SUMS`。

`BUILD-INFO` 只用于流水线内部校验，不应成为公开附件。下载体积很小的 `SHA256SUMS`，把其中五个安装包名称与 GitHub `assets[].digest` 的 SHA-256 逐项比较：

```bash
audit_dir="$(mktemp -d)"
gh release download "$tag" --repo "$repo" --pattern SHA256SUMS --dir "$audit_dir"
gh release view "$tag" --repo "$repo" --json assets > "$audit_dir/assets.json"
AUDIT_DIR="$audit_dir" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.AUDIT_DIR;
const release = JSON.parse(readFileSync(join(root, "assets.json"), "utf8"));
const lines = readFileSync(join(root, "SHA256SUMS"), "utf8").trim().split(/\r?\n/u);
const sums = new Map(lines.map(line => [line.slice(66).trimStart(), line.slice(0, 64)]));
const installers = release.assets.filter(asset => asset.name !== "SHA256SUMS");
if (installers.length !== 5 || sums.size !== 5) throw new Error("unexpected release asset count");
for (const asset of installers) {
  if (sums.get(asset.name) !== asset.digest?.replace(/^sha256:/u, "")) {
    throw new Error(`digest mismatch: ${asset.name}`);
  }
}
console.log("verified 5 installer digests");
NODE
```

缺项、多项、重名、摘要不一致或 Release 仍为 draft 都不算完成。最后确认 tag 指向发行 commit、`master` 与远程同步、独立仓库工作区干净，并检查 SpringOpen 父仓库没有接管本目录改动。

### 已验证的扫描器边界

- `NO_STRIP=1` 只能出现在 Linux 打包步骤；全局设置会让 macOS 动态库保留构建机路径。
- AppImage 的根内相对符号链接可以发布；绝对链接、根外逃逸和循环必须拒绝。
- CI 只扫描本项目 workspace、Runner workspace 和临时目录等精确根路径；不要把整个通用 Runner home 当作私有路径，否则会误判依赖自身携带的公开上游构建路径。本地构建仍必须扫描真实用户 home。
- PEM 私钥模式只应用于 UTF-8 / UTF-16 文本；二进制库可能包含公开自检向量，但二进制仍须检查 API、AWS、GitHub 令牌和本机路径。
- 扫描器或路径测试有变更时，至少使用一个 Windows 原生 Node 环境执行 `node --test scripts/tests/release-system.test.mjs`，不能只在 macOS 上推断 Windows 结果。

## 单机四环境完整发行

### 前置条件

- 宿主是 Apple Silicon macOS，Rosetta 2 已安装。
- Docker Desktop 正常，Linux 使用 `linux/amd64`。
- Parallels Windows 已安装 Tools、x64 Node、Git、Corepack 和 Visual Studio C++ x64 Build Tools。
- tag 已存在、指向当前干净 HEAD，并已推送到 Worker 可访问的通用 Git URL。
- `release:local-all -- --check` 已通过。

配置不同于默认值时，复制 `.deepseek-release.local.example.json` 为已忽略的 `.deepseek-release.local.json`。只写机器拓扑，不写密码、访问令牌或私钥。

用户已明确授权 tag 和发行后执行：

```bash
corepack pnpm@11.7.0 release:local-all -- --tag v1.0.0
```

需要隔离故障时先只跑一个目标：

```bash
corepack pnpm@11.7.0 release:local-all -- --check --target windows-x64
corepack pnpm@11.7.0 release:local-all -- --tag v1.0.0 --target linux-x64
```

不要常规使用 `--rebuild-docker`，只有 `docker/ci/Dockerfile`、系统依赖或构建镜像契约变化时才重建。不要删除 `target/local-release/toolchains`、Docker pnpm volume 或 Playwright 缓存来“确保干净”；源码由 Worker detached checkout 保证干净，缓存删除只会增加下载时间。

成功后检查：

1. `target/local-release/runs/<run-id>/summary.json` 中每个目标都是 `completed`，并记录真实耗时。
2. `release/local-all/<tag>/` 只含目标安装包和统一 `SHA256SUMS`，没有公开 `BUILD-INFO`、`.env`、票据、令牌或本机绝对路径。
3. 文件名、目标 triple、`BUILD-INFO`、Desktop commit、Runtime commit、大小和 SHA-256 已由 Controller 校验。
4. 至少在目标操作系统完成安装、启动、Runtime、凭据、插件、对话、文件读写和卸载观察后，才能声明该平台已验收。

单机编排适合快速社区发行，但 macOS x64 通过 Rosetta，Linux x64 通过 Docker 模拟，Windows x64 可运行在 Windows ARM 的 x64 模拟层。它证明四个隔离目标完成了真实打包，不等于四种物理硬件验收。

## 多原生节点发行

正式或需要断点恢复的发行使用持久 Controller：

1. 各节点执行 `release:worker -- --identify`，维护者登记受信任 `nodeId`。
2. Controller 使用 TLS 启动，管理员令牌只保存在权限受限文件中。
3. `release:create` 锁定 tag、Desktop commit、Runtime commit、目标和受信任节点。
4. 每个节点使用自己的单目标一次性票据运行 `release:worker`。
5. 使用 `release:status` 查看状态；只对失败目标执行 `release:retry`，不重建已完成目标。
6. 全部目标 `completed` 后才允许 `release:publish`。

filesystem/NAS 发布优先，因为它最容易复核且与托管平台无关。需要 GitHub 时只在 Controller 端启用可选 Provider；不得让 GitHub Actions 重新构建一套不同制品。GitLab、Gitee 和 Gitea 后续也只能作为 Provider 适配，不改变 Worker 构建协议。

完整命令和 TLS 参数不要复制到本文件，统一引用 `docs/zh-CN/distributed-release.md`，避免双写漂移。

## 提速原则

1. **先便宜后昂贵**：脚本测试、协议 smoke、四环境预检通过后才执行完整安装包构建。
2. **保留固定缓存**：复用锁定 Node/Rust 工具链、Docker 镜像、pnpm store 和 Playwright 浏览器；不要用清缓存解决普通源码错误。
3. **只重试失败目标**：需要恢复能力时使用持久 Controller 的 `release:retry`；单机一键模式更适合一次性并行构建。
4. **Runtime 不变就不重复解析最新版本**：发行按 lock 构建；只有显式同步 Runtime 后才更新 lock 和重跑闭包审计。
5. **构建与上传解耦**：先 filesystem 汇总和校验，再上传远程 Provider；远程限速或 API 失败不应迫使重新编译。
6. **用真实数据比较速度**：读取 `summary.json` 的总耗时和各目标耗时，再与对应 GitHub Actions run 比较；没有完整构建数据时不得声称节省了具体分钟数。
7. **避免无价值重复门禁**：开发阶段完整门禁只在功能簇收口运行一次；正式 Worker 内部仍必须执行打包链路自带门禁，不能为了省时绕过。

## 安全门禁

- 社区版与 stable 只接受受信任节点；公开 PR、外部分支和 Webhook 不自动执行本地节点代码。
- 一次性票据只通过受控文件或标准输入传递，不能出现在命令参数、Docker 参数、Parallels 参数、日志或提交中。
- 非回环 Controller 必须使用 TLS；私钥、管理员令牌和节点票据不得进入仓库或发布目录。
- Worker 必须从通用 Git URL 做干净 detached checkout，并在构建前后核对 tag 与完整 commit。
- Controller 必须拒绝脏来源、来源漂移、目标不匹配、哈希或大小不一致、`.env`、API Key、本机绝对路径和不完整目标。
- 不修改 Git hook 或 CI 来跳过验证，不 force push，不删除远程分支，不自动覆盖已存在发行。

## 故障定位顺序

| 现象 | 首先检查 | 正确恢复方式 |
| --- | --- | --- |
| `--check` 失败 | 对应环境、工具链、TLS 网络 | 用 `--target` 隔离；修环境后重跑预检 |
| tag/commit 被拒绝 | 工作区、tag 指向、远程 tag | 保持源码不变，修正 tag/远程事实后重建任务 |
| Runtime lock 不一致 | `runtime/toolchain-lock.json` 与来源 commit | 先完成 Runtime 同步与审计，不手改生成 lock |
| 单一 Worker 构建失败 | 该目标日志和 `summary.json` | 单机模式隔离目标；持久模式 `release:retry` |
| 上传中断或租约过期 | Controller 状态、任务租约 | 对失败目标签发替换票据，旧票据不得复用 |
| 远程 Provider 失败 | filesystem 制品、Provider 凭据和 API | 保留已验证制品，只重试上传，不重新编译 |
| 缺少某平台节点 | release 状态为 `waiting` | 增加正确目标节点，不跨平台伪造制品 |

同类失败连续三次仍不能修复时，停止重复执行，报告完整命令、首次有效错误、已尝试方案、目标环境和 run 目录；不要用清缓存、关闭安全校验或修改目标映射掩盖问题。

## 验收与报告模板

Agent 完成发布相关任务时必须明确区分：源码验证、协议 smoke、工具链预检、真实安装包构建、目标系统安装验收、签名、公证和远程发布。推荐报告：

```text
源码 commit：<完整或短 commit>
发行 tag：<tag 或“未创建”>
Runtime：<version + commit>
执行模式：当前平台 / 单机四环境 / 多原生节点
验证：<实际通过命令>
目标状态：macOS ARM64 / macOS x64 / Windows x64 / Linux x64
总耗时：<来自 summary.json；没有则明确“未测量”>
制品位置：<filesystem/NAS/远程 Release>
签名与公证：<已验证 / 未配置 / 未执行>
真机验收：<逐平台列出，不用源码测试代替>
遗留条件：<只列真实缺口>
```

提交前执行 `git diff --check`、敏感信息与本机路径扫描、staged diff 审查，并只提交当前功能簇。发布任务结束后按实际结果更新 `.ai/memory/verification.md`、`.ai/todo.md` 和 `.ai/progress.md`；不要把一次性 run ID、日志或本机路径写入长期记忆。
