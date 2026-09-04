# 参与贡献

感谢你帮助改进 DeepSeek Desktop。

## 提交修改前

1. 先搜索已有 Issue 和 Pull Request。
2. 每次修改只聚焦一个行为或工程问题。
3. 禁止提交凭据、本地工作区、生成的 Harness 暂存目录、构建产物或上游审计检出。
4. 除非本次修改明确升级 Harness，并同步更新校验和、许可证、测试和文档，否则保持锁定 Harness 契约不变。

## 开发环境

```bash
corepack pnpm@11.24.0 install --frozen-lockfile
corepack pnpm@11.24.0 app:sync
corepack pnpm@11.24.0 harness:sync
corepack pnpm@11.24.0 verify
corepack pnpm@11.24.0 test:e2e
```

`harness:sync` 会锁定 Harness 来源、构建生产 Harness 并生成完整性记录；`verify` 会在 Rust 检查前暂存并校验目标 Harness。仓库脚本将 Rust 安装到 `target/deepseek-desktop-toolchain/`，不会修改全局 Rust 环境。

发布标签前，先使用 Docker 复现 GitHub 通用质量任务，再打包当前原生平台：

```bash
corepack pnpm@11.24.0 release:preflight
```

macOS 本机与 Windows 虚拟机都应执行该命令。Docker 不能替代对应平台的 Tauri、WebView、DMG / NSIS 和进程窗口验证。Apple Silicon 上的 Linux amd64 容器只跳过容易受架构模拟影响的 Harness 启动 smoke；该项由随后执行的 macOS 原生打包补齐，GitHub 原生 Linux x64 仍执行完整 smoke。

已完成预检后，仅执行社区发行门禁和当前原生平台打包：

```bash
corepack pnpm@11.24.0 package:community
```

## Pull Request

- 文档、Issue / Pull Request 和发布说明以简体中文为主，必要时可附英文摘要。
- 说明用户可见行为和安全影响。
- 用户可见文案必须同时更新 `zh-CN`、`zh-TW` 和 `en-US`。
- 运行与改动范围匹配的检查，并附上结果。
- 工作台 WebView 不得获得通用 Tauri Shell、文件系统或 IPC capability。
- 未经真实验证，不得宣称已完成签名、公证、平台支持或外部 Provider 兼容。

提交贡献即表示你同意以 Apache-2.0 许可证提供该贡献。
