# 更新日志

DeepSeek Desktop 的重要变化记录如下。

## 0.1.0-community.15 - 2026-08-27

- 修复 Windows 短路径构建副本把本机 Git `origin` 误当公开仓库地址的问题；GitHub Actions 现在使用当前工作流仓库上下文，本地文件型 `origin` 会安全回退。
- 发行工作流接受带或不带 `v` 前缀的完整 SemVer 标签，并在构建入口与发布门禁中执行严格版本匹配。
- Harness 构建变量统一为 `HARNESS_REPOSITORY` / `HARNESS_REF`；本地留空时自动选择最新 SemVer，社区发行仍锁定经过审计的不可变提交。
- 统一 local、community、stable 的发行渠道与签名状态来源，关于页、浏览器 fallback、构建门禁和发布信息不再各自推断。
- Harness 发布来源新增仓库与 commit pin 校验，Rust 工具链下载新增官方 SHA-256 校验，避免移动 tag 或未校验工具链进入发行包。
- 凭据记录索引改为加密存储，并安全迁移旧版明文索引；凭据写入或删除失败时保留原始错误并回滚记录。
- 修复损坏或未来版本设置文件导致启动失败的问题，应用会隔离异常设置并恢复可用默认值。
- 完善诊断导出的互斥、UTF-8 日志尾部读取、五级轮转日志和换行格式脱敏。
- 修复工作区注册、Harness 状态操作和桌面视图切换的异常提示，补齐三语文案引用检查。
- Harness profile 扩展只在内置来源发生变化时同步，减少重复启动时的大量文件复制。
- 建立仓库内 Agent 项目记忆，记录当前架构、安全边界、验证基线和后续外部条件。

## 0.1.0-community.13 - 2026-08-26

- 修复 Windows 发行构建通过映射盘访问 Harness 源码时，TypeScript 将同一模块解析为两套路径并产生声明冲突的问题。
- Windows 构建改为在真实短路径中执行，兼顾 pnpm 深层依赖路径与类型系统的一致性。
- 新增与 GitHub 通用质量任务同源的 Docker 预检及本机原生发行预检，发布前可在 macOS 与 Windows 提前发现构建问题。
- Harness 远程源码缓存每次同步前恢复到锁定提交并清理旧生成物，避免历史构建污染后续安装包。
- Harness 远端暂时不可用时允许复用已验证的不可变 tag / commit 缓存，避免重复打包被短暂网络故障中断。
- Windows Harness 同步的 Git 操作按进程启用长路径支持，不修改用户全局配置也能清理深层依赖缓存。
- Harness 依赖同步统一使用非交互模式，避免本机或虚拟机打包因 pnpm 等待目录清理确认而中断。
- Windows 每次从本地 Git mirror 重建锁定提交的干净 Harness checkout，避开 pnpm 目录链接导致的 `git clean` 循环与 `ENOBUFS`；其他平台继续复用安全缓存。
- Windows Rust 工具链显式绑定 x64 构建目标并使用系统 curl 下载组件，同时正确解析 Clippy 的官方清单包名，避免 ARM 虚拟机缓存、目标漂移和下载卡死。
- Harness 父进程守护改为确认桌面进程是否存活，不再因中间启动进程退出而误触发恢复。
- Docker 复用版本锁定的 Playwright 镜像浏览器；一键打包会在冻结安装项目依赖后安装锁定版本所需的 Chromium Headless Shell，GitHub 按平台复用缓存，确保纯净构建机不会因步骤顺序或历史缓存差异失败。
- Playwright 升级到与 Node 24 构建链兼容的版本，本地浏览器制品默认写入项目 `target/`，避免旧版本解压卡住或用户级缓存锁影响打包。
- Docker 预检固定模拟 GitHub Ubuntu x64 架构；Apple Silicon 不再误用缺少锁定 Harness 制品的 Linux arm64 环境，跨架构时仅将 Harness 进程 smoke 顺延到原生打包门禁。

## 0.1.0-community.12 - 2026-08-26

- 修复容器环境未及时回收僵尸进程时，Harness 父进程退出 smoke 误报残留进程组的问题。

## 0.1.0-community.11 - 2026-08-26

- 修复容器构建环境因 Git 工作区所有权检查无法定位 Rust 工具链目录的问题。
- 将源码初始化值和文档示例版本固定为 `1.0.0`，发布版本改由 Git tag 自动注入。

## 0.1.0-community.10 - 2026-08-26

- 统一桌面应用与 Harness 的构建配置解析、同步、校验和安装包信息来源。
- 修复 Harness 桌面补丁应用流程，保持上游构建和桌面扩展可复现。
- 修复 macOS 从工作台切回桌面管理时残留 WebView 原生渲染层导致的白屏问题。
- 修复 Windows Harness 子进程显示控制台窗口、关闭窗口触发自动恢复并可能打开外部浏览器的问题。

