import { appConfig } from "../app-config";

const appName = appConfig.productName;

export const messages = {
  "zh-CN": {
    app: { name: appName, subtitle: "本地 AI Agent 工作台" },
    common: { continue: "继续", back: "返回", start: "启动", retry: "重试", open: "打开工作台", stop: "停止", save: "保存", close: "关闭", languageSelector: "切换语言" },
    features: { runtime: "本地 Runtime", runtimeValue: "仅监听 127.0.0.1", vault: "加密凭据库", vaultValue: "密钥加密后仅保存在本机", workspace: "受管工作区", workspaceValue: "明确限定目录" },
    onboarding: {
      welcomeTitle: `欢迎使用 ${appName}`,
      welcomeDescription: "Runtime、会话和凭据都保存在本机。",
      workspaceTitle: "选择工作区",
      workspaceDescription: "Agent 只会在你选择的目录中工作。",
      workspacePlaceholder: "尚未选择工作区",
      chooseWorkspace: "选择目录",
      modelTitle: "配置模型",
      modelDescription: "启动后前往模型设置添加 Provider 和密钥。",
      start: "启动工作台"
    },
    runtime: {
      idle: "准备启动",
      starting: "正在启动 Runtime",
      ready: "Runtime 已就绪",
      stopping: "正在停止 Runtime",
      recovering: "Runtime 正在恢复",
      failed: "Runtime 启动失败",
      detail: "首次启动可能需要数秒，请稍候。",
      diagnosticId: "诊断编号",
      supervisor: "Runtime 管理器",
      state: "状态",
      origin: "本地地址",
      workspace: "工作区",
      restarts: "恢复次数",
      errors: {
        artifactMissing: "Runtime 制品不完整，请重新安装应用。",
        timeout: "Runtime 启动超时，请导出诊断信息。",
        exited: "Runtime 在就绪前意外退出。",
        outputClosed: "Runtime 在就绪前关闭了输出通道。",
        healthCheckFailed: "Runtime 本地健康检查失败。",
        credentialChannelFailed: "加密凭据库通信通道启动失败。",
        taskFailed: "Runtime 管理任务异常终止，请重试或导出诊断信息。",
        restartLimitReached: "Runtime 已达到自动恢复次数上限。"
      }
    },
    navigation: { label: "桌面导航", onboarding: "开始使用", runtime: "运行状态", diagnostics: "诊断", update: "更新", about: "关于" },
    diagnostics: { eyebrow: "诊断", title: "运行诊断", description: "导出经过脱敏的状态、版本和日志。", export: "导出诊断包", exported: "诊断包已导出", exportLogs: "导出日志", logsExported: "日志已导出", runtime: "Runtime", workspace: "工作区" },
    about: { eyebrow: "社区版发行", title: `关于 ${appName}`, desktopVersion: "桌面版本", runtimeVersion: "Runtime 版本", nodeVersion: "Node 版本", channel: "更新通道", author: "作者", repository: "项目仓库", community: "社区版", unsigned: "社区版未签名构建" },
    update: { eyebrow: "发行通道", title: "应用更新", description: "仅安装经过签名验证的正式发行包。", currentVersion: "当前版本", channel: "更新通道", status: "更新状态", notChecked: "尚未检查更新。", check: "检查更新", disabled: "当前社区版构建未签名，自动更新已关闭。", current: "当前已是最新版本。", available: "发现新版本 {version}。", notConfigured: "签名更新服务尚未配置。" },
    error: { workspaceRequired: "请先选择工作区。", unexpected: "操作失败，请查看诊断信息。" }
  },
  "zh-TW": {
    app: { name: appName, subtitle: "本機 AI Agent 工作臺" },
    common: { continue: "繼續", back: "返回", start: "啟動", retry: "重試", open: "開啟工作臺", stop: "停止", save: "儲存", close: "關閉", languageSelector: "切換語言" },
    features: { runtime: "本機 Runtime", runtimeValue: "僅監聽 127.0.0.1", vault: "加密憑證庫", vaultValue: "金鑰加密後僅儲存在本機", workspace: "受管工作區", workspaceValue: "明確限定目錄" },
    onboarding: {
      welcomeTitle: `歡迎使用 ${appName}`,
      welcomeDescription: "Runtime、工作階段和憑證都儲存在本機。",
      workspaceTitle: "選擇工作區",
      workspaceDescription: "Agent 只會在你選擇的目錄中工作。",
      workspacePlaceholder: "尚未選擇工作區",
      chooseWorkspace: "選擇目錄",
      modelTitle: "設定模型",
      modelDescription: "啟動後前往模型設定新增 Provider 和金鑰。",
      start: "啟動工作臺"
    },
    runtime: {
      idle: "準備啟動",
      starting: "正在啟動 Runtime",
      ready: "Runtime 已就緒",
      stopping: "正在停止 Runtime",
      recovering: "Runtime 正在恢復",
      failed: "Runtime 啟動失敗",
      detail: "首次啟動可能需要數秒，請稍候。",
      diagnosticId: "診斷編號",
      supervisor: "Runtime 管理器",
      state: "狀態",
      origin: "本機位址",
      workspace: "工作區",
      restarts: "復原次數",
      errors: {
        artifactMissing: "Runtime 制品不完整，請重新安裝應用程式。",
        timeout: "Runtime 啟動逾時，請匯出診斷資訊。",
        exited: "Runtime 在就緒前意外結束。",
        outputClosed: "Runtime 在就緒前關閉了輸出通道。",
        healthCheckFailed: "Runtime 本機健康檢查失敗。",
        credentialChannelFailed: "加密憑證庫通訊通道啟動失敗。",
        taskFailed: "Runtime 管理工作異常終止，請重試或匯出診斷資訊。",
        restartLimitReached: "Runtime 已達自動復原次數上限。"
      }
    },
    navigation: { label: "桌面導覽", onboarding: "開始使用", runtime: "執行狀態", diagnostics: "診斷", update: "更新", about: "關於" },
    diagnostics: { eyebrow: "診斷", title: "執行診斷", description: "匯出經過遮蔽的狀態、版本和日誌。", export: "匯出診斷包", exported: "診斷包已匯出", exportLogs: "匯出日誌", logsExported: "日誌已匯出", runtime: "Runtime", workspace: "工作區" },
    about: { eyebrow: "社群版發行", title: `關於 ${appName}`, desktopVersion: "桌面版本", runtimeVersion: "Runtime 版本", nodeVersion: "Node 版本", channel: "更新通道", author: "作者", repository: "專案倉庫", community: "社群版", unsigned: "社群版未簽章構建" },
    update: { eyebrow: "發行通道", title: "應用程式更新", description: "僅安裝通過簽名驗證的正式發行套件。", currentVersion: "目前版本", channel: "更新通道", status: "更新狀態", notChecked: "尚未檢查更新。", check: "檢查更新", disabled: "目前社群版構建尚未簽章，自動更新已關閉。", current: "目前已是最新版本。", available: "發現新版本 {version}。", notConfigured: "簽名更新服務尚未設定。" },
    error: { workspaceRequired: "請先選擇工作區。", unexpected: "操作失敗，請查看診斷資訊。" }
  },
  "en-US": {
    app: { name: appName, subtitle: "Local AI agent workspace" },
    common: { continue: "Continue", back: "Back", start: "Start", retry: "Retry", open: "Open workspace", stop: "Stop", save: "Save", close: "Close", languageSelector: "Change language" },
    features: { runtime: "Local runtime", runtimeValue: "Listens only on 127.0.0.1", vault: "Encrypted credential vault", vaultValue: "Keys remain encrypted on this device", workspace: "Managed workspace", workspaceValue: "Explicit directory scope" },
    onboarding: {
      welcomeTitle: `Welcome to ${appName}`,
      welcomeDescription: "The runtime, sessions, and credentials stay on this device.",
      workspaceTitle: "Choose a workspace",
      workspaceDescription: "The agent works only inside the directory you select.",
      workspacePlaceholder: "No workspace selected",
      chooseWorkspace: "Choose folder",
      modelTitle: "Configure a model",
      modelDescription: "After startup, open Model Settings to add a provider and credential.",
      start: "Start workspace"
    },
    runtime: {
      idle: "Ready to start",
      starting: "Starting runtime",
      ready: "Runtime ready",
      stopping: "Stopping runtime",
      recovering: "Recovering runtime",
      failed: "Runtime failed to start",
      detail: "The first startup can take a few seconds.",
      diagnosticId: "Diagnostic ID",
      supervisor: "Runtime supervisor",
      state: "State",
      origin: "Local origin",
      workspace: "Workspace",
      restarts: "Recovery attempts",
      errors: {
        artifactMissing: "The runtime artifact is incomplete. Reinstall the application.",
        timeout: "Runtime startup timed out. Export diagnostics for details.",
        exited: "The runtime exited before it became ready.",
        outputClosed: "The runtime closed its output before it became ready.",
        healthCheckFailed: "The local runtime health check failed.",
        credentialChannelFailed: "The encrypted credential vault channel could not start.",
        taskFailed: "The runtime management task stopped unexpectedly. Retry or export diagnostics.",
        restartLimitReached: "The runtime reached its automatic recovery limit."
      }
    },
    navigation: { label: "Desktop navigation", onboarding: "Get started", runtime: "Runtime", diagnostics: "Diagnostics", update: "Updates", about: "About" },
    diagnostics: { eyebrow: "Diagnostics", title: "Runtime diagnostics", description: "Export redacted status, version, and log information.", export: "Export diagnostics", exported: "Diagnostics exported", exportLogs: "Export logs", logsExported: "Logs exported", runtime: "Runtime", workspace: "Workspace" },
    about: { eyebrow: "Community distribution", title: `About ${appName}`, desktopVersion: "Desktop version", runtimeVersion: "Runtime version", nodeVersion: "Node version", channel: "Update channel", author: "Author", repository: "Repository", community: "Community", unsigned: "Unsigned community build" },
    update: { eyebrow: "Release channel", title: "Application updates", description: "Only formally released packages with a valid signature can be installed.", currentVersion: "Current version", channel: "Update channel", status: "Update status", notChecked: "Updates have not been checked.", check: "Check for updates", disabled: "This community build is unsigned, so automatic updates are disabled.", current: "This version is current.", available: "Version {version} is available.", notConfigured: "Signed updates are not configured." },
    error: { workspaceRequired: "Choose a workspace first.", unexpected: "The operation failed. Open diagnostics for details." }
  }
} as const;
