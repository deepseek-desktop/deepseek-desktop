# macOS 视图生命周期排查

## 当前证据

- 2026-09-05 15:36:12，备份后安装的本地 1.0.0 验证包在设置、菜单、关闭取消及全屏交互后发生 OBJC SIGABRT。报告和截图保存在忽略的 `target/audit/`，不删除历史诊断。
- LLDB 在 `_objc_fatal` 捕获消息：无法为处于析构中的对象创建弱引用。对象实际类型为 `TaoView`，仍等于主窗口 `contentView`，父视图为 `NSThemeFrame`，`_isDeallocating` 为真。栈经过 AppKit 约束更新；普通安装运行的栈还经过 WebKit obscured inset 计算。
- 下一次调试在 `tao_view_guard::guarded_dealloc` 捕获同一角色的主视图释放，直接调用方为 `AutoreleasePoolPage::releaseUntil`，继而 `objc_autoreleasePoolPop` 和 CFRunLoop。这是释放位置，不是造成引用计数失衡的来源证据。
- 调试断点会暂停界面。用户反馈卡住后已退出安装实例调试并正常启动；后续不得占用用户实例做断点调试。
- 未修改生产视图释放逻辑，没有添加额外 retain、扩展 swizzle 或把主线程修复认定为 SIGABRT 根因修复。

## 隔离工具

`src-tauri/examples/native-view-lifecycle.rs` 复用现有菜单和输入保护实现，创建独立标识的窗口、三个本地空白子 WebView 及关闭确认，不运行 Harness、不读取应用 profile、凭据或会话。它是调查工具，不是完整应用验收替代品。构建和运行：

```sh
node scripts/with-rust.mjs cargo build --manifest-path src-tauri/Cargo.toml --example native-view-lifecycle --locked
lldb -o 'breakpoint set --name _objc_fatal' -o 'breakpoint set --func-regex tao_view_guard.*guarded_dealloc' -o run -- src-tauri/target/debug/examples/native-view-lifecycle
```

- Cmd+, 打开原生视图菜单；Cmd+W 在两个测试子视图间切换。
- 关闭按钮弹出确认，Cancel 保留窗口，OK 退出；全屏使用原生窗口控件。
- `--without-guard` 仅在本工具中关闭输入保护供后续对照，尚未用该模式得出结论。
- 2026-09-05 已实际完成 5 轮菜单展开/取消、子视图切换、改尺寸、关闭取消、全屏进入/退出，无崩溃；构建及 `cargo clippy --example native-view-lifecycle --locked -- -D warnings` 通过。该结果说明当前最小复现条件不足，不能作为修复有效的证据。

## 剩余边界

继续在隔离实例中定位造成过早释放的具体所有权路径，并取得修改前后可重复证据。正式安装包全屏崩溃仍为发布阻塞。Windows x64 原生验收、可信签名和最终原生矩阵也不能用本工具或宿主机测试替代。