## 0.1.0-community.9 - 2026-08-25

- Windows 正式构建改用 GUI 子系统，启动桌面应用时不再附带控制台窗口，关闭桌面应用也不再依赖外部终端窗口。
- 发布门禁新增 Windows GUI 子系统声明检查，防止入口重构后再次回归控制台程序。

## 0.1.0-community.8 - 2026-08-25

- 内置 DSH Market，提供插件浏览、安装、更新和卸载入口，并随应用提供固定版本 pnpm，不要求用户单独安装 Node.js 或包管理器。
- Harness 启动时合并桌面内置 Bundle 与用户插件配置，不再覆盖已安装插件和自定义依赖。
- 诊断页面新增脱敏纯文本日志导出，同时保留包含状态、版本和日志摘要的诊断包。
- 工作台和桌面管理 WebView 改为互斥显示，避免重叠区域在鼠标移动时反复切换指针样式。
- README 补充真实页面截图和中文快速使用说明。

## 0.1.0-community.6 - 2026-08-25

- 完成产品文案、桌面自有包、图标、诊断和发行产物中的 DeepSeek Desktop 命名治理。
- 仓库文档以中文为主，同时保留桌面界面的三语支持。
- 关闭自动依赖更新分支，使仓库只保留 `master` 分支。
- Playwright 发布门禁改为验收生产构建预览，避免开发服务器冷转换影响跨架构 Windows 验收。
- Harness Smoke 的临时目录固定在项目自身 `target/` 下，避免 Windows 浅层克隆路径越界到无权限目录。
- 桌面启动 Harness 时通过 Harness 公共接口幂等注册已选工作区，避免进入工作台后再次要求选择目录。

## 0.1.0-community.5 - 2026-08-25

- 产品更名为 DeepSeek Desktop，安装包、桌面自有包、环境变量、诊断、应用标识和数据目录统一使用 `deepseek-desktop` / `deepseek.desktop`。
- Harness 与桌面仓库引用迁移到 `deepseek-desktop` GitHub 组织。
- Windows 和 Linux 删除冗余产品名菜单，同时保留 macOS 标准应用菜单。
- Windows 和 Linux 的“文件”菜单保留退出，“帮助”菜单保留关于，精简后仍具备完整原生操作。

## 0.1.0-community.4 - 2026-08-25

- 工作台与桌面管理合并到同一个原生窗口，通过原生“视图”菜单切换。
- 使用简洁的本地化工作台菜单名，并删除窗口内重复工具栏。
- 未选择工作区时禁止首次引导进入下一步。
- 更新白色圆角桌面图标，保留上游黑色鱼形标识。

## 0.1.0-community.3 - 2026-08-25

- 统一该版本使用的桌面产品标识。
- 本地和 GitHub 发行包名称从 Tauri 产品配置派生，不在构建脚本中重复维护产品名。

## 0.1.0-community.2 - 2026-08-25

- 使用统一的跨平台认证加密凭据库替代系统钥匙串，消除重复授权弹窗。
- 不再把所有 Provider 认证失败都描述为 API Key 无效，并从普通对话视图隐藏面向模型的沙箱策略文本。
- 修复 Cordis 通过 Proxy 包装服务时的 Credential Provider 调用。
- 新建自定义 Provider 的凭据保存失败时自动回滚该 Provider。
- 明确展示给模型的沙箱与审批策略上下文。
- 从持久化工作区重试 Harness 早期失败，使重复启动具备幂等性，并在状态切换时抑制重复操作。
- 在 Shell 页面切换时清除页面专属操作提示。
- 关闭受管工作台输入框的拼写检查、自动纠错、首字母大写和写作建议，不修改用户输入值。
- 增加随包凭据库 helper、明文泄漏检查、Harness 补丁和 Provider 回归检查。

## 0.1.0-community.1 - 2026-08-24

- 新增独立的 Vue 3 与 Tauri 2 桌面 Shell。
- 新增固定版本 Harness 与 Node.js staging 流程。
- 新增 Harness 监管、恢复、进程树清理和回环就绪检查，包括 Rustls Provider 显式初始化、panic 恢复和 Windows Node 模块路径规范化。
- 新增操作系统钥匙串 Credential Provider 和脱敏诊断。
- 新增 `zh-CN`、`zh-TW` 和 `en-US` Shell 国际化。
- 新增 macOS、Windows 和 Linux 社区版构建工作流。
- Shell、favicon、应用、安装包和平台图标统一使用固定上游提交中的鱼形标识和主墨色。
- macOS arm64 DMG 完成 ad-hoc Bundle 签名、隔离安装、真机启动、正常退出和 100 次 Harness 启停验证。
- Windows x64 NSIS 安装包通过 Windows 11 ARM64 的系统 x64 兼容层完成校验和、安装、启动、窗口响应、正常退出、孤儿进程清理、卸载、重装和再次启动验收。
