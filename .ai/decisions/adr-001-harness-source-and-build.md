# ADR-001：Harness 来源与构建事实

## 状态

已采用。

## 决策

Desktop 不提交预构建 Harness 源码，也不依赖相邻仓库工作区。`scripts/harness-sync.mjs` 从 `HARNESS_REPOSITORY` 获取源码，将 ref 解析为不可变 commit，按上游构建契约生成生产闭包，再应用受测桌面补丁。

本地开发允许 `HARNESS_REF` 为空并自动选择最新 SemVer，也允许显式本地路径联调。社区版和 stable 发布必须匹配 `harness/toolchain-lock.json` 中经过审计的仓库和 commit；构建事实写入生成的 Harness lock 与 BUILD-INFO。

## 理由

- 避免相邻检出、移动 tag 和历史缓存让构建不可复现。
- 允许开发者跟进最新 Harness，同时让公开发行保持可审计。
- 将稳定工具链约束与单次构建动态事实分开维护。

## 约束

- 变更 pin 时必须同步审计补丁、依赖、许可证、哈希、测试和文档。
- 不得仅修改来源说明而继续打包旧 Harness。
