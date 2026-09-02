# ADR-011：工作台主界面、同窗设置与窗口内唯一菜单

## 状态

已采用，取代 ADR-010。

## 决策

DeepSeek Desktop 启动后直接进入 Harness 工作台。运行状态、诊断、Desktop 更新、Runtime 更新和关于不再组成需要切换的“桌面管理”页面，而是在同一原生窗口中按需显示为设置层；关闭设置时恢复原工作台子 WebView，不重新导航、不停止 Runtime，也不丢失会话和工作区状态。Runtime 启动失败时设置层承担重试、恢复和诊断入口。

唯一完整功能菜单固定在应用窗口内容区顶部左侧，信息架构为“文件 / 编辑 / 视图 / 窗口 / 帮助”。菜单标题由 Desktop Shell 的 Vue WebView 三语渲染，点击或键盘操作后由 Rust 在受约束的标题坐标弹出 Tauri 原生菜单项；Runtime 子 WebView 从固定菜单栏下方开始，不注入菜单脚本，也不获得 Tauri IPC 权限。macOS 系统栏只保留服务、隐藏和退出等最小应用菜单，Windows/Linux 不挂载第二套完整原生窗口菜单。

Desktop 外壳版本检查与 Runtime 更新保持两条信任链。未签名社区版每天最多检查一次构建时固定的官方 GitHub 仓库 Release 列表，也允许手动检查；筛选依据是完整 SemVer、发布时间、draft/prerelease 状态和五个平台公开安装包完整性，不使用 `latest`。提醒只允许打开由固定仓库与已验证 tag 构造的官方 Release 页面，不使用远端返回的下载地址，也不自动安装未签名制品。

版本检查优先读取 GitHub Release API；匿名 API 被限流或暂时不可用时，回退到同一构建时固定仓库的 Atom Release Feed。Feed 使用 `quick-xml` 结构化解析，条目、tag 与制品链接必须逐项匹配固定的 `github.com/<owner>/<repo>` 路径，禁止重定向、跨仓库资源和路径逃逸。该回退只提供版本提醒，不改变未签名社区版不能自动安装的安全边界。

## 理由

- 普通用户启动后立即得到完整工作台，不需要理解桌面壳与 Runtime 的内部边界。
- 隐藏并复用工作台 WebView 可以原样保留对话、工作区、滚动与表单状态。
- 固定窗口位置消除了平台间菜单位置差异，原生弹出项仍保留各系统的编辑、窗口和键盘语义。
- Shell 与 Runtime 使用两个明确的矩形区域，不需要向 Runtime 注入菜单或安全桥接代码。
- Desktop 与 Runtime 更新明确分离，社区版可以安全提醒新版本而不降低安装包签名门禁。

## 约束

- 设置长表单必须在小窗口中完整滚动；`Esc` 和关闭按钮返回原工作台。
- 菜单文案和设置层文案必须同步维护 `zh-CN`、`zh-TW`、`en-US`。
- 专用菜单 WebView 启动时读取已保存语言，并通过只携带 locale 的受限 Shell 事件实时跟随设置切换。
- 菜单高度使用逻辑像素定义，Runtime 子 WebView 在每次缩放和窗口尺寸变化后按实际 scale factor 重新计算物理边界。
- macOS 原生菜单弹出期间必须由 Rust 进程级门闩拒绝重复请求，避免多个 WebView 或辅助功能重复触发 AppKit 菜单循环；Vue 调用层同时抑制尚未完成的重复 IPC。
- macOS 使用系统当前光标位置弹出菜单；Windows/Linux 使用窗口内逻辑坐标定位。macOS 26 可能在锁定的 Tao `0.35.3` 已从 `TaoView` 移除 `taoState` 后继续向该视图投递输入事件，而 Tao 的事件处理器会立即把空状态当作有效 `ViewState` 读取并在 `objc_loadWeakRetained` 崩溃。Desktop 初始化时必须为纯事件投递处理器安装窄范围保护：状态缺失时丢弃事件，状态存在时原样调用 Tao 实现；不得拦截 `viewDidMoveToWindow`、`resetCursorRects`、`frameDidChange:` 等生命周期、布局和 tracking rect 回调。类、方法或实现契约不存在时安全拒绝启动，不静默降级。
- Desktop Release 请求禁止重定向、凭据和超大响应；候选不完整或版本无效时不得提醒。
- Atom 回退只能读取官方仓库、合法 SemVer tag 与该 tag 下的完整制品集合；解析失败必须安全失败。
- Windows 与 Linux 的窗口内菜单、原生弹出项、窗口关闭和设置层视觉仍需对应系统真机验收。
