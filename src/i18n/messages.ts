import { appConfig } from "../app-config";

const appName = appConfig.productName;

export const messages = {
  "zh-CN": {
    app: { name: appName, subtitle: "本地 AI Agent 工作台" },
    common: { start: "启动", retry: "重试", open: "打开工作台", stop: "停止", save: "保存", close: "关闭", languageSelector: "切换语言" },
    menu: { label: "应用菜单", file: "文件", edit: "编辑", view: "视图", window: "窗口", help: "帮助" },
    harness: {
      idle: "准备启动",
      starting: "正在启动 Harness",
      ready: "Harness 已就绪",
      stopping: "正在停止 Harness",
      recovering: "Harness 正在恢复",
      failed: "Harness 启动失败",
      detail: "首次启动可能需要数秒，请稍候。",
      diagnosticId: "诊断编号",
      supervisor: "Harness 管理器",
      state: "状态",
      origin: "本地地址",
      restarts: "恢复次数",
      errors: {
        artifactMissing: "Harness 制品不完整，请重新安装应用。",
        workdirUnavailable: "Harness 独立工作目录无法创建，请检查应用数据目录权限。",
        profilePrepareFailed: "Harness 用户配置准备失败，请检查应用数据目录权限。",
        helperUnavailable: "桌面凭据 Helper 无法启动，请重新安装应用。",
        credentialSessionFailed: "无法创建本次 Harness 的加密凭据会话。",
        environmentFailed: "Harness 启动环境准备失败，请导出诊断信息。",
        timeout: "Harness 启动超时，请导出诊断信息。",
        exited: "Harness 在就绪前意外退出。",
        processManagementFailed: "操作系统无法建立 Harness 进程管理通道。",
        outputUnavailable: "Harness 输出通道不可用，请重新启动应用。",
        processStatusFailed: "操作系统无法读取 Harness 进程状态。",
        outputClosed: "Harness 在就绪前关闭了输出通道。",
        healthCheckFailed: "Harness 本地健康检查失败。",
        credentialChannelFailed: "加密凭据库通信通道启动失败。",
        taskFailed: "Harness 管理任务异常终止，请重试或导出诊断信息。",
        restartLimitReached: "Harness 已达到自动恢复次数上限。"
      }
    },
    navigation: { label: "设置导航", settings: "设置", closeSettings: "关闭设置并返回工作台", harness: "运行状态", diagnostics: "诊断", update: "更新", about: "关于" },
    diagnostics: { eyebrow: "诊断", title: "运行诊断", description: "导出经过脱敏的状态、版本和日志。", export: "导出诊断包", exported: "诊断包已导出", exportLogs: "导出日志", logsExported: "日志已导出", harness: "Harness" },
    settings: { recovered: { corrupt: "设置文件已损坏，已备份原文件并恢复默认设置。", future: "设置文件来自更高版本，已备份原文件并恢复默认设置。" } },
    about: { eyebrow: "应用信息", title: `关于 ${appName}`, desktopVersion: "桌面版本", harnessVersion: "Harness 版本", nodeVersion: "Node 版本", channel: "更新通道", author: "作者", repository: "项目仓库", local: "本地构建", community: "社区版", stable: "稳定版", signed: "已签名发行构建", unsigned: "未签名构建" },
    update: { eyebrow: "发行通道", title: "更新", desktopTitle: "Desktop 更新", description: "Desktop 外壳与 Harness 分别更新，当前可用版本始终保留。", currentVersion: "当前版本", channel: "更新通道", status: "更新状态", notChecked: "尚未检查 Desktop 更新。", check: "检查 Desktop 更新", disabled: "当前社区版构建未签名，Desktop 自动安装已关闭。", current: "当前 Desktop 已是最新版本。", available: "发现 Desktop {version}。", ignored: "已忽略 Desktop {version}。", skipped: "今日已自动检查 Desktop 更新。", notConfigured: "签名更新服务尚未配置。", promptTitle: "发现 Desktop {version}", classificationUnknown: "发行类型未知", prerelease: "预发布版", publishedAt: "发布时间", summary: "更新摘要", noSummary: "此版本未提供更新摘要。", communityNotice: "当前社区版未签名，将打开官方 Release 页面，由你确认并下载安装包。", download: "前往下载", later: "稍后提醒", ignoreVersion: "忽略此版本" },
    harnessUpdate: {
      title: "Harness 独立更新", currentVersion: "当前 Harness", source: "当前来源", commit: "Harness commit", status: "更新状态", repository: "Harness 仓库", repositoryPlaceholder: "https://github.com/owner/deepseek-harness.git", repositoryHelp: "更换仓库即可切换 Harness；准备失败会继续使用当前版本。", saveRepository: "保存仓库", repositorySaved: "Harness 仓库已保存。", mode: "更新方式", channel: "Harness 频道", pin: "版本固定", pinCurrent: "固定当前 Harness", check: "检查 Harness", download: "准备并等待重启切换", restoreBundled: "恢复内置 Harness",
      sources: { bundled: "安装包内置", updated: "独立更新" },
      modes: { automatic: "自动下载，下次启动安装", notify: "发现后提醒", manual: "仅手动检查" },
      channels: { stable: "稳定版", preview: "预览版" },
      messages: { repository_timeout: "Harness 仓库连接超时，请检查网络或代理后重试。当前版本未受影响。", idle: "尚未检查 Harness 更新。", not_configured: "未配置 Harness 仓库。", checking: "正在检查 Harness 仓库。", available: "发现 Harness {version}。", up_to_date: "当前 Harness 已是最新版本。", downloading: "正在下载并校验 Harness。", preparing_repository: "正在从仓库拉取、构建并验证 Harness。", applying: "正在安装并验证新 Harness，请稍候。", restart_to_apply: "Harness {version} 已就绪，将在下次启动切换。", applied: "Harness 更新已安装。", check_failed: "Harness 仓库检查失败，当前版本未受影响。", download_failed: "Harness 准备或校验失败，当前版本未受影响。", smoke_failed: "新 Harness 启动验证失败，已保留当前版本。", pinned: "当前 Harness 已固定，不会自动更新。", bundled_restored: "已恢复安装包内置 Harness。", startup_rollback: "新 Harness 启动失败，已自动回滚。" }
    },
    error: { updateLinkOpenFailed: "链接无法打开，请重试。", unexpected: "操作失败，请查看诊断信息。", menuOpenFailed: "菜单无法打开，请重试。", settingsSaveFailed: "设置保存失败，已恢复原设置。", harnessRepositoryFailed: "Harness 仓库地址无效，请检查后重试。", diagnosticsExportFailed: "诊断包导出失败。", logsExportFailed: "日志导出失败。", updateCheckFailed: "Desktop 更新检查失败。", updateOpenFailed: "无法打开官方 Desktop Release 页面。", harnessUpdateCheckFailed: "Harness 更新检查失败，当前版本未受影响。", harnessUpdateDownloadFailed: "Harness 准备或校验失败，当前版本未受影响。", harnessRestoreFailed: "恢复内置 Harness 失败。", initializationFailed: "桌面应用初始化失败，请重新启动或查看日志。", eventChannelFailed: "状态事件通道连接失败，请刷新运行状态。" }
  },
  "zh-TW": {
    app: { name: appName, subtitle: "本機 AI Agent 工作臺" },
    common: { start: "啟動", retry: "重試", open: "開啟工作臺", stop: "停止", save: "儲存", close: "關閉", languageSelector: "切換語言" },
    menu: { label: "應用程式選單", file: "檔案", edit: "編輯", view: "顯示方式", window: "視窗", help: "輔助說明" },
    harness: {
      idle: "準備啟動",
      starting: "正在啟動 Harness",
      ready: "Harness 已就緒",
      stopping: "正在停止 Harness",
      recovering: "Harness 正在恢復",
      failed: "Harness 啟動失敗",
      detail: "首次啟動可能需要數秒，請稍候。",
      diagnosticId: "診斷編號",
      supervisor: "Harness 管理器",
      state: "狀態",
      origin: "本機位址",
      restarts: "復原次數",
      errors: {
        artifactMissing: "Harness 制品不完整，請重新安裝應用程式。",
        workdirUnavailable: "Harness 獨立工作目錄無法建立，請檢查應用程式資料目錄權限。",
        profilePrepareFailed: "Harness 使用者設定準備失敗，請檢查應用程式資料目錄權限。",
        helperUnavailable: "桌面憑證 Helper 無法啟動，請重新安裝應用程式。",
        credentialSessionFailed: "無法建立本次 Harness 的加密憑證工作階段。",
        environmentFailed: "Harness 啟動環境準備失敗，請匯出診斷資訊。",
        timeout: "Harness 啟動逾時，請匯出診斷資訊。",
        exited: "Harness 在就緒前意外結束。",
        processManagementFailed: "作業系統無法建立 Harness 行程管理通道。",
        outputUnavailable: "Harness 輸出通道無法使用，請重新啟動應用程式。",
        processStatusFailed: "作業系統無法讀取 Harness 行程狀態。",
        outputClosed: "Harness 在就緒前關閉了輸出通道。",
        healthCheckFailed: "Harness 本機健康檢查失敗。",
        credentialChannelFailed: "加密憑證庫通訊通道啟動失敗。",
        taskFailed: "Harness 管理工作異常終止，請重試或匯出診斷資訊。",
        restartLimitReached: "Harness 已達自動復原次數上限。"
      }
    },
    navigation: { label: "設定導覽", settings: "設定", closeSettings: "關閉設定並返回工作臺", harness: "執行狀態", diagnostics: "診斷", update: "更新", about: "關於" },
    diagnostics: { eyebrow: "診斷", title: "執行診斷", description: "匯出經過遮蔽的狀態、版本和日誌。", export: "匯出診斷包", exported: "診斷包已匯出", exportLogs: "匯出日誌", logsExported: "日誌已匯出", harness: "Harness" },
    settings: { recovered: { corrupt: "設定檔已損壞，已備份原檔並恢復預設設定。", future: "設定檔來自較新版本，已備份原檔並恢復預設設定。" } },
    about: { eyebrow: "應用程式資訊", title: `關於 ${appName}`, desktopVersion: "桌面版本", harnessVersion: "Harness 版本", nodeVersion: "Node 版本", channel: "更新通道", author: "作者", repository: "專案倉庫", local: "本機構建", community: "社群版", stable: "穩定版", signed: "已簽章發行構建", unsigned: "未簽章構建" },
    update: { eyebrow: "發行通道", title: "更新", desktopTitle: "Desktop 更新", description: "Desktop 外殼與 Harness 分別更新，目前可用版本始終保留。", currentVersion: "目前版本", channel: "更新通道", status: "更新狀態", notChecked: "尚未檢查 Desktop 更新。", check: "檢查 Desktop 更新", disabled: "目前社群版構建尚未簽章，Desktop 自動安裝已關閉。", current: "目前 Desktop 已是最新版本。", available: "發現 Desktop {version}。", ignored: "已忽略 Desktop {version}。", skipped: "今日已自動檢查 Desktop 更新。", notConfigured: "簽名更新服務尚未設定。", promptTitle: "發現 Desktop {version}", classificationUnknown: "發行類型未知", prerelease: "預發佈版", publishedAt: "發佈時間", summary: "更新摘要", noSummary: "此版本未提供更新摘要。", communityNotice: "目前社群版尚未簽章，將開啟官方 Release 頁面，由你確認並下載安裝包。", download: "前往下載", later: "稍後提醒", ignoreVersion: "忽略此版本" },
    harnessUpdate: {
      title: "Harness 獨立更新", currentVersion: "目前 Harness", source: "目前來源", commit: "Harness commit", status: "更新狀態", repository: "Harness 倉庫", repositoryPlaceholder: "https://github.com/owner/deepseek-harness.git", repositoryHelp: "更換倉庫即可切換 Harness；準備失敗會繼續使用目前版本。", saveRepository: "儲存倉庫", repositorySaved: "Harness 倉庫已儲存。", mode: "更新方式", channel: "Harness 頻道", pin: "版本固定", pinCurrent: "固定目前 Harness", check: "檢查 Harness", download: "準備並等待重新啟動切換", restoreBundled: "還原內建 Harness",
      sources: { bundled: "安裝包內建", updated: "獨立更新" },
      modes: { automatic: "自動下載，下次啟動安裝", notify: "發現後提醒", manual: "僅手動檢查" },
      channels: { stable: "穩定版", preview: "預覽版" },
      messages: { repository_timeout: "Harness 倉庫連線逾時，請檢查網路或代理後重試。目前版本未受影響。", idle: "尚未檢查 Harness 更新。", not_configured: "未設定 Harness 倉庫。", checking: "正在檢查 Harness 倉庫。", available: "發現 Harness {version}。", up_to_date: "目前 Harness 已是最新版本。", downloading: "正在下載並驗證 Harness。", preparing_repository: "正在從倉庫拉取、構建並驗證 Harness。", applying: "正在安裝並驗證新 Harness，請稍候。", restart_to_apply: "Harness {version} 已準備完成，將在下次啟動切換。", applied: "Harness 更新已安裝。", check_failed: "Harness 倉庫檢查失敗，目前版本未受影響。", download_failed: "Harness 準備或驗證失敗，目前版本未受影響。", smoke_failed: "新 Harness 啟動驗證失敗，已保留目前版本。", pinned: "目前 Harness 已固定，不會自動更新。", bundled_restored: "已還原安裝包內建 Harness。", startup_rollback: "新 Harness 啟動失敗，已自動回復。" }
    },
    error: { updateLinkOpenFailed: "連結無法開啟，請重試。", unexpected: "操作失敗，請查看診斷資訊。", menuOpenFailed: "選單無法開啟，請重試。", settingsSaveFailed: "設定儲存失敗，已恢復原設定。", harnessRepositoryFailed: "Harness 倉庫位址無效，請檢查後重試。", diagnosticsExportFailed: "診斷包匯出失敗。", logsExportFailed: "日誌匯出失敗。", updateCheckFailed: "Desktop 更新檢查失敗。", updateOpenFailed: "無法開啟官方 Desktop Release 頁面。", harnessUpdateCheckFailed: "Harness 更新檢查失敗，目前版本未受影響。", harnessUpdateDownloadFailed: "Harness 準備或驗證失敗，目前版本未受影響。", harnessRestoreFailed: "還原內建 Harness 失敗。", initializationFailed: "桌面應用程式初始化失敗，請重新啟動或查看日誌。", eventChannelFailed: "狀態事件通道連線失敗，請重新整理執行狀態。" }
  },
  "en-US": {
    app: { name: appName, subtitle: "Local AI agent workspace" },
    common: { start: "Start", retry: "Retry", open: "Open workbench", stop: "Stop", save: "Save", close: "Close", languageSelector: "Change language" },
    menu: { label: "Application menu", file: "File", edit: "Edit", view: "View", window: "Window", help: "Help" },
    harness: {
      idle: "Ready to start",
      starting: "Starting Harness",
      ready: "Harness ready",
      stopping: "Stopping Harness",
      recovering: "Recovering Harness",
      failed: "Harness failed to start",
      detail: "The first startup can take a few seconds.",
      diagnosticId: "Diagnostic ID",
      supervisor: "Harness supervisor",
      state: "State",
      origin: "Local origin",
      restarts: "Recovery attempts",
      errors: {
        artifactMissing: "The Harness artifact is incomplete. Reinstall the application.",
        workdirUnavailable: "The isolated Harness working directory could not be created. Check the application data directory permissions.",
        profilePrepareFailed: "The Harness profile could not be prepared. Check the application data directory permissions.",
        helperUnavailable: "The desktop credential helper could not start. Reinstall the application.",
        credentialSessionFailed: "An encrypted credential session could not be created for this Harness launch.",
        environmentFailed: "The Harness launch environment could not be prepared. Export diagnostics for details.",
        timeout: "Harness startup timed out. Export diagnostics for details.",
        exited: "The Harness exited before it became ready.",
        processManagementFailed: "The operating system could not establish the Harness process management channel.",
        outputUnavailable: "The Harness output channel is unavailable. Restart the application.",
        processStatusFailed: "The operating system could not read the Harness process status.",
        outputClosed: "The Harness closed its output before it became ready.",
        healthCheckFailed: "The local Harness health check failed.",
        credentialChannelFailed: "The encrypted credential vault channel could not start.",
        taskFailed: "The Harness management task stopped unexpectedly. Retry or export diagnostics.",
        restartLimitReached: "The Harness reached its automatic recovery limit."
      }
    },
    navigation: { label: "Settings navigation", settings: "Settings", closeSettings: "Close settings and return to the workbench", harness: "Harness", diagnostics: "Diagnostics", update: "Updates", about: "About" },
    diagnostics: { eyebrow: "Diagnostics", title: "Harness diagnostics", description: "Export redacted status, version, and log information.", export: "Export diagnostics", exported: "Diagnostics exported", exportLogs: "Export logs", logsExported: "Logs exported", harness: "Harness" },
    settings: { recovered: { corrupt: "The settings file was damaged. The original was backed up and defaults were restored.", future: "The settings file came from a newer version. The original was backed up and defaults were restored." } },
    about: { eyebrow: "Application information", title: `About ${appName}`, desktopVersion: "Desktop version", harnessVersion: "Harness version", nodeVersion: "Node version", channel: "Update channel", author: "Author", repository: "Repository", local: "Local build", community: "Community", stable: "Stable", signed: "Signed release build", unsigned: "Unsigned build" },
    update: { eyebrow: "Release channel", title: "Updates", desktopTitle: "Desktop update", description: "The Desktop shell and Harness update independently while the last working version remains available.", currentVersion: "Current version", channel: "Update channel", status: "Update status", notChecked: "Desktop updates have not been checked.", check: "Check Desktop Updates", disabled: "This community build is unsigned, so automatic Desktop installation is disabled.", current: "This Desktop version is current.", available: "Desktop {version} is available.", ignored: "Desktop {version} is ignored.", skipped: "Desktop updates were already checked today.", notConfigured: "Signed updates are not configured.", promptTitle: "Desktop {version} is available", classificationUnknown: "Release classification unknown", prerelease: "Prerelease", publishedAt: "Published", summary: "Summary", noSummary: "No release summary was provided.", communityNotice: "This community build is unsigned. The official Release page will open so you can review and download the installer.", download: "Open Download", later: "Later", ignoreVersion: "Ignore Version" },
    harnessUpdate: {
      title: "Independent Harness update", currentVersion: "Current Harness", source: "Current source", commit: "Harness commit", status: "Update status", repository: "Harness repository", repositoryPlaceholder: "https://github.com/owner/deepseek-harness.git", repositoryHelp: "Change the repository to switch Harness. The current version stays active if preparation fails.", saveRepository: "Save repository", repositorySaved: "The Harness repository was saved.", mode: "Update behavior", channel: "Harness channel", pin: "Version pin", pinCurrent: "Pin current Harness", check: "Check Harness", download: "Prepare for next launch", restoreBundled: "Restore bundled Harness",
      sources: { bundled: "Bundled with installer", updated: "Independent update" },
      modes: { automatic: "Download automatically, install next launch", notify: "Notify when available", manual: "Manual checks only" },
      channels: { stable: "Stable", preview: "Preview" },
      messages: { repository_timeout: "The Harness repository connection timed out. Check your network or proxy and retry. The current version was not changed.", idle: "Harness updates have not been checked.", not_configured: "A Harness repository is not configured.", checking: "Checking the Harness repository.", available: "Harness {version} is available.", up_to_date: "The current Harness is up to date.", downloading: "Downloading and verifying the Harness.", preparing_repository: "Fetching, building, and verifying Harness from the repository.", applying: "Installing and verifying the new Harness.", restart_to_apply: "Harness {version} is ready and will switch at the next launch.", applied: "The Harness update was installed.", check_failed: "The Harness repository check failed. The current version was not changed.", download_failed: "Harness preparation or verification failed. The current version was not changed.", smoke_failed: "The new Harness failed its startup check. The current version was kept.", pinned: "The current Harness is pinned and will not update automatically.", bundled_restored: "The bundled Harness was restored.", startup_rollback: "The new Harness failed to start and was rolled back automatically." }
    },
    error: { updateLinkOpenFailed: "The link could not be opened. Try again.", unexpected: "The operation failed. Open diagnostics for details.", menuOpenFailed: "The menu could not be opened. Try again.", settingsSaveFailed: "The settings could not be saved. The previous value was restored.", harnessRepositoryFailed: "The Harness repository URL is invalid. Check it and try again.", diagnosticsExportFailed: "Diagnostics could not be exported.", logsExportFailed: "Logs could not be exported.", updateCheckFailed: "The Desktop update check failed.", updateOpenFailed: "The official Desktop Release page could not be opened.", harnessUpdateCheckFailed: "The Harness update check failed. The current version was not changed.", harnessUpdateDownloadFailed: "Harness preparation or verification failed. The current version was not changed.", harnessRestoreFailed: "The bundled Harness could not be restored.", initializationFailed: "The desktop application could not initialize. Restart it or inspect the logs.", eventChannelFailed: "The status event channel could not connect. Refresh the harness status." }
  }
} as const;
