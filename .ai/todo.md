# 活跃待办

## 独立搜索扩展的外部验收

- 独立 host/client、公共插槽、官方插件共存、独立 Provider 选择、关闭/恢复和候选装配已实现；不再强制禁用官方搜索。内置 Harness `0.1.3-alpha.1` 的本地完整验证、真实 Harness 服务/浏览器设置 smoke、macOS ARM64 正式包构建和 `/Applications` 安装交互已通过；当前功能簇未使用用户凭据执行新的外部供应商搜索，详细证据见验证基线。
- Harness `0.1.3-alpha.1` 的模型设置与用户确认补丁已完成上游适配，权限预设三项中文文案由锁定源码和生产闭包校验。生产路径清理会保持二进制长度并重新签名修改后的 Mach-O，真实 Harness smoke 已覆盖 `fs-ext` 加载。
- 当前可访问的本地 Windows 节点为 Windows 11 ARM64，不能冒充目标 Windows x64 原生环境。Tag 矩阵新增 Windows x64 NSIS 安装、启动、工作台与设置交互、关闭确认、Harness 清理和卸载门禁；该原生门禁通过前不得创建 Release。

## 未闭环缺陷：全屏切换 SIGABRT

- 已捕获三份栈完全一致的崩溃报告，均为 AppKit 约束遍历中 `objc_initWeak` 对正在析构的视图建立弱引用而 abort；v1.0.33 同样存在，非新引入。
- **没有稳定复现。** 18 次脚本试验（快速改尺寸后点全屏 11 次、全屏动画期插入操作 4 次、混合设置层开关与菜单弹出 3 次）全部存活，先前据前后顺序推断的触发条件已被证伪。
- 已验证无效并回滚的方向：把 `Resized` / `ScaleFactorChanged` 回调中的 `sync_surface_layout` 经 `run_on_main_thread` 延后并合并，崩溃栈逐帧不变。
- v1.0.34 起加入界面层面包屑（设置/工作台切换、`desktop-menu` 子 WebView 创建、限流的重排与窗口尺寸），写入 `desktop.log` 并随诊断导出。正常运行期 `creating desktop-menu webview` 只出现一次，实测已确认；若崩溃前反复出现即锁定视图树扰动源。
- 在拿到稳定复现或一份带面包屑的真实崩溃之前不要改这块代码：修复无法验证，而过宽的 `tao_view_guard` swizzle 历史上正是以同一条 `objc_initWeak` 栈制造过新崩溃。

## 发布外部条件

- macOS Apple Developer ID 签名与公证尚未接入；具备证书后再启用 stable 发布门禁。
- Windows Authenticode 可信发布者签名尚未接入。
- 桌面安装包自动更新保持关闭，直到安装包签名、Updater 签名材料和真实升级回滚验证全部闭环。
- Harness 仓库切换与可选签名制品协议已实现；仍需在受信任 macOS x64、Windows x64 和 Linux x64 真机分别完成仓库拉取、依赖准备、构建、中断、切换和回滚演练。预构建签名制品通道启用时，另需复测制品生成、下载与验签。

## 平台验证

四平台矩阵每次发布都在各自原生 Runner 上执行 `package:community`，因此以下已是自动覆盖，不需要重复人工确认：

- `verify` 全链（含 Rust 单元测试）在 macOS ARM64/x64、Windows x64、Linux x64 各跑一次；诊断脱敏的 `USERPROFILE` 与 `HOMEDRIVE` + `HOMEPATH` 解析由注入环境的用例覆盖，四个平台都会执行。
- `test:e2e` 与 `harness:smoke`（真实 Harness 启动 + 父进程消亡清理）在四个平台各跑一次。
- 交付闭包扫描拒绝 `.env`、密钥、本机绝对路径和符号链接逃逸，四个平台各扫一次。
- Windows x64 还会安装实际 NSIS 包，验证 x64 PE、工作台和设置菜单、关闭确认、Harness 子进程退出及静默卸载；任一步失败都会阻止汇总发布。

仍然只能由目标平台人工完成、当前尚未做的：

- Linux x64 的窗口内菜单与同窗设置层人工验收：顶部左侧唯一显示“文件 / 编辑 / 视图 / 窗口 / 帮助”，原生弹出项、最大化/最小化、长表单滚动和关闭后会话保持均可用。Windows x64 的发布必需路径由原生安装交互门禁覆盖，非发布路径的完整五组菜单与高 DPI 仍可继续扩展。
- Linux x64 的**正式安装包**人工启动验收：安装、原生窗口标题、Harness sidecar 自动拉起、工作台同窗口加载、退出无残留。Windows x64 正式安装包在每次 Tag 矩阵中执行对应自动验收。
- Linux x64 的凭据库、插件市场和对话链路验收。
- 未签名制品在 Gatekeeper 与 SmartScreen 下的实际拦截表现。

Desktop 社区版版本提醒已具备安全检查协议；Windows x64 原生硬件与 Linux 环境仍需确认系统浏览器打开官方 Release 页面及网络失败提示。新发现的问题应先用源码和可复现证据确认，再加入本文件。
