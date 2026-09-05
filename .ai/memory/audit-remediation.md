# 审计修复验收

范围：F01–F24，另列全屏 SIGABRT。原始审计基线为 `b36a7d8`，实施基线为 `3b903df`。测试通过不代表真实平台或发布门禁通过。

| 缺陷 | 场景与修复 | 当前证据 / 状态 |
| --- | --- | --- |
| F01 | JSON / 大小写 Bearer 及带标点查询令牌完整脱敏，重复脱敏不泄漏 | Rust `redaction_removes_entire_credentials_and_is_idempotent` 通过；日志导出复用同一函数 |
| F05 | 损坏或类型错误 profile 保留；仅不存在时初始化，原子写入 | Rust `profile_initialization_preserves_invalid_and_user_owned_content` 通过 |
| F07 | 激活重放遇到 current == pending 不覆盖 previous | Rust `pointer_switch_rolls_back_to_previous_and_then_bundled` 增加中断重放断言，通过；未做真机断电测试 |
| F16 | 已有私钥排他创建，拒绝覆盖 | Node `signing key creation never overwrites an existing private key` 通过 |
| F06 | AppKit inset 读取派发到主线程并断言；调用前无持锁等待 | macOS 编译 / Rust lib 通过；真实窗口交互待测，不能归因 SIGABRT |
| F13 | 等待整个进程组，重复终止幂等 | Rust `termination_waits_for_the_process_group_after_the_leader_exits` 以真实 Unix 子进程通过 |
| F14 | 同源 popup 导航受管工作台；外链仅系统浏览器，禁止失管 WKWebView | 编译及导航分类器回归通过；原生新窗口交互待测 |
| F15 | 单实例查找实际 Window，解除最小化再显示聚焦 | macOS 编译通过；双启动真实交互待测 |
| F22 | 常驻原生快捷键，保留唯一可见窗口菜单 | macOS 编译通过；macOS/Windows/Linux 原生快捷键待测 |
| F02 / F03 | NSIS 外壳允许 x86；实际 deepseek-desktop.exe 必须 x64；规范化注册表安装路径 | 脚本已修复，Windows x64 原生安装验收仍阻塞，不能记为通过 |
| F17 | 校验 annotated Tag / 版本 / HEAD / 构建 commit，矩阵传递 Tag 对象并在发布前重读远端 | Node `release identity rejects lightweight, moved, mismatched and replaced annotated tags` 通过；未改动真实 Tag |
| F18 | 用户字段级 CAS，后端时间戳原子修改，不接受前端快照覆盖 | Rust `user_field_patches_preserve_backend_state_and_reject_stale_revisions` 通过 |
| F19 | 前后端合并在途更新检查，串行结果不倒退 | Rust `concurrent_checks_reuse_the_in_flight_result` 和 App 并发检查回归通过 |
| F20 | 更新弹窗焦点进入、Tab 循环、背景 inert、关闭恢复焦点 | App DOM 回归通过；真实 WebView 和小窗口 E2E 待测 |
| F21 | Atom 未明确发行分类时为 unknown，稳定通道拒绝 | Rust `stable_channel_never_accepts_an_unknown_atom_release_classification` 通过 |
| F24 | HTML 有序列表 start 保留有限整数，非法属性不保留 | ReleaseNotes 回归通过 |
| F04、F08–F12、F23 | 依照审计逐项修复 | 未闭环 |
| SIGABRT | 保留崩溃报告，独立分析主线程及视图生命周期 | 未证明根因或修复有效，发布阻塞 |

本地已执行：Rust lib 89 通过 / 1 个显式联网用例忽略；Harness 更新脚本测试 5 通过。该结果仅覆盖当前安全与数据修复，不替代全量 verify、E2E、Harness smoke 或原生安装验收。

Windows x64 原生安装验收、macOS 新包交互、可信签名及最终四平台矩阵均待执行或外部条件未满足。不得发布正式稳定版，保留现有 Release 和 Tag。
