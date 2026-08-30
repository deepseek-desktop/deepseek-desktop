# GitHub Actions 多平台发布

DeepSeek Desktop 的正式发布统一使用 GitHub Actions 官方托管 Runner 原生构建。开发者不需要在一台电脑上安装四套操作系统、虚拟机、Rosetta 或 Docker，也不使用自托管 Runner 执行公开 Pull Request 代码。

## 唯一发布链路

`.github/workflows/community-build.yml` 是多平台发布入口：

1. Pull Request 和普通分支 push 不触发该工作流。
2. 只有完整 SemVer Tag 才触发工作流，并先通过严格版本解析和 `ci:shell-quality` 质量门禁。
3. 四个官方 Runner 分别调用同一个 `package:community`：
   - `macos-15`：macOS ARM64 DMG
   - `macos-15-intel`：macOS x64 DMG
   - `windows-2022`：Windows x64 EXE
   - `ubuntu-22.04`：Linux x64 AppImage 和 DEB
4. 四个目标全部成功后，汇总任务检查安装包数量、平台类型、重复名称和 SHA-256。
5. 校验通过后才创建 GitHub Release。

不增加另一套平台打包实现。配置同步、Runtime 同步、测试、smoke、Tauri 打包和制品扫描都由现有 `package:community` / `desktop:package` 链路负责。

## 本地开发验证

普通开发只运行与当前系统匹配的检查：

```bash
corepack pnpm@11.24.0 verify
corepack pnpm@11.24.0 test:e2e
corepack pnpm@11.24.0 runtime:smoke
```

需要检查当前 macOS 安装包时执行：

```bash
corepack pnpm@11.24.0 desktop:package
```

`desktop:package` 允许在尚未创建发行 Tag 的开发工作区构建本地验收包，并把源码 dirty 状态写入内部构建信息；正式 Tag 矩阵仍只使用门禁更严格的 `package:community`。本机验证只能证明当前 macOS 架构，Windows、Linux 和 macOS x64 的构建结果以对应官方 Runner 为准，不能用宿主机模拟结果冒充原生平台验收。

## 创建版本

默认和示例版本始终使用 `1.0.0`。真实发行版本来自 Tag，支持带或不带 `v` 前缀：

```text
1.0.0
v1.0.0
v1.0.0-rc.1
v1.0.0+build.1
```

发布前必须确认：

1. `master` 指向待发行 commit，工作区干净。
2. 本机规定的质量检查和当前 macOS 打包通过。
3. 版本尚未被远程 Tag 或 Release 使用。
4. Runtime 来源、Node `24.20.0`、pnpm `11.24.0`、Rust `1.98.0` 和 Tauri CLI `2.11.4` 与仓库 lock 一致。
5. 发布说明只描述本次实际交付内容。

创建新的 annotated Tag 后推送：

```bash
git tag -a v1.0.0 -m "DeepSeek Desktop v1.0.0"
git push origin master
git push origin v1.0.0
```

旧 Tag 不移动、不覆盖。某个平台失败时修复源码并使用下一个未占用版本，不能强推原 Tag。

## Release 资产

公开 Release 必须且只能包含：

- macOS ARM64 DMG
- macOS x64 DMG
- Windows x64 EXE
- Linux x64 AppImage
- Linux x64 DEB
- `SHA256SUMS`

各 Worker 上传的 `BUILD-INFO.<target>.json` 只供汇总任务核对来源和目标，不作为公开下载附件。Release 中缺少任一安装包、出现重复目标或多出内部文件时，发布任务必须失败。

稳定 SemVer 创建正式 Release；带 prerelease 标识的 SemVer（例如 `v1.0.0-rc.1`）创建预发布 Release。

## 签名与安全

- 第一方 GitHub Action 固定到完整 commit SHA。
- Node 与其他工具链读取仓库精确 lock，不使用 Runner 上碰巧存在的全局版本。
- 安装包扫描拒绝 `.env`、凭据、私钥、本机绝对路径和逃逸符号链接。
- Apple Developer ID、公证、Windows Authenticode 和 Tauri Updater 密钥通过受保护 CI Secrets 接入，不写入源码、日志或构建附件。
- 公开 Pull Request 不触发发布工作流，也不触发任何开发者本地节点。

## 故障恢复

### 质量检查失败

先在本地复现对应命令，修复后推送新的 commit。不要修改工作流绕过门禁。

### 单个平台失败

查看该平台原生 Job 的首个真实错误。其他平台的成功结果不能替代失败目标；修复后创建新版本 Tag 重新运行完整矩阵。

### 发布汇总失败

如果四个平台已经完成，优先修复资产筛选、命名或发布权限问题。上传失败本身不代表安装包代码失败，但仍应通过新的不可变版本完成正式发布，不移动旧 Tag。

### 发布后核验

重新读取远程 Release，确认 Tag/commit、六个公开文件、文件大小和 `SHA256SUMS`。在 macOS 和 Windows 真实系统完成安装、启动、Runtime、模型配置、对话、文件读写、插件、联网搜索和外部链接验收后，再对外声明对应平台完整可用。
