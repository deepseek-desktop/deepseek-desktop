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
| F14 | 同源 popup 导航受管工作台；外链仅系统浏览器，禁止失管 WKWebView | 原生 Markdown 外链打开系统 Chrome，Desktop 保持单窗口；最新 WebKit 修复包再次点击当前受管 Origin 的 Markdown 链接后仍为原单窗口、同一 Desktop/Harness 进程，完整历史与当前模型保留，无白屏 |
| F15 | 单实例查找实际 Window，解除最小化再显示聚焦 | macOS 安装包最小化后双启动恢复同一 PID、单窗口并聚焦；其他平台未验 |
| F22 | 常驻原生快捷键，保留唯一可见窗口菜单 | 1.1.0 实际 DMG 聊天输入框 Cmd+A/C/X/V 及 Cmd+, / Cmd+W 通过；实际鼠标定位、每次新取 AX 引用，草稿和原剪贴板各类型数据恢复一致；Windows/Linux 未验 |
| F02 / F03 | NSIS 外壳允许 x86；实际 deepseek-desktop.exe 必须 x64；规范化注册表安装路径 | 脚本已修复，Windows x64 原生安装验收仍阻塞，不能记为通过 |
| F17 | 校验 annotated Tag / 版本 / HEAD / 构建 commit，矩阵传递 Tag 对象并在发布前重读远端 | Node `release identity rejects lightweight, moved, mismatched and replaced annotated tags` 通过；未改动真实 Tag |
| F18 | 用户字段级 CAS，后端时间戳原子修改，不接受前端快照覆盖 | Rust `user_field_patches_preserve_backend_state_and_reject_stale_revisions` 通过 |
| F19 | 前后端合并在途更新检查，串行结果不倒退 | Rust `concurrent_checks_reuse_the_in_flight_result` 和 App 并发检查回归通过 |
| F20 | 更新弹窗焦点进入、Tab 循环、背景 inert、关闭恢复焦点 | DOM/E2E 与原生 800x600 滚动通过；真实更新弹窗验证 20 次 Tab、12 次反向 Tab、背景 inert、Esc 后焦点返回检查更新按钮 |
| F21 | Atom 未明确发行分类时为 unknown，稳定通道拒绝 | Rust `stable_channel_never_accepts_an_unknown_atom_release_classification` 通过 |
| F24 | HTML 有序列表 start 保留有限整数，非法属性不保留 | ReleaseNotes 回归通过 |
| F04 | 候选从当前 Desktop 内置闭包取扩展，记录版本/摘要/入口/依赖并核对复制结果 | Node 闭包旧新版本、摘要和缺失依赖回归通过；实际 DMG 准备并激活同源码新 commit 候选，五扩展完整；无效候选失败保持当前版本，恢复内置后会话与搜索选择仍在。仅兼容 fixture，不宣称升级到更新的上游功能版本 |
| F08 / F09 | 单一设置契约、启动路由核对、串行应用、revision 回滚；公开工具 guard 关闭准入并等待已有搜索完成 | Cordis Settings / Loader / ToolRuntime 并发回归及真实 Harness 浏览器 smoke 通过；macOS GUI 跟随、独立服务、禁用、恢复默认实际执行生效；禁用后 web_fetch 仍返回 HTTP 200 |
| F10 / F11 / F23 | 头部与流读取共用预算，2 MiB 累计截断取消，MCP SDK 接入 JSON/SSE | 40 项后端回归通过，含 MCP SSE 超限与多会话隔离；真实 DeepSeek / Alibaba MaaS 后端及 macOS GUI 有结构化来源。最新安装包 Max / Flash 两会话搜索实际重叠 8067 毫秒，各返回 8 条来源，模型分别正确且正常完成；同端点同凭据实测不替代不同端点/密钥的并发隔离回归 |
| F12 | 凭据写入失败成功回滚后更新表单 revision，保留草稿；冲突不重写 | 执行实际装配后的 createOnce 函数，成功回滚后重试与回滚冲突两个场景通过 |
| SIGABRT | contentView 查询采用显式成对的局部引用，不泄漏、不修改 dealloc | 修改前两次独立启动查询失衡、隔离完整应用硬件监视定位过度释放；修改后 32 次查询平衡，实际 DMG 三次冷启动、20 轮混合操作与同一 PID 超过 30 分钟观察通过，见 [生命周期证据](macos-lifecycle.md) |

