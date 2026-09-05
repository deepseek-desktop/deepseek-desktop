# ADR-019：显式平衡 AppKit contentView 引用

## 背景

macOS 26.6.2 ARM64 的正常安装包在全屏、菜单和设置重排后发生 OBJC SIGABRT。隔离完整应用的硬件写监视确认：`content_top_inset` 返回时释放了仍挂载在窗口上的根 TaoView；每次查询永久减少一个引用，最终 AppKit 为析构中的视图创建弱引用而退出。

相同优化配置的独立 probe 在两次冷启动中均复现 `18 -> 17`。分步调用窗口句柄、contentView 和 frame 本身可保持平衡，但现有组合调用不平衡。锁定的 objc2 0.6.4 / objc2-app-kit 0.3.2 生成 getter 使用优化 autorelease-return 交接；确切编译器与系统实现的交互不推广为全部 getter 的普遍缺陷。

## 决策

- 仅对 Desktop 的两处 contentView 查询使用一个内部 helper：通过公开 Objective-C `contentView` 获取 +0 指针，再通过 `Retained::retain` 创建有明确 Drop 的局部拥有引用。
- 窗口仍拥有根视图，函数不改变视图树、根视图所有者、dealloc 或事件处理，不增加永久 retain 或扩大 swizzle。
- 延用现有主线程派发与检查；菜单仍使用原有窗口内入口及屏幕坐标弹出，不移动菜单、不禁用全屏。
- 不新增依赖、公开 IPC、配置项或数据迁移；继续锁定现有依赖版本。

Apple 的 [contentView 所有权约定](https://developer.apple.com/documentation/appkit/nswindow/contentview?language=objc) 与 objc2 的 [Retained 实现](https://docs.rs/objc2/0.6.4/src/objc2/rc/retained.rs.html) 是接口依据；实际缺陷与修复结果以本机对照证据为准。

## 验证与边界

`native-view-lifecycle --check-ownership` 在优化构建中执行 32 次真实 AppKit 查询，逐次比较自动释放池清理前后的引用计数。增加或减少均失败，避免用泄漏通过测试；失败正常返回非零，不跨 Cocoa 回调 unwind。关闭现有输入 guard 的对照也保持平衡。

完整应用、真实 DMG、冷启动、混合窗口操作和运行观察分别记录在 [生命周期验收](../memory/macos-lifecycle.md)。最小 probe 和测试断言导致的 SIGABRT 不等于原始 OBJC 崩溃复现，也不能替代安装包验收。其他平台仍须原生矩阵检查。
