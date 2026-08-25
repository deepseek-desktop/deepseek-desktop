# Agent 协作指南

## 适用范围

本仓库只包含 DeepSeek Desktop。生成的 Runtime 暂存目录、构建产物、本地工具链、上游审计检出、凭据和用户工作区数据均不得提交。

## 权威来源

- `runtime/runtime-lock.json` 记录上游 Runtime 版本、校验和、目标平台和桌面补丁。
- `src-tauri/` 负责原生生命周期、加密凭据库、诊断、设置和更新边界。
- `src/` 负责 Vue 桌面 Shell 和类型化 IPC 契约。
- `README.md`、`docs/`、`SECURITY.md` 和 `CONTRIBUTING.md` 定义公开行为与协作规则。

## 修改规则

- 仓库文档、Issue / Pull Request 模板和发布说明以简体中文为主；确有国际协作需要时可附英文摘要，但不以英文替代中文正文。
- 用户可见文案必须同时补齐 `zh-CN`、`zh-TW` 和 `en-US`。
- 工作台 WebView 不得获得通用 Tauri Shell、文件系统或 IPC capability。
- 禁止增加明文凭据降级存储。
- 未经真实验证，不得宣称已完成签名、公证、平台支持或外部 Provider 兼容。
- 修改应聚焦；除非有意升级并同步更新校验和、许可证、SBOM 预期、测试和文档，否则保持锁定 Runtime 不变。

## 验证

开发时运行与改动范围匹配的最小检查。涉及发行的改动必须执行：

```bash
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 test:e2e
corepack pnpm@11.7.0 runtime:smoke
```

`verify` 会先暂存并校验目标 Runtime，再执行 Rust 检查，确保干净检出不依赖历史生成的 sidecar。