安全、原生生命周期、设置和发布门禁三簇已提交本地，未推送。2026-09-05 搜索与装配改动通过完整 `desktop:package`：Node 105、Vue 32、搜索 40、Rust 93（1 个显式联网用例忽略）、E2E 5 项通过，另完成真实 Harness smoke、`app:sync --check`、`harness:sync --check`、`release:smoke`。本机默认版本 1.0.0 是验证包，不是已发布版本；不能替代目标平台验收。

真实供应商验证使用授权凭据经标准输入临时传入，不持久化或记录密钥。DeepSeek `deepseek-v4-pro` 与 Alibaba MaaS `qwen3.8-max` 各执行一次 Node.js 官方文档查询，均收到 HTTP 200 与结构化来源 `https://nodejs.org/en/docs/` / `https://nodejs.org/docs/latest/api/`。其他协议仍以隔离模拟响应回归为证据。

早期修复前 DMG 已备份后安装至 /Applications；工作台可见、五组原生菜单展开、编辑快捷键、关闭确认取消、最小化唤回与小窗口设置滚动通过。设置文件及工作区数据与备份一致，但本机该 profile 没有可供验收的已有会话，不声称会话保持已真实验收。该包 15:36:12 全屏过程中崩溃，故当时 macOS 整体验收失败；调试结束后恢复正常启动。后续修复包结果见上表与生命周期记录，原始证据保存在忽略的 `target/audit/`。

Claude 交接补丁中的扫描器诊断已承接；另外复现并修复清理器遗漏 UTF-16LE、扫描器却会检查该编码的差异。合成 PE 回归验证路径被移除且字节偏移保持不变；尚无证据证明这就是远程 Windows `.node` 失败的唯一根因。未采用未经验证的链接器参数，也没有移动历史 Tag。

当前 contentView 所有权缺陷已按独立对照和真实 DMG 闭环。目录选择器早期未展开的判断已被原生独立进程证据纠正，实际选择成功，无需产品修复；合法附加 Git ref 误拒绝已修复并通过真实仓库回归。测试会话实际完成搜索、读取 fixture 文件和写入 PASS，原始会话记录完整。

另发现锁定 Harness 的 util-values 按 V8 排版校验内置构造函数，WebKit 会拒绝合法 JSON 消息并中断历史回放。相同测试会话修改前 Chromium 完整、WebKit 报 lossless JSON 错误；统一装配修复后两引擎均完整显示 39 行且 reload 保留最新回复，无错误。见 [ADR-020](../decisions/adr-020-webkit-json-intrinsics.md)。新 DMG 最终功能复验与 Windows x64 原生矩阵仍未完成，暂不发布。用户授权为 1.1.0 社区预发布、未签名且非 Latest；不得冒充 stable，保留现有 Release 和 Tag。

最新 WebKit 修复包完整 `desktop:package` 通过：Node 106、Vue 32、搜索 40、Rust 94（1 个显式联网用例忽略）、E2E 7（含实际装配产物的 Chromium / WebKit JSON 校验）及真实 Harness smoke。另行 `app:sync --check`、`harness:sync --check`、`release:smoke` 通过。DMG SHA256 为 `8c2d29cbb0dd6f44cabe8e6f0021d1c4e6bd1515e7212b5bd0b9a24ae47ca112`，备份后实际安装，正常启动恢复测试会话全部历史和最新链接；两轮菜单、全屏、设置、关闭取消、最小化恢复通过。

DeepSeek GUI 并发验收的失败证据仍保留：首轮请求实际未重叠，随后两会话相隔 0.91 秒提交均返回 HTTP 402 `Insufficient Balance`。用户另行提供并授权 Alibaba MaaS 凭据后，原生 GUI 通过标准模型表单添加 `aliyun-maas`、获取可用模型并保存，仅选择 `qwen3.8-max` / `qwen3.8-flash`，不新增搜索协议或重复密钥。搜索自动匹配 Responses web search 协议；Max 单次 GUI 搜索及两个模型并发均有结构化来源。

