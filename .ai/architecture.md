# 架构地图

## 构建链路

```text
环境变量 / .env / 内置默认值
  -> scripts/lib/build-config.mjs
  -> scripts/app-sync.mjs
  -> target/generated/app-config.json
  -> target/generated/tauri.conf.json
  -> Vue / Rust / Tauri 构建

RUNTIME_REPOSITORY / RUNTIME_REF
  -> scripts/runtime-sync.mjs
  -> 解析不可变 commit
  -> 构建 Harness 生产闭包
  -> 应用 runtime/patches
  -> target/generated/runtime-lock.json
  -> runtime/scripts/stage-runtime.mjs
  -> Tauri sidecar / resources
```

`target/` 是生成与缓存目录，不是源码事实。稳定工具链、Runtime 发布来源和第三方制品校验和由 `runtime/toolchain-lock.json` 维护。

## 分布式发布链路

```text
通用 Git URL + tag
  -> scripts/release-system/ Controller
  -> 锁定 Desktop commit / Runtime commit / 原生 targets
  -> 一次性票据 + 短期任务租约
  -> 受信任原生 Worker
  -> 复用 desktop:package
  -> 流式上传 + BUILD-INFO / SHA-256 / 目标校验
  -> filesystem（默认）或可选 GitHub Provider
```

四平台映射只由 `scripts/release-system/targets.json` 定义。Controller 状态和制品位于 `target/release-controller/`，Worker 默认使用系统临时目录；二者都不是源码事实。构建与发布 Provider 解耦，代码托管平台不参与节点授权。

## 代码职责

- `src/`：Vue 3 桌面管理 Shell、三语国际化、类型化 IPC 和视图状态。
- `src-tauri/src/runtime.rs`：Runtime 状态机、进程生命周期、探活、恢复、工作区注册和嵌入式工作台。
- `src-tauri/src/credential_vault.rs`：本地加密凭据库、短期 Runtime 会话授权及旧索引迁移。
- `src-tauri/src/settings.rs`：原子设置读写、损坏或未来 schema 隔离恢复。
- `src-tauri/src/diagnostics.rs`：日志轮转、脱敏和诊断导出。
- `src-tauri/src/native_menu.rs`：跨平台原生菜单及页面切换入口。
- `src-tauri/src/updater.rs`：更新配置边界；社区版保持关闭。
- `runtime/packages/credentials-vault/`：Harness Credential Provider 代理，通过 stdin/stdout JSON 调用桌面 helper。
- `runtime/patches/`：针对锁定 Runtime 的最小桌面集成补丁，必须有 marker 和验证。
- `scripts/`：配置同步、Runtime 构建、发行门禁、平台打包和工具链引导。
- `scripts/release-system/`：平台无关的本地发布 Controller、Worker、目标协议和 filesystem/GitHub Provider。
- `.github/workflows/community-build.yml`：社区版原生平台构建矩阵。

## 运行链路

1. 桌面应用读取设置并确定工作区。
2. Rust Supervisor 以随机端口启动捆绑的 Node/Harness Runtime。
3. Runtime 通过受限会话调用桌面凭据 helper，不接收长期明文环境变量。
4. readiness 通过后，同一原生窗口切换到受管 Harness Origin。
5. Runtime 异常退出时按有限次数恢复；用户主动停止或应用退出时清理进程树。

## 安全边界

- 只信任受管的 loopback Origin，不允许任意远程页面进入桌面 IPC 域。
- 凭据、`.env`、用户工作区和本机路径不得进入安装包、发布附件或诊断包。
- 发布来源使用不可变 commit 和哈希作为事实，不以可移动 tag 单独作为信任依据。
