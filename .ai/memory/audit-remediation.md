# 审计修复验收

范围：F01–F24，另列全屏 SIGABRT。原始审计基线为 `b36a7d8`，实施基线为 `3b903df`。测试通过不代表真实平台或发布门禁通过。

| 缺陷 | 场景与修复 | 当前证据 / 状态 |
| --- | --- | --- |
| F01 | JSON / 大小写 Bearer 及带标点查询令牌完整脱敏，重复脱敏不泄漏 | Rust `redaction_removes_entire_credentials_and_is_idempotent` 通过；日志导出复用同一函数 |
| F05 | 损坏或类型错误 profile 保留；仅不存在时初始化，原子写入 | Rust `profile_initialization_preserves_invalid_and_user_owned_content` 通过 |
| F07 | 激活重放遇到 current == pending 不覆盖 previous | Rust `pointer_switch_rolls_back_to_previous_and_then_bundled` 增加中断重放断言，通过；未做真机断电测试 |
| F16 | 已有私钥排他创建，拒绝覆盖 | Node `signing key creation never overwrites an existing private key` 通过 |
| F06 | AppKit inset 读取派发到主线程并断言；调用前无持锁等待 | macOS 安装包菜单、设置和全屏混合回归通过；另行定位并修复下列所有权缺陷，不把线程修复当成崩溃根因 |
| F13 | 等待整个进程组，重复终止幂等 | Rust `termination_waits_for_the_process_group_after_the_leader_exits` 以真实 Unix 子进程通过 |
| F14 | 同源 popup 导航受管工作台；外链仅系统浏览器，禁止失管 WKWebView | 编译及导航分类器回归通过；原生新窗口交互待测 |
| F15 | 单实例查找实际 Window，解除最小化再显示聚焦 | macOS 安装包最小化后双启动恢复同一 PID、单窗口并聚焦；其他平台未验 |
| F22 | 常驻原生快捷键，保留唯一可见窗口菜单 | macOS 安装包 Cmd+, / Cmd+W 与复制、剪切、粘贴实际通过；Windows/Linux 未验 |
| F02 / F03 | NSIS 外壳允许 x86；实际 deepseek-desktop.exe 必须 x64；规范化注册表安装路径 | 脚本已修复，Windows x64 原生安装验收仍阻塞，不能记为通过 |
| F17 | 校验 annotated Tag / 版本 / HEAD / 构建 commit，矩阵传递 Tag 对象并在发布前重读远端 | Node `release identity rejects lightweight, moved, mismatched and replaced annotated tags` 通过；未改动真实 Tag |
| F18 | 用户字段级 CAS，后端时间戳原子修改，不接受前端快照覆盖 | Rust `user_field_patches_preserve_backend_state_and_reject_stale_revisions` 通过 |
| F19 | 前后端合并在途更新检查，串行结果不倒退 | Rust `concurrent_checks_reuse_the_in_flight_result` 和 App 并发检查回归通过 |
| F20 | 更新弹窗焦点进入、Tab 循环、背景 inert、关闭恢复焦点 | App DOM 与 5 项 E2E 通过；原生设置 800x600 底部按钮可见；原生更新弹窗完整焦点流程未验 |
| F21 | Atom 未明确发行分类时为 unknown，稳定通道拒绝 | Rust `stable_channel_never_accepts_an_unknown_atom_release_classification` 通过 |
| F24 | HTML 有序列表 start 保留有限整数，非法属性不保留 | ReleaseNotes 回归通过 |
| F04 | 候选从当前 Desktop 内置闭包取扩展，记录版本/摘要/入口/依赖并核对复制结果 | Node 闭包旧新版本替换、摘要变化、依赖缺失用例通过；实际 DMG 准备兼容同源码新 commit 候选成功，五个扩展清单完整；激活与恢复待验 |
| F08 / F09 | 单一设置契约、启动路由核对、串行应用、revision 回滚；公开工具 guard 关闭准入并等待已有搜索完成 | 真实 Cordis Settings / Loader / ToolRuntime 并发回归通过；真实 Harness 服务与浏览器 smoke 验证保存、重启、独立服务、禁用、默认及激活状态；安装包 GUI 搜索选择链路仍未完整验收 |
| F10 / F11 / F23 | 头部与流读取共用预算，2 MiB 累计截断取消，MCP SDK 接入 JSON/SSE | 40 项后端回归通过，含 MCP SSE 超限立即退出及多会话隔离；真实 DeepSeek / Alibaba MaaS Responses 请求成功并返回结构化网页来源，非 GUI 对话验收 |
| F12 | 凭据写入失败成功回滚后更新表单 revision，保留草稿；冲突不重写 | 执行实际装配后的 createOnce 函数，成功回滚后重试与回滚冲突两个场景通过 |
| SIGABRT | contentView 查询采用显式成对的局部引用，不泄漏、不修改 dealloc | 修改前两次独立启动查询失衡、隔离完整应用硬件监视定位过度释放；修改后 32 次查询平衡，实际 DMG 三次冷启动、20 轮混合操作与同一 PID 超过 30 分钟观察通过，见 [生命周期证据](macos-lifecycle.md) |

安全、原生生命周期、设置和发布门禁三簇已提交本地，未推送。2026-09-05 搜索与装配改动通过完整 `desktop:package`：Node 105、Vue 32、搜索 40、Rust 93（1 个显式联网用例忽略）、E2E 5 项通过，另完成真实 Harness smoke、`app:sync --check`、`harness:sync --check`、`release:smoke`。本机默认版本 1.0.0 是验证包，不是已发布版本；不能替代目标平台验收。

真实供应商验证使用授权凭据经标准输入临时传入，不持久化或记录密钥。DeepSeek `deepseek-v4-pro` 与 Alibaba MaaS `qwen3.8-max` 各执行一次 Node.js 官方文档查询，均收到 HTTP 200 与结构化来源 `https://nodejs.org/en/docs/` / `https://nodejs.org/docs/latest/api/`。其他协议仍以隔离模拟响应回归为证据。

早期修复前 DMG 已备份后安装至 /Applications；工作台可见、五组原生菜单展开、编辑快捷键、关闭确认取消、最小化唤回与小窗口设置滚动通过。设置文件及工作区数据与备份一致，但本机该 profile 没有可供验收的已有会话，不声称会话保持已真实验收。该包 15:36:12 全屏过程中崩溃，故当时 macOS 整体验收失败；调试结束后恢复正常启动。后续修复包结果见上表与生命周期记录，原始证据保存在忽略的 `target/audit/`。

Claude 交接补丁中的扫描器诊断已承接；另外复现并修复清理器遗漏 UTF-16LE、扫描器却会检查该编码的差异。合成 PE 回归验证路径被移除且字节偏移保持不变；尚无证据证明这就是远程 Windows `.node` 失败的唯一根因。未采用未经验证的链接器参数，也没有移动历史 Tag。

当前 contentView 所有权缺陷已按独立对照和真实 DMG 闭环。安装包搜索选择 GUI 已实际验证独立服务、禁用及恢复默认保存生效，但无工作区时添加入口未展开，需继续排查，不能宣称 GUI 对话验收通过。候选检查也发现合法附加 ref 被误拒绝，需要修复。Windows x64 原生安装与最终矩阵未执行，暂不发布。用户最新授权为 1.1.0 社区预发布、未签名且非 Latest；不得冒充 stable，保留现有 Release 和 Tag。