并发实测基于上述 SHA256 的同一 DMG：Max 工具调用区间为 `1788610936874` 至 `1788610981262`，Flash 为 `1788610934953` 至 `1788610944941`（Unix 毫秒），实际重叠 `8067` 毫秒；两会话各有 8 条 `meta.sources`、工具 `isError=false`，结束状态均为 `completed`。证据在忽略目录的 `aliyun-concurrent-A.jsonl`、`aliyun-concurrent-B.jsonl` 与 `aliyun-concurrent-proof.json`，不包含密钥。该次实测为同一提供方、同一凭据的不同模型，不宣称已实测不同端点/密钥并发。

随后通过聊天生成当前受管 Origin 的 Markdown 链接并原生点击，最新回复和历史完整恢复，所选 Max 模型保留、原 Desktop/Harness PID 不变、窗口数仍为 1；最终包同源导航复验通过。Windows x64 原生门禁仍未运行，聊天输入框剪贴板复验未闭环，不推送发行 Tag、不创建 Release。

新包输入框剪贴板复测保留失败状态：前两次 Cmd+C 的实际剪贴板文本正确，但持有的 AXTextArea 一直返回旧草稿值；第三次改用剪贴板读回后，焦点和草稿恢复断言未通过。连续三次失败后已停止重复操作；仅涉及隔离测试会话草稿，系统原剪贴板在 finally 恢复，未改动其他会话文件。该结果不足以证明编辑快捷键的产品根因，也不能作为通过证据。

## 1.1.0 本地最终验收

- DMG SHA256：`4f4f4bd0d290013bca121c9339ea35f4c39a28e93be378217e79a0847a9fbafd`；主程序 SHA256：`e162205f8c986faf6f90b5ecaa04cfd2079880996a6224984a58ed841ccba1f3`。备份应用及数据后从实际 DMG 安装，以 LaunchServices 正常启动，标题为 1.1.0，严格 ad-hoc 完整性验证通过，非 Developer ID 签名。
- 物理鼠标定位输入框并每次重新取 AXTextArea，实际 Cmd+A/C/X/V、草稿恢复通过。JXA 的 pasteboardItems.count 返回字符串，测试断言改用 Number 后逐类型 NSData 恢复校验也通过；没有为自动化修改产品源码。证据为 `release-1.1.0-clipboard.json`。
- 两轮五菜单、全屏、设置、关闭取消、最小化恢复通过；退出首个实例后 Desktop/Node 均清理。历史 SIGABRT 原因对照、三次冷启动、20 轮及 30 分钟观察仍见生命周期记录；本次未发现新增相关崩溃。
- GUI 准备/激活兼容 fixture `11cb06c7bf34`，五个 Desktop 扩展在安装包和候选中的摘要逐项一致。候选搜索设置初始跟随模型，禁用及恢复均保存并显示已生效。不兼容 fixture 明确失败，current 未变、无 pending；恢复内置并重新启动后正常。已通过原界面恢复默认官方仓库，未清空数据。
- 恢复后的 1.1.0 GUI 以 `aliyun-maas/qwen3.8-max` 完成一次真实 web_search，工具 seq 185 返回 8 条 `meta.sources`、isError=false，turn 14 正常完成；同源 Markdown 链接点击后原窗口历史保留。证据在 `release-1.1.0-search.jsonl` 与最终 AX 记录，密钥未写入证据。
- `desktop:package`、`app:sync --check`、`harness:sync --check`、`release:smoke` 通过；最后的 Windows 脚本修改后重跑 `verify` 和 25 项发行协议回归。总量仍为 Node 106、Vue 32、搜索 40、Rust 94 加 1 项显式联网 ignore，七项 E2E 与真实 Harness smoke；不以这些总数替代上面的缺陷场景。
- Windows 菜单具有 `aria-haspopup=menu`，Chromium 的 [UIA pattern 映射](https://github.com/chromium/chromium/blob/81600c6b4533260c0fae1099e82d5327656d81f0/ui/accessibility/platform/ax_platform_node_win.cc#L8714-L8738) 对该菜单提供 ExpandCollapse 而非 Invoke。验收 helper 优先展开，仅在无展开 pattern 时调用 Invoke；后续设置菜单/关闭确认/清理/卸载断言不变。这是源码与脚本回归证据，Windows x64 真正通过须以新 Tag 官方矩阵为准。
