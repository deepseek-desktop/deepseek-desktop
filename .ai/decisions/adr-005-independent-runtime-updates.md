# ADR-005：Runtime 仓库可替换更新

## 状态

已采用。

## 决策

DeepSeek Desktop 将桌面安装包和 Runtime 更新拆分。Desktop 是稳定原生外壳，安装包始终携带已验证 Runtime 作为最终恢复基线；用户只配置一个 Runtime Git 仓库地址，即可改变下次运行的 Runtime。默认地址来自构建时的 `RUNTIME_REPOSITORY`，当前社区版为 `https://github.com/deepseek-desktop/deepseek-harness.git`；用户可以替换为官方上游或自己的兼容 fork。

设置 schema 只公开 `runtimeUpdateRepository` 覆盖值，不再让普通用户配置来源类型、清单 URL、发布者或公钥。覆盖值为空时使用构建默认仓库；保存其他仓库后，更新检查和候选准备立即绑定新仓库，旧候选失效。诊断导出剔除自定义仓库地址。

仓库模式使用 Git 读取默认分支 `HEAD`，发现不同 commit 后在应用数据目录浅克隆源码，复用当前安装包内置的 Node 与 pnpm，执行锁定依赖安装和仓库 `build`。候选补齐 Desktop 凭据代理、市场和 pnpm 包，并通过 Node 版本、ABI、CLI、包版本与真实 Runtime 服务 smoke 后才写入待切换指针；失败删除 staging 并保留当前 Runtime。Git 凭据由用户已有 Git 环境负责，Desktop 不复制、记录或跨仓库传递凭据。

发行维护者仍可通过 `RUNTIME_UPDATE_MANIFEST_URL`、`RUNTIME_UPDATE_CHANNEL`、`RUNTIME_UPDATE_PUBLISHER` 和 `RUNTIME_UPDATE_PUBLIC_KEY` 预置签名制品通道。它是可选的高保障默认分发路径，不出现在普通用户设置中；用户填写其他仓库后明确切换到仓库模式。构建期显式固定 `RUNTIME_REF` 时默认关闭自动准备。

## 兼容与信任

- 配置任意仓库表示用户信任该仓库的源码、依赖和安装脚本在本机执行；Desktop 不通过厂商名、域名或 Provider ID 判断仓库身份。
- 仓库 URL 拒绝嵌入 HTTP 凭据、query 和 fragment；支持 HTTP(S)、SSH、Git 和本地 `file` Git 仓库。检查结果绑定规范化仓库身份和 commit，仓库变化后必须重新检查。
- 候选只写应用数据目录，不修改 `.app`、Windows 安装目录或 Linux 应用映像。仓库构建使用安装包内置 Node/pnpm，但依赖系统可执行 Git。
- 当前、上一版、待安装和内置基线的指针与回滚语义在仓库模式和签名制品模式中保持一致。

可选签名制品通道继续保留下列约束：

- Ed25519 签名覆盖发布者、版本、有效期、频道、Desktop/Runtime/凭据协议、Desktop 兼容范围、Desktop/Runtime commit、Runtime 仓库、Node ABI、凭据插件、DSH Market 和各平台制品哈希。
- 客户端按频道记录已接受版本、签发时间和 commit，拒绝过期、未来签发、重放、降级和同版本替换 commit；stable 频道拒绝预发布，平台、仓库或协议不匹配时保持当前版本。
- Runtime 制品只能由对应原生平台受信任节点产生，签名清单默认要求四平台描述齐全、同源且干净。
- HTTP 客户端不跟随重定向；跨 Origin 必须在签名清单中授权。压缩包拒绝路径穿越、链接、特殊文件、重复路径和解压炸弹。
- 诊断只记录版本、commit、来源和阶段，不记录清单地址、令牌、签名私钥或模型凭据。
- 构建时预置的清单地址、仓库身份、发布者和公钥不会进入诊断包。

## 回滚

待安装 Runtime 在下次启动前必须在隔离内部目录真实启动本地服务，并通过 readiness 与认证 HTTP 探活。Desktop 不依赖 Runtime 私有工作区接口；切换后无法启动或连续恢复达到上限时先回滚上一版，上一版无效时移除外部指针并使用安装包内置 Runtime。只保留当前、上一版和待安装版本，失败与启动时清理 staging 和孤立目录。用户可以固定当前版本或手动恢复内置版，离线恢复不依赖更新服务。
