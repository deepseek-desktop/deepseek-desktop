# ADR-012：Runtime 仓库请求继承 macOS 系统代理

## 状态

已采用。

## 原因

Finder 启动的 Desktop 不继承交互式终端的代理环境变量。Git/libcurl 不自动读取 macOS 系统代理，导致浏览器和终端可访问仓库，Desktop 的 `ls-remote` 却持续超时。延长超时或修改用户全局 Git 配置不能解决产品边界问题。

## 决策

- 仅为 Runtime 的 HTTP(S) Git 检查和浅克隆补充进程级代理；SSH、本地仓库及 Runtime 对话连接不变。
- 使用 macOS `CFNetworkCopySystemProxySettings` / `CFNetworkCopyProxiesForURL` 按实际仓库 URL 解析静态 HTTP/HTTPS/SOCKS 代理及系统绕过规则，不硬编码地址、端口或仓库域名。
- macOS 显式依赖已在 Cargo lock 中的 `core-foundation 0.10.1`，管理 Copy API 返回对象的所有权；不引入新的版本或外部可执行工具。
- 已设置的协议代理和 `ALL_PROXY`（包括显式空值）优先；通过子进程环境补充代理，使 Git 自身 `http.proxy` 与 `NO_PROXY` 继续生效。不修改系统代理、全局 Git 配置，不输出代理地址或凭据。
- 系统指定 DIRECT 时不选择其他代理。PAC 不是静态代理地址，本轮不执行 PAC；需要 PAC 的环境继续使用已有 Git/环境代理。Windows/Linux 保持原有 Git/环境代理行为。
- 仓库检查有独立的 30 秒预算；超时状态有三语网络/代理提示，终止 Git 及其辅助进程，保持当前 Runtime 不变。

## 验证

匿名系统代理配置覆盖 HTTPS、绕过、直接连接；测试环境代理优先级、非 HTTP 仓库不探测、超时状态和子进程清理。真实仓库验证必须在清除终端代理变量后执行，不能把终端已有代理的成功当作桌面修复证据。
