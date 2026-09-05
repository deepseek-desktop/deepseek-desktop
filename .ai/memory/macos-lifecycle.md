# macOS 视图生命周期排查

## 当前证据

- 2026-09-05 15:36:12，备份后安装的本地 1.0.0 验证包在设置、菜单、关闭取消及全屏交互后发生 OBJC SIGABRT。报告和截图保存在忽略的 `target/audit/`，不删除历史诊断。
- LLDB 在 `_objc_fatal` 捕获消息：无法为处于析构中的对象创建弱引用。对象实际类型为 `TaoView`，仍等于主窗口 `contentView`，父视图为 `NSThemeFrame`，`_isDeallocating` 为真。栈经过 AppKit 约束更新；普通安装运行的栈还经过 WebKit obscured inset 计算。
- 下一次调试在 `tao_view_guard::guarded_dealloc` 捕获同一角色的主视图释放，直接调用方为 `AutoreleasePoolPage::releaseUntil`，继而 `objc_autoreleasePoolPop` 和 CFRunLoop。这是释放位置，不是造成引用计数失衡的来源证据。
- 调试断点会暂停界面。用户反馈卡住后已退出安装实例调试并正常启动；后续不得占用用户实例做断点调试。
- 隔离完整应用的硬件写监视进一步定位到 `native_menu::content_top_inset`：每次查询后根视图减少一个引用，最终直接在该函数返回时进入 `guarded_dealloc`，此时仍挂载在窗口。该证据把释放来源从自动释放池收窄到 Desktop 的具体查询路径。
- 同配置 release probe 两次独立启动均在第一次查询得到 `18 -> 17`；早期断言跨 Cocoa 回调导致的两份 probe SIGABRT 是测试失败输出，不应混入正常应用 OBJC 崩溃统计。probe 已改为错误退出码，不再通过 panic 生成崩溃报告。
- 生产查询改用 +0 指针和成对的局部 `Retained::retain` / Drop。两次独立启动及不安装输入 guard 的对照，32 次查询均为 `18 -> 18`；没有永久持有引用、修改 dealloc 或扩大 swizzle。接口依据与范围见 [ADR-019](../decisions/adr-019-appkit-content-view-ownership.md)。

## 隔离工具

`src-tauri/examples/native-view-lifecycle.rs` 复用现有菜单和输入保护实现，创建独立标识的窗口、三个本地空白子 WebView 及关闭确认，不运行 Harness、不读取应用 profile、凭据或会话。它是调查工具，不是完整应用验收替代品。构建和运行：

```sh
node scripts/with-rust.mjs cargo build --manifest-path src-tauri/Cargo.toml --example native-view-lifecycle --locked
lldb -o 'breakpoint set --name _objc_fatal' -o 'breakpoint set --func-regex tao_view_guard.*guarded_dealloc' -o run -- src-tauri/target/debug/examples/native-view-lifecycle
```

- Cmd+, 打开原生视图菜单；Cmd+W 在两个测试子视图间切换。
- 关闭按钮弹出确认，Cancel 保留窗口，OK 退出；全屏使用原生窗口控件。
- `--without-guard` 仅在本工具中关闭输入保护；修复后结合 `--check-ownership` 已验证查询引用计数平衡，不代表生产环境可以移除输入保护。
- 2026-09-05 已实际完成 5 轮菜单展开/取消、子视图切换、改尺寸、关闭取消、全屏进入/退出，无崩溃；构建及 `cargo clippy --example native-view-lifecycle --locked -- -D warnings` 通过。该结果说明当前最小复现条件不足，不能作为修复有效的证据。

## 修复回归

```sh
node scripts/with-rust.mjs cargo build --manifest-path src-tauri/Cargo.toml --release --example native-view-lifecycle --locked
src-tauri/target/release/examples/native-view-lifecycle --check-ownership
src-tauri/target/release/examples/native-view-lifecycle --check-ownership --without-guard
```

- 隔离完整应用正常启动后完成 20 轮混合操作，包含 100 次五组原生子菜单展开，以及 20 次全屏进出、设置/工作台切换、关闭取消、最小化恢复。该实例结束后转入真实安装包验证，不将两段运行时间拼接成连续观察。
- `desktop:package` 全链通过，真实 DMG 已校验并在新备份后安装；安装包 SHA256 为 `531066b9742cd336d857e7b50084f700d2044728cd62e1570b3707c5a5265d6e`，应用二进制 SHA256 为 `610df995d64e5dd3d98d562c043c22100fed4c9c18fd79fc5d34e56f4434517e`。本地版本为 1.0.0，不是已发布的 1.1.0。
- 两次正常冷启动各完成混合交互并确认退出后无安装包及 Harness 子进程残留；第三次冷启动在 2026-09-05 17:35:45 开始，随后完成 20 轮混合交互。18:06:41 同一 PID 已连续运行 30 分 56 秒，其间还实际保存搜索设置、准备候选；没有新增正常应用崩溃报告。零崩溃仅为运行观察，根因证明仍是上述失衡路径的修改前后对照。
- 日志、截图、逐轮 JSON 和硬件监视证据保存在忽略的 `target/audit/`，不提交用户数据或原始诊断。

## 剩余边界

本机已知 contentView 过度释放缺陷闭环；继续完成安装包功能和候选更新验收，不把生命周期通过当作整体发布通过。Windows x64 原生验收仍需新 Tag 的官方矩阵通过。用户最新授权为 1.1.0 社区预发布、明确未签名且不占 Latest；可信发布者签名仍是正式 stable 的条件，不因本次社区授权放宽。
