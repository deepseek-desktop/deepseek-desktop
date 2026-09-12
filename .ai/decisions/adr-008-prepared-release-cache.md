# ADR-008：发行准备凭据与内容寻址缓存

## 状态

已被 ADR-009 取代为正式发布路径；实现可保留用于实验，不作为发行门禁。

## 背景

四平台 Worker 过去分别执行完整 `desktop:package`，重复安装依赖、同步 Harness、运行通用验证和 E2E；临时 checkout 也无法稳定复用 Cargo 增量结果。直接增加跳过测试的环境变量会削弱发行门禁，并可能让来源漂移或脏源码进入安装包。

## 决策

1. `release:prepare` 只为当前原生目标生成准备凭据，不跨目标复用主机专属 Harness 闭包。
2. 准备结果由临时 Ed25519 密钥签名，descriptor 固定 receipt SHA-256、tag、Desktop/Harness 完整 commit、源码树、生成配置、工具链、channel、签名模式、目标和 dirty 状态；文件清单在 Unix 上同时固定权限位。
3. Worker 继续调用唯一的 `desktop:package`。只有 Controller 任务、descriptor、receipt、checkout 和原生目标完全一致时才进入 prepared 模式；随后仍在 Worker 上同步、暂存并验证该平台 Harness，否则执行完整门禁或拒绝正式发行。
4. Harness 闭包使用内容寻址缓存，按 Harness/补丁/lock/Node ABI/目标 triple/配置隔离并在命中前逐文件校验。Cargo target 按目标、flags 和签名模式持久隔离。
5. `release:local-all` 默认按内存限制并发，只重试失败目标；四个环境各自执行完整 Harness 同步和验证，不共享 prepared payload。构建与 Provider 上传继续解耦。
6. 暂不引入 `sccache`。固定 Cargo target 已带来主要本地增量收益，而跨平台 `sccache` 二进制、服务端缓存和签名信任会增加新的供应链边界。
7. Tauri 的内层 `beforeBuildCommand` 只执行前端类型检查与 Vite 构建。所有公开构建入口仍在外层执行或验证 `app:sync`，prepared Worker 因此不会在凭据核验后再次改写生成配置和品牌资源。
8. Linux 镜像身份同时绑定固定 Node/ABI 与 Dockerfile SHA-256。系统依赖或 Dockerfile 变化会自动废弃旧镜像，不能只因 Node 版本相同就复用过期环境。

## 后果

- 同一目标可以复用受签名约束的准备结果；多平台发行通过各原生 Worker 的内容缓存加速，同时保留目标专属 Harness 组装和验证。
- 准备凭据和缓存损坏会自动失效，不能通过环境变量绕过安全检查。
- `summary.json` 是准备、Worker、缓存、打包和发布耗时的事实来源；没有完整实测时不声明具体提速分钟数。
- 缺少原生节点时任务保持等待或失败，不能以错误平台交叉制品补齐目标。
