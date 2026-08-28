# Runtime 独立更新指南

DeepSeek Desktop 把桌面外壳与 Harness Runtime 分开发布。模型适配、插件集成或 Runtime 修复可以只发布 Runtime；只有 Tauri、原生菜单、凭据协议或桌面管理器发生变化时，才需要重新发布完整桌面安装包。

## 普通用户

发行版未配置可信更新服务时，Runtime 更新页显示“未配置”，应用不会连接任何更新地址。启用后可选择：

- **自动下载，下次启动安装**：后台发现新版本后下载并校验，退出应用前不替换正在运行的 Runtime。
- **发现后提醒（默认）**：只提示版本，由用户决定是否下载。
- **仅手动检查**：只有点击“检查 Runtime”时访问更新服务。
- **固定当前 Runtime**：停止检查、下载和待安装切换，直到取消固定。
- **恢复内置 Runtime**：停止当前 Runtime，并把下次启动恢复到安装包内置版本。

更新失败不会覆盖当前可用版本。应用先下载到 staging，校验签名、有效期、发布历史、发布者、仓库、平台、协议、兼容版本、大小和 SHA-256，再解压到版本化目录。下次启动先检查 Node 和 Runtime CLI，再在隔离临时目录真实启动本地 Runtime，完成 readiness 与认证 HTTP 探活后才原子切换 `current` 指针。Desktop 不调用 Runtime 私有工作区接口，项目目录仍由工作台自行管理。新版本启动失败或连续恢复失败时，会自动回滚上一版；上一版也不可用时使用安装包内置 Runtime。更新器只保留 `current`、`previous` 和 `pending` 指针引用的版本，启动和失败清理都会移除遗留 staging 与孤立版本目录。

离线环境可以长期使用当前或内置 Runtime。断网、服务器错误、下载中断、哈希不符或签名错误只会记录脱敏状态，不会影响当前 Runtime。诊断包包含当前版本、commit、来源和更新阶段，但不包含清单地址、令牌、公钥私钥或模型密钥。

## 构建配置

```dotenv
RUNTIME_UPDATE_MANIFEST_URL=https://updates.example.com/runtime/stable/manifest.json
RUNTIME_UPDATE_CHANNEL=stable
RUNTIME_AUTO_UPDATE=false
RUNTIME_UPDATE_PUBLISHER=deepseek-desktop
RUNTIME_UPDATE_PUBLIC_KEY=<Ed25519 原始 32 字节公钥的 Base64>
```

配置优先级仍为“环境变量 > `.env` > 内置默认值”。清单地址和公钥必须同时存在，否则构建直接失败；两者都留空则禁用更新。`RUNTIME_REF` 非空表示开发者明确固定构建期 Runtime，此时默认关闭自动下载，避免联调版本被服务端替换。用户仍可在设置页切换提醒或手动模式。

生产发行建议使用 HTTPS。`file://` 适合内网 NAS 和离线验收；HTTP 制品仍会经过签名与 SHA-256 验证，但传输元数据不受 TLS 保护。客户端不跟随 HTTP 重定向，跨 Origin 下载必须由已签名清单明确列入 `allowedOrigins`，清单 URL 不得包含凭据、query 或 fragment。

## 维护者发布流程

签名私钥不得提交 Git、写入 `.env`、复制到构建产物或放在公开 Worker。先在安全位置生成一次 Ed25519 密钥；下面命令的默认私钥路径位于被忽略的 `target/`，仅适合本地验证：

```bash
corepack pnpm@11.7.0 runtime:update:keygen
```

把命令输出的 `RUNTIME_UPDATE_PUBLIC_KEY` 固化到下一次桌面发行配置中。正式私钥应由发布维护者保存在权限受限的外部路径、密码管理系统或签名服务中。

四类受信任原生节点在同一个干净 Desktop commit 上分别执行：

```bash
corepack pnpm@11.7.0 runtime:update:package -- \
  --output /shared/releases/runtime/1.0.0
```

Worker 自动识别 macOS arm64、macOS x64、Windows x64 或 Linux x64，只生成本机原生目标。该命令复用 `app:sync`、`runtime:sync` 和 `runtime:stage`，输出生产 Runtime、Node sidecar、`runtime-package.json`、目标描述和 SHA-256；用户机器不执行这些构建步骤。共享目录可位于本地 filesystem 或 NAS。

