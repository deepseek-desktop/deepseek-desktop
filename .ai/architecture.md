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

可信 Runtime 更新配置
  -> scripts/runtime-update/ 各原生节点生成生产闭包
  -> 四平台描述一致性 + Ed25519 签名清单
  -> 应用数据目录 staging / 版本目录
  -> 有效期 / 防重放 + SHA-256 + 来源 / 平台 / 协议 / 包版本校验
  -> 真实本地服务 smoke -> 原子 current 指针 -> 失败回滚 previous / bundled
  -> 只保留 current / previous / pending 引用版本
```

`target/` 是生成与缓存目录，不是源码事实。稳定工具链、Runtime 发布来源和第三方制品校验和由 `runtime/toolchain-lock.json` 维护。

## 正式发布链路

```text
完整 SemVer Tag
  -> GitHub Actions 校验 Tag / Desktop commit / Runtime lock
  -> macOS ARM64 / macOS x64 / Windows x64 / Linux x64 官方 Runner
  -> 各目标复用 package:community -> desktop:package
  -> 平台 smoke / 安装包扫描 / 内部 BUILD-INFO / SHA-256
  -> 汇总任务验证 2 DMG + EXE + AppImage + DEB
  -> GitHub Release：5 个安装包 + SHA256SUMS
```

Pull Request 和普通分支 push 不触发发布工作流。正式发布以 `.github/workflows/community-build.yml` 为唯一入口；只有完整 SemVer Tag 才运行质量门禁和四平台矩阵，矩阵全部成功后才允许汇总发布，不完整版本不得公开。

`scripts/release-system/` 保留通用 Controller、Worker 和 filesystem Provider 作为实验与协议测试实现，不是正式发布前提；本机不再通过 Rosetta、Docker 或虚拟机模拟四平台发行。

## 代码职责

- `src/`：Vue 3 桌面管理 Shell、三语国际化、类型化 IPC 和视图状态。
- `src-tauri/src/runtime.rs`：Runtime 状态机、独立运行目录、进程生命周期、探活、恢复和嵌入式工作台。
- `src-tauri/src/runtime_update.rs`：签名 Runtime 清单、平台下载、受限解压、版本指针、smoke、切换与回滚。
- `src-tauri/src/credential_vault.rs`：本地加密凭据库、短期 Runtime 会话授权及旧索引迁移。
- `src-tauri/src/settings.rs`：原子设置读写、损坏或未来 schema 隔离恢复。
- `src-tauri/src/diagnostics.rs`：日志轮转、脱敏和诊断导出。
- `src-tauri/src/native_menu.rs`：跨平台原生菜单及页面切换入口。
- `src-tauri/src/updater.rs`：桌面安装包更新边界；与 Runtime 独立更新分离，社区版保持关闭。
- `runtime/packages/credentials-vault/`：Harness Credential Provider 代理，通过 stdin/stdout JSON 调用桌面 helper。
- `runtime/packages/web-search-follow-model/`：Provider 无关的联网搜索路由、标准协议执行器和受控第三方协议注册服务。
- `runtime/patches/`：针对锁定 Runtime 的最小桌面集成补丁，必须有 marker 和验证。
- `scripts/`：配置同步、Runtime 构建、发行门禁、平台打包和工具链引导。
- `scripts/release-system/`：实验性的本地发布协议、目标校验和 filesystem Provider，不作为正式发布主路径。
- `scripts/runtime-update/`：原生 Runtime 更新制品、四平台描述汇总和 Ed25519 清单签名。
- `.github/workflows/community-build.yml`：正式四平台原生构建与统一 Release 入口。

## 运行链路

1. 桌面应用读取壳层设置，不要求选择项目目录。
2. Rust Supervisor 在应用数据目录内的独立运行目录中，以随机端口启动捆绑的 Node/Harness Runtime。
3. Runtime 通过受限会话调用桌面凭据 helper，不接收长期明文环境变量。
4. readiness 通过后，同一原生窗口切换到受管 Harness Origin。
5. Runtime 异常退出时按有限次数恢复；用户主动停止或应用退出时清理进程树。
6. 已配置可信更新服务时，候选 Runtime 下载到应用数据目录并在下次启动 smoke 后切换；失败回滚上一版或内置基线。

联网搜索链路独立于 Desktop 壳：

```text
web_search 工具
  -> 当前执行 Agent 的内部会话上下文
  -> 当前模型 Provider / model
  -> Provider 显式能力覆盖或当前模型 apiProtocol 的标准映射
  -> 继承 endpoint / CredentialRef
  -> 标准协议执行器或受信任插件注册的执行器
  -> 统一 WebSearchResult
```

路由上下文由 Runtime 内部传递，不进入模型可控的工具参数。已知模型 API 协议自动映射到标准搜索协议，显式 Provider 能力仅作为高级覆盖；未知协议快速失败且不发送探测请求。切换模型后下一次调用重新解析当前会话路由，多会话不会共享可变 Provider 状态。

Desktop 与 Runtime 的关系是“原生壳 + 本地 Web 应用”：Desktop 不调用 Runtime 私有工作区 API，不保存用户项目目录，也不把自身运行目录解释为用户工作区。会话、项目目录和文件边界由 Runtime 工作台自己的稳定公共能力负责。

## 安全边界

- 只信任受管的 loopback Origin，不允许任意远程页面进入桌面 IPC 域。
- 凭据、`.env`、用户工作区和本机路径不得进入安装包、发布附件或诊断包。
- 发布来源使用不可变 commit 和哈希作为事实，不以可移动 tag 单独作为信任依据。
- Runtime 清单签名覆盖有效期、来源、兼容协议和制品哈希；更新客户端按频道拒绝重放与降级，不跟随重定向，不解压链接、特殊文件或逃逸路径。
- 联网搜索凭据只以 `CredentialRef` 从当前 Provider 解析并发送到其经过校验的 HTTPS endpoint；禁止搜索失败后跨 Provider 降级、自动重定向、厂商或域名猜测和密钥日志输出。
- 每个平台扫描实际交付闭包并以内部 `BUILD-INFO` 完成来源和目标核验；汇总任务拒绝资产数量、平台、来源或哈希不一致。GitHub Actions 的第一方 Action 固定到不可变 commit SHA。
