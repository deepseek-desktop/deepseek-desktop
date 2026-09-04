# ADR-002：跨平台本地加密凭据库

## 状态

已采用。

## 决策

macOS、Windows 和 Linux 统一使用 Desktop 自有的本地加密凭据库，不再使用系统钥匙串。Harness Credential Provider 通过短期会话和 stdin/stdout JSON 调用桌面 helper；API Key、OAuth grant 和记录索引均进入加密存储。

不允许退回 `.credentials.yaml`、`.env` 或其他明文文件。旧版明文 `credential-index.json` 只作为一次性迁移输入：成功写入加密索引后才删除原文件。

## 理由

- 避免 macOS 钥匙串反复授权弹窗和跨平台行为差异。
- 保持 Harness、WebView、日志和诊断包无法直接读取长期明文凭据。
- 用统一协议降低 Provider 与桌面原生实现的耦合。

## 安全边界

该方案防止凭据因普通配置、日志或诊断导出而明文泄漏，但不承诺抵御已经获得同一系统用户权限并能读取应用数据和内存的恶意程序。文档和界面不得夸大其保护级别。
