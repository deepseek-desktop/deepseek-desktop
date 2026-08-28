# 验证基线

## 最近可信验证

日期：2026-08-28

同步官方 Runtime `dsh-v0.1.2-alpha.1`（`cd5ef8148158c3a752a658978873241fdf8e2bbc`），并完成分布式本地发布系统与 Runtime 独立更新协议后：

- `corepack pnpm@11.7.0 app:sync --check`：通过，生成配置与工作区一致。
- `corepack pnpm@11.7.0 runtime:sync --check`：通过，来源、commit、CLI 入口、部署闭包和制品哈希均与生成锁一致。
- `corepack pnpm@11.7.0 verify`：通过；配置、分布式发布和 Runtime 更新协议测试 41 项、Vue 测试 7 项、Rust 测试 46 项、Clippy `-D warnings`、3 个 locale / 143 个 key、原生 Runtime 错误码与前端映射门禁、凭据代理回归和 Runtime manifest 校验全部通过。
- `corepack pnpm@11.7.0 release:smoke`：通过本地 Controller HTTP、一次性节点票据、短期租约、制品上传、完整性校验和 filesystem 发布闭环。
- `corepack pnpm@11.7.0 release:local-all -- --check`：通过真实四环境预检；macOS ARM64 原生、Rosetta macOS x64、Docker Linux x64 和 Parallels Windows x64 均成功识别目标并访问同一临时 TLS Controller，单环境探测耗时约 0.5 至 0.9 秒。
- `corepack pnpm@11.7.0 release:worker -- --identify`：当前 macOS ARM64 节点可正确识别为 `macos-arm64`，不会领取其他平台任务。
- 当前 macOS 原生 Runtime 闭包：24925 个文件、494 个包；`corepack pnpm@11.7.0 runtime:smoke` 完成启动、父进程退出清理验证。
- `corepack pnpm@11.7.0 test:e2e`：1 项 Playwright 测试通过。
- `corepack pnpm@11.7.0 vault:smoke src-tauri/target/release/deepseek-desktop`：通过 release 二进制的本地加密凭据写入、描述、读取、删除和明文泄漏检查。
- `corepack pnpm@11.7.0 desktop:package`：通过完整同步、门禁、验证、E2E、Runtime smoke、macOS ARM64 原生应用与 DMG 构建；生成 `DeepSeek Desktop_1.0.0_aarch64.dmg`、`BUILD-INFO.aarch64-apple-darwin.json` 和 `SHA256SUMS`。最终使用支持错位 UTF-16LE 的扫描器复扫 49,922 个文件、986,494,611 字节，未发现 `.env`、密钥、本机绝对路径或符号链接泄漏。
- Runtime 更新候选版本现在必须通过真实服务启动、HTTP 健康检查和工作区注册后才能切换；已覆盖过期/未来/回放清单拒绝、下载中断清理、旧版本保留与清理、并发设置写入及不可回滚配置错误测试。
- `corepack pnpm@11.7.0 runtime:update:package -- --output <目录>`：通过公开一键入口同步并生成 macOS ARM64 Runtime 更新制品；制品为 88,724,342 字节，描述中的大小和 SHA-256 与实际文件一致，归档安全扫描未发现绝对路径、父目录逃逸或 `.env`。
- `corepack pnpm@11.7.0 preflight:docker`：通过，在 GitHub 兼容的 Linux/amd64 模拟环境完成官方 Runtime 构建、Desktop 公共 CI 门禁、24841 个文件 / 495 个包的 Runtime 闭包校验及 Playwright 测试；容器按约定跳过仅适合原生宿主执行的 Runtime smoke。
- 窗口标题版本格式已覆盖测试：版本已有 `v` 时保持不变，没有 `v` 时补齐；默认和示例版本仍为 `1.0.0`。
- `v1.0.0` 托管发布在 macOS ARM64 节点被制品扫描拦截：全局 `NO_STRIP=1` 令 `sharp-libvips` 动态库保留 GitHub Runner 绝对路径；Linux 节点则因 AppImage 合法的 `.DirIcon` 内部链接被 v1 扫描器拒绝。现已将 `NO_STRIP` 严格限定为两个 Linux 打包步骤，并将扫描协议升级为 v2：允许根内相对链接、拒绝绝对链接和根外逃逸，Controller 同步要求 v2 审计。`v1.0.1` 进一步确认 `sharp-libvips` 本身带有公开上游路径 `/Users/runner/work/sharp-libvips/...`，CI 扫描因此改用本项目工作区、Runner 临时目录等精确根路径，本地打包仍拒绝真实用户主目录；实际 18,164,536 字节 dylib 的模拟 CI 扫描通过。Linux 同源 `libgnutls.so.30` 复现证明命中内容为 `gnutls_pk_self_test` 公开自检私钥，因此 PEM 检查现仅作用于 UTF-8/UTF-16 文本，二进制仍检查令牌与本机路径。
- `v1.0.2` 在 Windows x64 原生节点暴露发布协议测试仍使用 Unix 路径字面量，实际 `path.resolve()` 结果为 `C:/...`。测试现统一通过平台原生解析生成期望路径；本机 Parallels Windows 11 直接执行 `node --test scripts/tests/release-system.test.mjs` 共 11 项全部通过，本机 macOS 全量 `corepack pnpm@11.7.0 verify` 也通过。
- `v1.0.3` 托管发行全部通过：公共质量门禁约 9 分钟，macOS ARM64 约 13 分钟，Linux x64 约 16 分钟，Windows x64 约 28 分钟，macOS x64 约 38 分钟，Release 汇总约 30 秒；矩阵并行后的总时长约 49 分钟。预发行 Release 包含 5 个安装制品与 `SHA256SUMS`；下载校验清单后与 GitHub 返回的 SHA-256 摘要逐项比较，5 项全部一致。该结果证明原生平台构建与制品门禁通过，不替代用户侧真机安装和业务验收。

## 能力边界

- 上述结果证明当前源码、生成配置、锁定 Runtime、前端和当前 macOS 开发环境的验证链路可运行。
- 它不等于 Apple 公证、Windows 发布者签名、四目标完整安装包构建与安装验收、外部更新服务下载，或四平台安装版中的真实 Runtime 切换与回滚验收。macOS x64 当前通过 Rosetta，Linux x64 当前通过 Docker `linux/amd64`，Windows x64 当前通过 Parallels Windows ARM 的 x64 模拟运行构建工具，均不是对应架构的独立物理机。
- 用户此前明确取消“每次发布前必须挂载 DMG、校验签名结构并启动 5 秒”的固定流程；不要把该流程重新设为完成门槛，除非任务明确要求。

## 更新规则

只有实际重新执行验证后才能覆盖本文件中的结果。失败、跳过、Mock 和外部条件应明确区分，不能用历史通过结果替代当前验证。
