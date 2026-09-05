# 审计修复验收

范围：F01–F24，另列全屏 SIGABRT。原始审计基线为 `b36a7d8`，实施基线为 `3b903df`。测试通过不代表真实平台或发布门禁通过。

| 缺陷 | 场景与修复 | 当前证据 / 状态 |
| --- | --- | --- |
| F01 | JSON / 大小写 Bearer 及带标点查询令牌完整脱敏，重复脱敏不泄漏 | Rust `redaction_removes_entire_credentials_and_is_idempotent` 通过；日志导出复用同一函数 |
| F05 | 损坏或类型错误 profile 保留；仅不存在时初始化，原子写入 | Rust `profile_initialization_preserves_invalid_and_user_owned_content` 通过 |
| F07 | 激活重放遇到 current == pending 不覆盖 previous | Rust `pointer_switch_rolls_back_to_previous_and_then_bundled` 增加中断重放断言，通过；未做真机断电测试 |
| F16 | 已有私钥排他创建，拒绝覆盖 | Node `signing key creation never overwrites an existing private key` 通过 |
| F02–F04、F06、F08–F15、F17–F24 | 依照审计逐项修复 | 未闭环 |
| SIGABRT | 保留崩溃报告，独立分析主线程及视图生命周期 | 未证明根因或修复有效，发布阻塞 |

本地已执行：Rust lib 89 通过 / 1 个显式联网用例忽略；Harness 更新脚本测试 5 通过。该结果仅覆盖当前安全与数据修复，不替代全量 verify、E2E、Harness smoke 或原生安装验收。

Windows x64 原生安装验收、macOS 新包交互、可信签名及最终四平台矩阵均待执行或外部条件未满足。不得发布正式稳定版，保留现有 Release 和 Tag。
