# ADR-027：Desktop 使用 Harness 对齐的四段公开版本

## 状态

已接受，2026-09-22。

## 决策

DeepSeek Desktop 的新发行版本固定为四段数字 `H_MAJOR.H_MINOR.H_PATCH.DESKTOP_REVISION`。前三段必须等于 `harness/toolchain-lock.json` 中 `harnessSource.version` 的三段正式版本，第四段是从 `1` 开始递增的 Desktop 修订号。例如锁定 Harness `0.1.6` 时，Desktop 依次发行 `0.1.6.1`、`0.1.6.2`。

Git Tag 可以带或不带小写 `v` 前缀，除此之外不接受预发布后缀、构建元数据、缺失段、前导零或值为 `0` 的 Desktop 修订号。CI 在进入质量门禁前同时校验四段格式和 Harness 前三段映射。

四段公开版本是窗口、关于页、更新提示、发布目录、安装包名称、Release Tag 和 `BUILD-INFO` 的唯一用户可见版本。Tauri 和原生打包格式仍有各自约束，由 `app:sync` 从公开版本派生内部值：Windows/Linux 使用 `0.1.6+1` 形式的 SemVer；macOS 使用三段 marketing version `0.1.6` 和 build number `1`。这些派生值不得作为另一套人工维护的版本源。

Desktop 更新器继续解析历史 SemVer Release，便于 `v1.1.27` 等既有安装升级。任何四段 Harness 对齐版本都排在历史版本之后；进入四段体系后，只按四个数字逐段比较，不能把历史 `v1.x` 重新提示为新版。

## 原因

- 用户可以直接从前三段看出内置 Harness 基线，并从第四段区分 Desktop 修订。
- 单一公开版本配合确定性派生，避免 Tag、界面、安装包与原生元数据分别维护而漂移。
- 迁移排序规则保留既有用户的升级路径，同时不会为新发行继续保留旧版本机制。

## 验证

- JavaScript 单元测试覆盖格式、Harness 映射、Tag 和五个平台公开安装包名称。
- Rust 单元测试覆盖历史版本迁移、四段排序、忽略版本和内部 SemVer 到公开版本的转换。
- `app:sync --check`、发行门禁和四平台原生矩阵共同验证生成配置及实际安装包元数据。
