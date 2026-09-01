import { appConfig } from "../app-config";

const appName = appConfig.productName;

export const messages = {
  "zh-CN": {
    app: { name: appName, subtitle: "本地 AI Agent 工作台" },
    menu: { label: "应用菜单", file: "文件", edit: "编辑", view: "视图", window: "窗口", help: "帮助" },
    common: { start: "启动", retry: "重试", open: "打开工作台", stop: "停止", save: "保存", close: "关闭", languageSelector: "切换语言" },
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
      restarts: "恢复次数",
      errors: {
        artifactMissing: "Runtime 制品不完整，请重新安装应用。",
        workdirUnavailable: "Runtime 独立工作目录无法创建，请检查应用数据目录权限。",
        profilePrepareFailed: "Runtime 用户配置准备失败，请检查应用数据目录权限。",
        helperUnavailable: "桌面凭据 Helper 无法启动，请重新安装应用。",
        credentialSessionFailed: "无法创建本次 Runtime 的加密凭据会话。",
        environmentFailed: "Runtime 启动环境准备失败，请导出诊断信息。",
        timeout: "Runtime 启动超时，请导出诊断信息。",
        exited: "Runtime 在就绪前意外退出。",
        processManagementFailed: "操作系统无法建立 Runtime 进程管理通道。",
        outputUnavailable: "Runtime 输出通道不可用，请重新启动应用。",
        processStatusFailed: "操作系统无法读取 Runtime 进程状态。",
        outputClosed: "Runtime 在就绪前关闭了输出通道。",
        healthCheckFailed: "Runtime 本地健康检查失败。",
        credentialChannelFailed: "加密凭据库通信通道启动失败。",
        taskFailed: "Runtime 管理任务异常终止，请重试或导出诊断信息。",
        restartLimitReached: "Runtime 已达到自动恢复次数上限。"
      }
    },
    navigation: { label: "桌面导航", runtime: "运行状态", diagnostics: "诊断", update: "更新", about: "关于" },
    diagnostics: { eyebrow: "诊断", title: "运行诊断", description: "导出经过脱敏的状态、版本和日志。", export: "导出诊断包", exported: "诊断包已导出", exportLogs: "导出日志", logsExported: "日志已导出", runtime: "Runtime" },
    settings: { recovered: { corrupt: "设置文件已损坏，已备份原文件并恢复默认设置。", future: "设置文件来自更高版本，已备份原文件并恢复默认设置。" } },
    about: { eyebrow: "应用信息", title: `关于 ${appName}`, desktopVersion: "桌面版本", runtimeVersion: "Runtime 版本", nodeVersion: "Node 版本", channel: "更新通道", author: "作者", repository: "项目仓库", local: "本地构建", community: "社区版", stable: "稳定版", signed: "已签名发行构建", unsigned: "未签名构建" },
    update: { eyebrow: "发行通道", title: "更新", desktopTitle: "桌面应用", description: "桌面外壳与 Runtime 分别更新，当前可用版本始终保留。", currentVersion: "当前版本", channel: "更新通道", status: "更新状态", notChecked: "尚未检查更新。", check: "检查桌面更新", disabled: "当前社区版构建未签名，桌面自动更新已关闭。", current: "当前已是最新版本。", available: "发现新版本 {version}。", notConfigured: "签名更新服务尚未配置。" },
    runtimeUpdate: {
      title: "Runtime 独立更新", currentVersion: "当前 Runtime", source: "当前来源", commit: "Runtime commit", status: "更新状态", updateSource: "Runtime 更新源", manifestUrl: "更新清单地址", manifestUrlPlaceholder: "https://example.com/runtime/manifest.json", repository: "Runtime 仓库", publisher: "发布者", publicKey: "Ed25519 公钥", publicKeyPlaceholder: "Base64 编码的 32 字节公钥", sourceHelp: "默认使用官方源；自定义源必须提供完整的签名信任信息。", saveSource: "保存更新源", sourceSaved: "Runtime 更新源已保存。", mode: "更新方式", channel: "Runtime 频道", pin: "版本固定", pinCurrent: "固定当前 Runtime", check: "检查 Runtime", download: "下载并等待重启安装", restoreBundled: "恢复内置 Runtime",
      sources: { bundled: "安装包内置", updated: "独立更新" },
      updateSources: { official: "官方更新源", custom: "自定义更新源" },
      modes: { automatic: "自动下载，下次启动安装", notify: "发现后提醒", manual: "仅手动检查" },
      channels: { stable: "稳定版", preview: "预览版" },
      messages: { idle: "尚未检查 Runtime 更新。", not_configured: "未配置可信 Runtime 更新服务。", checking: "正在检查 Runtime 更新。", available: "发现 Runtime {version}。", up_to_date: "当前 Runtime 已是最新版本。", downloading: "正在下载并校验 Runtime。", applying: "正在安装并验证新 Runtime，请稍候。", restart_to_apply: "Runtime {version} 已就绪，将在下次启动安装。", applied: "Runtime 更新已安装。", check_failed: "Runtime 更新检查失败，当前版本未受影响。", download_failed: "Runtime 下载或校验失败，当前版本未受影响。", smoke_failed: "新 Runtime 启动验证失败，已保留当前版本。", pinned: "当前 Runtime 已固定，不会自动更新。", bundled_restored: "已恢复安装包内置 Runtime。", startup_rollback: "新 Runtime 启动失败，已自动回滚。" }
    },
    error: { unexpected: "操作失败，请查看诊断信息。", settingsSaveFailed: "设置保存失败，已恢复原设置。", diagnosticsExportFailed: "诊断包导出失败。", logsExportFailed: "日志导出失败。", updateCheckFailed: "桌面更新检查失败。", runtimeUpdateCheckFailed: "Runtime 更新检查失败，当前版本未受影响。", runtimeUpdateDownloadFailed: "Runtime 下载或校验失败，当前版本未受影响。", runtimeRestoreFailed: "恢复内置 Runtime 失败。", initializationFailed: "桌面应用初始化失败，请重新启动或查看日志。", eventChannelFailed: "状态事件通道连接失败，请刷新运行状态。" }
  },
  "zh-TW": {
    app: { name: appName, subtitle: "本機 AI Agent 工作臺" },
    menu: { label: "應用程式選單", file: "檔案", edit: "編輯", view: "檢視", window: "視窗", help: "輔助說明" },
    common: { start: "啟動", retry: "重試", open: "開啟工作臺", stop: "停止", save: "儲存", close: "關閉", languageSelector: "切換語言" },
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
      restarts: "復原次數",
      errors: {
        artifactMissing: "Runtime 制品不完整，請重新安裝應用程式。",
        workdirUnavailable: "Runtime 獨立工作目錄無法建立，請檢查應用程式資料目錄權限。",
        profilePrepareFailed: "Runtime 使用者設定準備失敗，請檢查應用程式資料目錄權限。",
        helperUnavailable: "桌面憑證 Helper 無法啟動，請重新安裝應用程式。",
        credentialSessionFailed: "無法建立本次 Runtime 的加密憑證工作階段。",
        environmentFailed: "Runtime 啟動環境準備失敗，請匯出診斷資訊。",
        timeout: "Runtime 啟動逾時，請匯出診斷資訊。",
        exited: "Runtime 在就緒前意外結束。",
        processManagementFailed: "作業系統無法建立 Runtime 行程管理通道。",
        outputUnavailable: "Runtime 輸出通道無法使用，請重新啟動應用程式。",
        processStatusFailed: "作業系統無法讀取 Runtime 行程狀態。",
        outputClosed: "Runtime 在就緒前關閉了輸出通道。",
        healthCheckFailed: "Runtime 本機健康檢查失敗。",
        credentialChannelFailed: "加密憑證庫通訊通道啟動失敗。",
        taskFailed: "Runtime 管理工作異常終止，請重試或匯出診斷資訊。",
        restartLimitReached: "Runtime 已達自動復原次數上限。"
      }
    },
    navigation: { label: "桌面導覽", runtime: "執行狀態", diagnostics: "診斷", update: "更新", about: "關於" },
    diagnostics: { eyebrow: "診斷", title: "執行診斷", description: "匯出經過遮蔽的狀態、版本和日誌。", export: "匯出診斷包", exported: "診斷包已匯出", exportLogs: "匯出日誌", logsExported: "日誌已匯出", runtime: "Runtime" },
    settings: { recovered: { corrupt: "設定檔已損壞，已備份原檔並恢復預設設定。", future: "設定檔來自較新版本，已備份原檔並恢復預設設定。" } },
    about: { eyebrow: "應用程式資訊", title: `關於 ${appName}`, desktopVersion: "桌面版本", runtimeVersion: "Runtime 版本", nodeVersion: "Node 版本", channel: "更新通道", author: "作者", repository: "專案倉庫", local: "本機構建", community: "社群版", stable: "穩定版", signed: "已簽章發行構建", unsigned: "未簽章構建" },
    update: { eyebrow: "發行通道", title: "更新", desktopTitle: "桌面應用程式", description: "桌面外殼與 Runtime 分別更新，目前可用版本始終保留。", currentVersion: "目前版本", channel: "更新通道", status: "更新狀態", notChecked: "尚未檢查更新。", check: "檢查桌面更新", disabled: "目前社群版構建尚未簽章，桌面自動更新已關閉。", current: "目前已是最新版本。", available: "發現新版本 {version}。", notConfigured: "簽名更新服務尚未設定。" },
    runtimeUpdate: {
      title: "Runtime 獨立更新", currentVersion: "目前 Runtime", source: "目前來源", commit: "Runtime commit", status: "更新狀態", updateSource: "Runtime 更新來源", manifestUrl: "更新清單位址", manifestUrlPlaceholder: "https://example.com/runtime/manifest.json", repository: "Runtime 倉庫", publisher: "發佈者", publicKey: "Ed25519 公鑰", publicKeyPlaceholder: "Base64 編碼的 32 位元組公鑰", sourceHelp: "預設使用官方來源；自訂來源必須提供完整的簽章信任資訊。", saveSource: "儲存更新來源", sourceSaved: "Runtime 更新來源已儲存。", mode: "更新方式", channel: "Runtime 頻道", pin: "版本固定", pinCurrent: "固定目前 Runtime", check: "檢查 Runtime", download: "下載並等待重新啟動安裝", restoreBundled: "還原內建 Runtime",
      sources: { bundled: "安裝包內建", updated: "獨立更新" },
      updateSources: { official: "官方更新來源", custom: "自訂更新來源" },
      modes: { automatic: "自動下載，下次啟動安裝", notify: "發現後提醒", manual: "僅手動檢查" },
      channels: { stable: "穩定版", preview: "預覽版" },
      messages: { idle: "尚未檢查 Runtime 更新。", not_configured: "未設定可信 Runtime 更新服務。", checking: "正在檢查 Runtime 更新。", available: "發現 Runtime {version}。", up_to_date: "目前 Runtime 已是最新版本。", downloading: "正在下載並驗證 Runtime。", applying: "正在安裝並驗證新 Runtime，請稍候。", restart_to_apply: "Runtime {version} 已準備完成，將在下次啟動安裝。", applied: "Runtime 更新已安裝。", check_failed: "Runtime 更新檢查失敗，目前版本未受影響。", download_failed: "Runtime 下載或驗證失敗，目前版本未受影響。", smoke_failed: "新 Runtime 啟動驗證失敗，已保留目前版本。", pinned: "目前 Runtime 已固定，不會自動更新。", bundled_restored: "已還原安裝包內建 Runtime。", startup_rollback: "新 Runtime 啟動失敗，已自動回復。" }
    },
    error: { unexpected: "操作失敗，請查看診斷資訊。", settingsSaveFailed: "設定儲存失敗，已恢復原設定。", diagnosticsExportFailed: "診斷包匯出失敗。", logsExportFailed: "日誌匯出失敗。", updateCheckFailed: "桌面更新檢查失敗。", runtimeUpdateCheckFailed: "Runtime 更新檢查失敗，目前版本未受影響。", runtimeUpdateDownloadFailed: "Runtime 下載或驗證失敗，目前版本未受影響。", runtimeRestoreFailed: "還原內建 Runtime 失敗。", initializationFailed: "桌面應用程式初始化失敗，請重新啟動或查看日誌。", eventChannelFailed: "狀態事件通道連線失敗，請重新整理執行狀態。" }
  },
  "en-US": {
    app: { name: appName, subtitle: "Local AI agent workspace" },
    menu: { label: "Application menu", file: "File", edit: "Edit", view: "View", window: "Window", help: "Help" },
    common: { start: "Start", retry: "Retry", open: "Open workbench", stop: "Stop", save: "Save", close: "Close", languageSelector: "Change language" },
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
      restarts: "Recovery attempts",
      errors: {
        artifactMissing: "The runtime artifact is incomplete. Reinstall the application.",
        workdirUnavailable: "The isolated Runtime working directory could not be created. Check the application data directory permissions.",
        profilePrepareFailed: "The Runtime profile could not be prepared. Check the application data directory permissions.",
        helperUnavailable: "The desktop credential helper could not start. Reinstall the application.",
        credentialSessionFailed: "An encrypted credential session could not be created for this Runtime launch.",
        environmentFailed: "The Runtime launch environment could not be prepared. Export diagnostics for details.",
        timeout: "Runtime startup timed out. Export diagnostics for details.",
        exited: "The runtime exited before it became ready.",
        processManagementFailed: "The operating system could not establish the Runtime process management channel.",
        outputUnavailable: "The Runtime output channel is unavailable. Restart the application.",
        processStatusFailed: "The operating system could not read the Runtime process status.",
        outputClosed: "The runtime closed its output before it became ready.",
        healthCheckFailed: "The local runtime health check failed.",
        credentialChannelFailed: "The encrypted credential vault channel could not start.",
        taskFailed: "The runtime management task stopped unexpectedly. Retry or export diagnostics.",
        restartLimitReached: "The runtime reached its automatic recovery limit."
      }
    },
    navigation: { label: "Desktop navigation", runtime: "Runtime", diagnostics: "Diagnostics", update: "Updates", about: "About" },
    diagnostics: { eyebrow: "Diagnostics", title: "Runtime diagnostics", description: "Export redacted status, version, and log information.", export: "Export diagnostics", exported: "Diagnostics exported", exportLogs: "Export logs", logsExported: "Logs exported", runtime: "Runtime" },
    settings: { recovered: { corrupt: "The settings file was damaged. The original was backed up and defaults were restored.", future: "The settings file came from a newer version. The original was backed up and defaults were restored." } },
    about: { eyebrow: "Application information", title: `About ${appName}`, desktopVersion: "Desktop version", runtimeVersion: "Runtime version", nodeVersion: "Node version", channel: "Update channel", author: "Author", repository: "Repository", local: "Local build", community: "Community", stable: "Stable", signed: "Signed release build", unsigned: "Unsigned build" },
    update: { eyebrow: "Release channel", title: "Updates", desktopTitle: "Desktop application", description: "The Desktop shell and Runtime update independently while the last working version remains available.", currentVersion: "Current version", channel: "Update channel", status: "Update status", notChecked: "Updates have not been checked.", check: "Check Desktop", disabled: "This community build is unsigned, so Desktop automatic updates are disabled.", current: "This version is current.", available: "Version {version} is available.", notConfigured: "Signed updates are not configured." },
    runtimeUpdate: {
      title: "Independent Runtime update", currentVersion: "Current Runtime", source: "Current source", commit: "Runtime commit", status: "Update status", updateSource: "Runtime update source", manifestUrl: "Manifest URL", manifestUrlPlaceholder: "https://example.com/runtime/manifest.json", repository: "Runtime repository", publisher: "Publisher", publicKey: "Ed25519 public key", publicKeyPlaceholder: "Base64-encoded 32-byte public key", sourceHelp: "The official source is used by default. Custom sources require a complete signing trust profile.", saveSource: "Save update source", sourceSaved: "The Runtime update source was saved.", mode: "Update behavior", channel: "Runtime channel", pin: "Version pin", pinCurrent: "Pin current Runtime", check: "Check Runtime", download: "Download for next launch", restoreBundled: "Restore bundled Runtime",
      sources: { bundled: "Bundled with installer", updated: "Independent update" },
      updateSources: { official: "Official source", custom: "Custom source" },
      modes: { automatic: "Download automatically, install next launch", notify: "Notify when available", manual: "Manual checks only" },
      channels: { stable: "Stable", preview: "Preview" },
      messages: { idle: "Runtime updates have not been checked.", not_configured: "A trusted Runtime update service is not configured.", checking: "Checking for a Runtime update.", available: "Runtime {version} is available.", up_to_date: "The current Runtime is up to date.", downloading: "Downloading and verifying the Runtime.", applying: "Installing and verifying the new Runtime.", restart_to_apply: "Runtime {version} is ready and will install at the next launch.", applied: "The Runtime update was installed.", check_failed: "The Runtime check failed. The current version was not changed.", download_failed: "The Runtime download or verification failed. The current version was not changed.", smoke_failed: "The new Runtime failed its startup check. The current version was kept.", pinned: "The current Runtime is pinned and will not update automatically.", bundled_restored: "The bundled Runtime was restored.", startup_rollback: "The new Runtime failed to start and was rolled back automatically." }
    },
    error: { unexpected: "The operation failed. Open diagnostics for details.", settingsSaveFailed: "The settings could not be saved. The previous value was restored.", diagnosticsExportFailed: "Diagnostics could not be exported.", logsExportFailed: "Logs could not be exported.", updateCheckFailed: "The Desktop update check failed.", runtimeUpdateCheckFailed: "The Runtime update check failed. The current version was not changed.", runtimeUpdateDownloadFailed: "The Runtime download or verification failed. The current version was not changed.", runtimeRestoreFailed: "The bundled Runtime could not be restored.", initializationFailed: "The desktop application could not initialize. Restart it or inspect the logs.", eventChannelFailed: "The status event channel could not connect. Refresh the runtime status." }
  }
} as const;
