# ADR-026：壳为内核恢复用户的登录环境

## 状态

已采用。补全 [ADR-025](adr-025-shell-never-filters-the-kernel-environment.md) 未覆盖的另一半，并把 [ADR-012](adr-012-harness-repository-system-proxy.md) 针对代理的单点兜底推广到整个环境。

## 背景

ADR-025 删掉了环境白名单，此后 sidecar 拿到桌面进程环境的完整副本。但**副本的来源本身是空的**：从 Finder、Dock 或桌面启动器拉起的进程不是任何 shell 的子进程，操作系统只给它一副骨架。本机实测，v1.1.25 的 sidecar 一共只有 24 个变量，`PATH` 是 `/usr/bin:/bin:/usr/sbin:/sbin`——没有 Homebrew、没有 nvm、没有 pyenv/goenv/sdkman，也没有 `LANG`。

用户的报告正是这个形状：内核的 Bash 工具报「Node 不可用」，而同一台机器的终端里 `node --version` 输出 `v24.20.0`。内核据此判断「没装 Node」并改用绝对路径绕开，实际是壳没有把用户的环境交给它。

同一根因还有第二处：桌面自己打包了内核运行所依赖的那一份 Node，并以 `DEEPSEEK_DESKTOP_NODE_PATH` 交给内核，却从未把它放进 `PATH`。内核**运行在**这个 Node 上，却无法按名字调用它。

## 决策

- 桌面在启动时询问用户自己的登录 shell（`$SHELL -l -i -c`，取不到时 `/bin/sh`），把它报告的环境作为**底层**，再把进程自身的环境覆盖其上——启动上下文真正携带的变量更具体，仍然胜出。
- `PATH` 例外，按**合并**而非覆盖处理：登录 shell 的顺序在前（Homebrew 排在 `/usr/bin` 之前是用户的明确选择，反转会让内核和终端解析到不同的 `python3`），启动上下文独有的条目追加在后，一条不丢。
- 桌面拥有的 `harness-bin`（`pnpm`）继续排在最前；新增 `harness-bin-fallback` 排在最后，其中的 `node` 符号链接指向随包的 Node。位置是兜底而非优先：用户自己装了 Node 就是要用自己那个。
- 探测有界：8 秒预算，超时按进程组 SIGKILL，失败即放弃并沿用原有环境。`-l -i` 被严格 POSIX shell（dash/ash）拒绝时快速回退到 `-c` 一次。
- 探测 shell 自身产生的会话记账（`PWD`、`OLDPWD`、`SHLVL`、`_` 和探测标记变量）不计入结果。这不是对用户环境的过滤，而是移除运行探测本身的产物——尤其 `PWD` 会告诉内核启动的工具它身处家目录，而实际并非如此。
- 结果无论成败都写进诊断日志。静默丢弃正是白名单最难排查的地方，不能在替代方案里重演。
- 仓库模式的 Git 调用共用同一条合并后的 `PATH`，不再只在传入 `tools` 时才覆盖。

## 理由与边界

探测运行的是**用户自己的** shell 配置，在用户自己的账户下，不构成新的信任边界；这正是编辑器处理同一缺陷十余年来的标准做法。`-l` 与 `-i` 都要：用户把 export 分散在 profile 与 rc 两处，只取其一覆盖不到常见配置。探测子进程独立进程组，避免从终端启动时交互式 shell 的作业控制信号停住桌面。

Windows 两件都不做。登录 shell 探测没有意义：Explorer 启动的进程从注册表继承完整用户环境，没有 profile 可问。Node 兜底则是读过内核代码后放弃的——`dsh-subprocess-local` 解析裸命令名时只尝试 `.com` 和 `.exe`（`windowsExecutableNames`），`node.cmd` 会躺在搜索路径上却永远解析不到，放一个只会看起来像 Windows 也有同样的保证。需求本身也更小：该平台上装了 Node 的用户，`PATH` 里本来就有。

新增的暴露面需要说清楚：此前从 Finder 启动时，用户 profile 里的变量根本到不了桌面进程，现在会。其中包括影响 sidecar 自身的名字——`NODE_OPTIONS` 会作用于运行 Harness 的那个 Node，用户 profile 中不兼容的取值可能导致启动失败。这与用户从终端启动应用时的行为一致，也正是「壳不得改变内核所处环境」的应有之义；诊断日志记录了探测结果，异常时可据此定位。

代价与 ADR-025 同源且同等：用户在 shell profile 里 `export` 的凭据会进入内核环境。这本就是内核官方搜索插件声明的回退路径，且这些值在终端里对用户的任何程序都已可见；过滤它同样属于壳阻断内核。桌面加密保险库这条通道不变。

本决策不改变任何内核默认值，不放宽工作台 WebView 的 capability，也不对签名、公证或真实供应商验收作出声明。

## 验证

- `parse` 的围栏解析、多行/含 `=` 取值、截断拒绝，以及 `PATH` 合并顺序与「登录 shell 无应答时不丢启动上下文」均有单元测试；另有一例对真实 `/bin/sh` 的端到端捕获，断言探测自身的会话记账一项都不会泄漏进结果。
- 本机以 `env -i` 模拟 Finder 骨架环境实测：探测恢复出含 `~/.nvm/versions/node/v24.20.0/bin`、`/opt/homebrew/bin`、pyenv/goenv/sdkman 的完整 `PATH`，以及 `LANG`、`NVM_DIR`。
