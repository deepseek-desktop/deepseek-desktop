# ADR-005：Runtime 独立可信更新

## 状态

已采用。

## 决策

DeepSeek Desktop 将桌面安装包更新和 Runtime 更新拆分。安装包始终携带已验证 Runtime 作为最终恢复基线；独立 Runtime 以各原生平台生产闭包、签名清单和 SHA-256 发布。客户端只下载本机目标，在应用数据目录完成 staging、受限解压、smoke、原子指针切换和失败回滚，不修改受签名保护的应用安装目录。

Runtime 更新配置使用 `RUNTIME_UPDATE_MANIFEST_URL`、`RUNTIME_UPDATE_CHANNEL`、`RUNTIME_AUTO_UPDATE`、`RUNTIME_UPDATE_PUBLISHER` 和 `RUNTIME_UPDATE_PUBLIC_KEY`。清单可以由 filesystem、HTTP 静态服务或任意代码托管平台承载，客户端不依赖 GitHub API。构建期显式固定 `RUNTIME_REF` 时默认关闭自动下载。

## 兼容与信任

- Ed25519 签名覆盖发布者、版本、有效期、频道、Desktop/Runtime/凭据协议、Desktop 兼容范围、Desktop/Runtime commit、Runtime 仓库、Node ABI、凭据插件、DSH Market 和各平台制品哈希。
- 客户端按频道记录已接受版本、签发时间和 commit，拒绝过期、未来签发、重放、降级和同版本替换 commit；stable 频道拒绝预发布，平台、仓库或协议不匹配时保持当前版本。
- Runtime 制品只能由对应原生平台受信任节点产生，签名清单默认要求四平台描述齐全、同源且干净。
- HTTP 客户端不跟随重定向；跨 Origin 必须在签名清单中授权。压缩包拒绝路径穿越、链接、特殊文件、重复路径和解压炸弹。
- 诊断只记录版本、commit、来源和阶段，不记录清单地址、令牌、签名私钥或模型凭据。

## 回滚

待安装 Runtime 在下次启动前必须在隔离内部目录真实启动本地服务，并通过 readiness 与认证 HTTP 探活。Desktop 不依赖 Runtime 私有工作区接口；切换后无法启动或连续恢复达到上限时先回滚上一版，上一版无效时移除外部指针并使用安装包内置 Runtime。只保留当前、上一版和待安装版本，失败与启动时清理 staging 和孤立目录。用户可以固定当前版本或手动恢复内置版，离线恢复不依赖更新服务。
