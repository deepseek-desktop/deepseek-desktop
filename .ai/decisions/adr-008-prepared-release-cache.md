# ADR-008：发行准备凭据与内容寻址缓存

## 状态

已采用。

## 背景

四平台 Worker 过去分别执行完整 `desktop:package`，重复安装依赖、同步 Runtime、运行通用验证和 E2E；临时 checkout 也无法稳定复用 Cargo 增量结果。直接增加跳过测试的环境变量会削弱发行门禁，并可能让来源漂移或脏源码进入安装包。

## 决策

1. 增加 `release:prepare`，在干净且 tag 指向当前 HEAD 的源码上只执行一次平台无关门禁。
2. 准备结果由临时 Ed25519 密钥签名，descriptor 固定 receipt SHA-256、tag、Desktop/Runtime 完整 commit、源码树、生成配置、Runtime 补丁与 lock、工具链、channel、签名模式和 dirty 状态。
3. Worker 继续调用唯一的 `desktop:package`。只有 Controller 任务、descriptor、receipt、checkout 和生成闭包完全一致时才进入 prepared 模式；否则执行完整门禁或拒绝正式发行。
4. Runtime 闭包使用内容寻址缓存，按 Runtime/补丁/lock/Node ABI/目标 triple/配置隔离并在命中前逐文件校验。Cargo target 按目标、flags 和签名模式持久隔离。
5. `release:local-all` 在准备成功后才调度 Worker，默认按内存限制并发，只重试失败目标；构建与 Provider 上传继续解耦。
6. 暂不引入 `sccache`。固定 Cargo target 已带来主要本地增量收益，而跨平台 `sccache` 二进制、服务端缓存和签名信任会增加新的供应链边界。

## 后果

- 四平台发行不再重复通用门禁，暖缓存只支付各目标必须的原生组装和打包成本。
- 准备凭据和缓存损坏会自动失效，不能通过环境变量绕过安全检查。
- `summary.json` 是准备、Worker、缓存、打包和发布耗时的事实来源；没有完整实测时不声明具体提速分钟数。
- 缺少原生节点时任务保持等待或失败，不能以错误平台交叉制品补齐目标。
