# ADR-020：跨引擎 JSON 内置原型校验

## 证据

锁定 Harness `0.1.3-alpha.1`、commit `d347e703908d` 的 util-values 将内置构造函数文本写死为 V8 的单行格式。WebKit 返回包含换行的原生函数文本，合法普通对象被判为非 JSON，消息回放报 `Assistant stream raw chunk must be a lossless JSON object`。同一份隔离测试会话在 Chromium 显示完整，在 WebKit 中断；原始会话文件未修改。

## 决策

在唯一 `deployHarnessClosure` 链路对已知的五个浏览器闭包入口修正精确匹配表达式：与当前引擎自身的 Object / Array 内置构造函数文本比较，而非硬编码 V8 排版。保留构造函数名称、prototype 身份及原型链检查，不接受自定义类、伪造原型、稀疏数组、循环、丢失值或非有限数字。

util-values 被内联到 connection、session-controller、chat、trajectory 的 client.js，因此必须同时修正这些入口。安装包与仓库候选共用装配函数，独立搜索插件及官方搜索源码不变；不注入运行时 monkey patch，不修改用户日志、缓存或设置。

## 验证边界

Node 回归覆盖范围与幂等；E2E 使用实际装配产物，在 Chromium 及 macOS WebKit 验证当前和跨 realm 对象、数组与拒绝场景。原生 DMG 仍须独立完成历史恢复及交互复验。只对已知的精确表达式应用修复，未来上游实现变化需要重新验收，不能承诺任意版本兼容。

2026-09-05 完整构建的七项 E2E 通过；同一测试会话在两引擎均恢复全部 39 行，reload 后仍有最新回复且无 lossless JSON 错误。新 DMG 正常安装启动也恢复此前中断的历史，未修改原始会话文件。
