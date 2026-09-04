# ADR-016：安全渲染 Desktop 发布说明

- 状态：已采纳
- 范围：Desktop 更新弹窗；不修改 Harness、菜单位置或自动安装规则。

## 决策

原更新摘要使用 Vue 文本插值，导致 GitHub Release 的 Markdown 标题、列表和表格按源码显示。新增精确锁定的 `markdown-it@15.0.1`，复用成熟解析器，不自行编写 Markdown 正则转换。组件只接收解析器输出，关闭原始 HTML；远程图片仅保留替代文字，避免摘要加载触发跟踪请求。协议参考 [markdown-it 文档](https://markdown-it.github.io/markdown-it/)。

更新摘要保留有界滚动、紧凑标题、深色主题与表格/代码块横向滚动。链接必须为无嵌入凭据的 HTTP(S) 地址，相对链接基于当前官方 Release 页面解析；用户点击后经专用 Desktop IPC 交由系统浏览器打开，Rust 再校验地址，不启用通用 opener 权限、不向 Harness 授予 IPC。原“前往下载”仍只打开构建时固定的官方仓库 Release。

## 验证

覆盖 Markdown 结构、原始 HTML/脚本/危险 URL、远程图片、外链委派与失败提示。浏览器 E2E 使用模拟更新 IPC，验证弹窗真实布局、键盘链接、长内容及最小窗口尺寸；模拟 IPC 不作为原生操作系统浏览器启动验收。