四个平台描述和制品齐全后，发布维护者签名统一清单：

```bash
corepack pnpm@11.7.0 runtime:update:manifest -- \
  --directory /shared/releases/runtime/1.0.0 \
  --signing-key /secure/runtime-update-signing-key.pem \
  --minimum-desktop 1.0.0 \
  --maximum-desktop 2.0.0 \
  --channel stable \
  --valid-for-hours 168 \
  --base-url https://updates.example.com/runtime/stable/
```

默认要求四个平台目标齐全、Desktop 与 Runtime 源码干净、四个描述的 Desktop commit、Runtime commit、仓库、协议、Node ABI、凭据插件和 DSH Market 版本完全一致，并重新读取每个制品核对大小与 SHA-256。需要在单一平台做内部测试时可显式传入 `--targets <target>`；这不应冒充完整公开发布。

清单和制品可以发布到静态文件服务器、filesystem/NAS、GitHub、GitLab、Gitee、Gitea 或自建服务。构建、签名和上传彼此解耦，不使用 GitHub Release API 作为运行前提。外部平台只承载已生成文件，不参与客户端信任判断。

## 清单协议

外层 `schemaVersion: 1` 包含 Base64 编码的 `signedPayload` 和 Ed25519 `signature`。签名 payload 至少包含：

```json
{
  "schemaVersion": 1,
  "publisher": "deepseek-desktop",
  "issuedAt": "2026-01-01T00:00:00.000Z",
  "expiresAt": "2026-01-08T00:00:00.000Z",
  "runtimeVersion": "1.0.0",
  "channel": "stable",
  "desktopProtocolVersion": 1,
  "runtimeProtocolVersion": 1,
  "credentialProtocolVersion": 1,
  "minimumDesktopVersion": "1.0.0",
  "maximumDesktopVersion": "2.0.0",
  "desktopCommit": "<40 位 commit>",
  "runtimeCommit": "<40 位 commit>",
  "runtimeRepository": "https://example.com/runtime.git",
  "credentialProviderVersion": "1.0.0",
  "marketVersion": "1.0.0",
  "nodeVersion": "24.16.0",
  "nodeModuleAbi": "137",
  "allowedOrigins": [],
  "artifacts": {
    "aarch64-apple-darwin": {
      "url": "deepseek-runtime_1.0.0_aarch64-apple-darwin.tar.gz",
      "size": 123,
      "sha256": "<64 位 SHA-256>"
    }
  }
}
```

客户端只接受当前平台制品、受信任发布者和配置公钥。清单必须在签名覆盖的 `issuedAt` 与 `expiresAt` 有效期内，签发时间最多允许 15 分钟时钟偏差；客户端按频道持久化已接受的最高版本、签发时间和 commit，拒绝旧版本、旧签发时间以及同版本替换 commit 的重放。`stable` 拒绝预发布 SemVer，但允许带构建元数据的稳定版本；候选版本必须高于当前版本，并落在 Desktop 兼容范围内。Runtime、Desktop 和凭据协议必须精确匹配，Runtime 仓库必须与安装包内置来源一致。压缩包拒绝绝对路径、父目录逃逸、重复路径、符号链接、特殊文件、超量文件和超限解压大小。

## 故障恢复

- **下载或验签失败**：保留当前 Runtime，删除不完整 `.part` 文件后重试。
- **启动 smoke 失败**：删除待安装指针和孤立版本目录，继续使用当前 Runtime。
- **切换后启动失败**：原子切回上一版并重新启动。
- **上一版不可用**：删除外部 current 指针，恢复安装包内置 Runtime。
- **固定版本**：取消固定前不应用已下载版本；取消后重新检查可获得最新可信版本。
- **完全离线恢复**：在更新页点击“恢复内置 Runtime”，不需要访问网络或重新安装桌面应用。

Runtime 数据只写入系统应用数据目录的 `updates/runtime/`，不会修改 macOS `.app`、Windows 安装目录或 Linux 应用映像。Windows 下载 smoke、替换和 Runtime 启动均使用无控制台进程标志，不会额外弹出终端窗口。
