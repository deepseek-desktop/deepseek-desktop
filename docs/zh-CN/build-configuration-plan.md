# 桌面构建配置

> 本文描述当前已实现的构建契约。所有生成文件位于 `target/`，不提交 Git。

## 目标

为桌面发行版提供单一、可选的 `.env` 配置入口。开发者无需搜索和修改 TypeScript、Rust、Tauri 或 Runtime 源码，即可替换应用名称、版本、标识符、图标以及 Harness Runtime 来源。

配置遵循以下优先级：

```text
命令行环境变量 > 项目根目录 .env > 内置默认值
```

项目没有 `.env` 时，构建结果必须与当前 DeepSeek Desktop 默认发行版保持一致。`.env` 只在开发和构建阶段读取，不得复制进 Runtime、安装包、诊断包或发布产物。

## 已完成治理

- 应用名称、版本、Identifier、描述、作者和图标由统一配置加载器解析。
- `src-tauri/icons/icon.png` 是唯一人工维护的源图，各平台图标生成到 `target/generated/branding/icons/`。
- Harness 仓库和 ref 会参与真实源码构建；CLI workspace 包名和 `bin.dsh` 入口从 manifest 动态解析。
- 稳定工具链事实与动态 Runtime 来源分离，安装包附带可追溯的 `BUILD-INFO` 和 SHA-256。

## 配置文件

仓库提交 `.env.example`，本地 `.env` 保持 Git 忽略。变量名称使用中性前缀，避免定制发行版仍被迫保留原品牌名称。

```dotenv
# 应用信息
DESKTOP_APP_NAME=DeepSeek Desktop
DESKTOP_APP_VERSION=0.1.0-community.10
DESKTOP_APP_IDENTIFIER=deepseek.desktop
DESKTOP_APP_SLUG=deepseek-desktop
DESKTOP_APP_DESCRIPTION=Local AI agent workspace
DESKTOP_APP_AUTHORS=DeepSeek Desktop Contributors
DESKTOP_APP_ICON=src-tauri/icons/icon.png

# Harness Runtime 来源
HARNESS_REPOSITORY=https://github.com/deepseek-desktop/deepseek-harness.git
HARNESS_REF=dsh-v0.1.1-rc.2
```

内置默认值与上述示例保持一致，但不能通过读取 `.env.example` 获得默认值；默认值应由统一配置加载器持有，确保删除 `.env` 和 `.env.example` 后仍能正常开发、测试和打包。

`.env` 解析优先使用 Node.js 24 标准能力，不为简单键值配置新增 dotenv 运行依赖。配置加载器只读取已声明变量，忽略宿主环境中的无关变量，并对未知的 `DESKTOP_APP_*`、`HARNESS_*` 变量给出明确错误，防止拼写错误被静默忽略。

## 统一配置加载

构建期配置加载器负责：

1. 建立内置默认配置。
2. 在 `.env` 存在时读取文件值。
3. 使用命令行环境变量覆盖同名 `.env` 值。
4. 规范化路径、仓库地址和字符串。
5. 校验全部字段并输出 resolved configuration。
6. 对外提供同一份只读配置，禁止各脚本重复读取和解释 `.env`。

构建期统一生成以下文件，不修改手写源码：

```text
target/generated/app-config.json
target/generated/tauri.conf.json
target/generated/branding/
target/generated/runtime-source.json
target/generated/runtime-lock.json
```

`app-config.json` 是本次构建解析后的应用事实，供 Vite、Rust build script、打包脚本、发布门禁和 `BUILD-INFO.<target>.json` 使用。生成文件不得提交 Git。

## `app:sync` 命令

可用命令：

```bash
corepack pnpm@11.7.0 app:sync
corepack pnpm@11.7.0 app:sync --check
```

`app:sync` 执行以下工作：

- 解析并校验应用配置。
- 生成 Tauri 构建覆盖配置，包括产品名称、版本、Bundle Identifier、窗口标题、描述、版权和安装包元数据。
- 向前端构建注入名称、版本、描述和 slug，前端国际化文案通过占位参数引用应用名称，不再硬编码品牌。
- 向 Rust 构建注入应用信息，原生菜单、关于窗口和错误上下文不再硬编码品牌。
- 根据单一源图生成 macOS ICNS、Windows ICO、Linux PNG、Windows Tile 和 Tauri 所需尺寸图标。
- 将最终配置摘要写入 `target/generated/app-config.json`。

`app:sync --check` 在系统临时目录中生成并验证配置，不修改工作区，供 CI 和提交前检查使用。

### 字段校验

- `DESKTOP_APP_NAME`：非空，不允许控制字符。
- `DESKTOP_APP_VERSION`：必须是合法 SemVer，可包含 `community.9` 等预发布标识。
- `DESKTOP_APP_IDENTIFIER`：必须符合反向域名格式；发布后修改会改变应用数据目录和升级识别，构建时应显示醒目提示。
- `DESKTOP_APP_SLUG`：只允许小写字母、数字和连字符。
- `DESKTOP_APP_ICON`：相对项目根目录解析，必须存在、为正方形 PNG，至少 `512 x 512`，建议使用 `1024 x 1024`。
- `DESKTOP_APP_AUTHORS`：按逗号解析为作者列表，去除空白项。

源图是唯一人工维护的图标文件。`src-tauri/icons/` 中的多尺寸文件应改为生成产物，或者由构建脚本在打包前覆盖并验证，开发者不再手工维护 ICO、ICNS 和多份 PNG。

## `runtime:sync` 命令

可用命令：

```bash
corepack pnpm@11.7.0 runtime:sync
corepack pnpm@11.7.0 runtime:sync --check
corepack pnpm@11.7.0 runtime:sync --local /absolute/path/to/deepseek-harness
```

`runtime:sync` 让 `HARNESS_REPOSITORY` 真正决定打包内容，而不只是修改来源说明：

1. 获取 `HARNESS_REPOSITORY` 指定仓库的 `HARNESS_REF`。
2. 将 tag、分支或 ref 解析为不可变 commit。
3. 按 Harness 约定构建桌面生产 Runtime 制品。
4. 校验主包、CLI 入口、Web 工作台和桌面兼容契约。
5. 计算制品 SHA-256、依赖完整性和许可证信息。
6. 自动生成 `target/generated/runtime-lock.json`。
7. Runtime staging 只消费经过校验的锁定制品。

正式发布不得直接跟随未锁定分支。即使 `.env` 中填写分支名，发布产物也会记录实际 commit 和完整性哈希。`--local` 仅用于定制 Harness 本地联调；社区和正式发布门禁会拒绝脏工作区或无法追溯的本地制品。

定制仓库应尽量保留 Harness 原有 workspace 包名、CLI 入口和桌面 Runtime 输出契约。同步器从 CLI workspace manifest 动态解析实际包名和 `bin.dsh` 入口，不依赖固定的 `@deepseek-ai/dsh/lib/bin.js` 路径。生成 Runtime 前还会清理旧 staging，并移除构建源码中的本机绝对路径，防止历史制品或本地路径混入安装包。

## 一键打包集成

当前平台的一键打包入口不绑定发行通道名称：

```bash
corepack pnpm@11.7.0 desktop:package
```

该命令是普通开发者制作定制安装包的首选入口。它读取可选 `.env`，在当前操作系统和架构上完成配置解析、Runtime 同步、全部发布门禁和原生安装包构建。单台主机只构建当前原生目标，不能把 macOS 本机打包成功表述为 Windows 或 Linux 已完成构建。

社区发行维护者仍可执行：

```bash
corepack pnpm@11.7.0 package:community
```

`package:community` 复用 `desktop:package` 的同一实现，只额外固定 `community` 发布通道和对应发布门禁，不维护第二套安装、测试或打包逻辑。

`desktop:package` 按顺序自动执行：

1. 安装固定工具链和依赖。
2. `app:sync`。
3. `runtime:sync`。
4. 发布门禁、单元测试、端到端测试和 Runtime smoke。
5. Tauri 原生打包。
6. 安装包、完整性文件和构建信息生成。

打包脚本不得要求开发者预先手动同步配置。单独保留分步骤命令，方便开发阶段快速检查和定位错误：

```bash
corepack pnpm@11.7.0 app:sync
corepack pnpm@11.7.0 runtime:sync
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 test:e2e
corepack pnpm@11.7.0 runtime:smoke
corepack pnpm@11.7.0 tauri:build
```

命令职责保持单向组合：底层分步骤命令不调用一键命令，`desktop:package` 负责编排底层命令，`package:community` 只向同一编排入口传递发行通道参数。

## 生成目标与代码治理

以下硬编码入口已经统一治理：

- `package.json` 和 Runtime workspace 包版本。
- `src-tauri/tauri.conf.json` 的产品名称、版本、Identifier、窗口标题、描述、版权和图标。
- `src-tauri/Cargo.toml` 中影响发行的版本和描述；Rust crate 内部名称不属于用户可见品牌，无需为定制发行动态重命名。
- `src/i18n/messages.ts` 中的应用名称和欢迎、关于文案。
- `src-tauri/src/native_menu.rs` 中的应用名称、关于和退出文案。
- `index.html` 标题。
- 前端 Mock、单元测试和 Playwright 断言中的固定版本与名称。
- `runtime/toolchain-lock.json` 中的稳定 Node、原生依赖和桌面补丁事实，以及 `target/generated/runtime-lock.json` 中的 Harness 来源、commit、入口和制品哈希。
- `scripts/package-community.mjs`、发布门禁和 GitHub Actions 中的版本与产品名称读取方式。

`app:sync` 不改写 README 或手写说明正文。动态发行事实写入生成配置、Runtime lock 和 `BUILD-INFO.<target>.json`。

## 发布追溯

`BUILD-INFO.<target>.json` 至少记录：

```json
{
  "schemaVersion": 1,
  "application": {
    "productName": "DeepSeek Desktop",
    "version": "0.1.0-community.10",
    "identifier": "deepseek.desktop",
    "slug": "deepseek-desktop",
    "description": "Local AI agent workspace",
    "authors": ["DeepSeek Desktop Contributors"]
  },
  "desktop": {
    "commit": "desktop repository commit",
    "dirty": false
  },
  "harness": {
    "repository": "https://github.com/deepseek-desktop/deepseek-harness.git",
    "requestedRef": "dsh-v0.1.1-rc.2",
    "commit": "resolved immutable commit",
    "packageName": "@deepseek-ai/dsh",
    "version": "0.1.1-rc.2",
    "sha256": "resolved runtime digest"
  },
  "target": "target triple",
  "channel": "community"
}
```

发布构建必须满足：

- 桌面版本在 resolved config、Tauri bundle、Runtime manifest 和 `BUILD-INFO.<target>.json` 中一致。
- Git tag 与解析后的桌面版本一致。
- Harness commit 和 Runtime hash 可追溯。
- 安装包内不存在 `.env`、本地路径、访问令牌或本地 Harness 工作区。
- 图标在 macOS 应用、DMG、Windows EXE、开始菜单、桌面快捷方式和 Linux 安装包中均可正常显示。

## 验证范围

### 配置加载

- 无 `.env` 时解析为当前默认发行配置。
- `.env` 能覆盖所有声明字段。
- 命令行环境变量能覆盖 `.env`。
- 未知变量、空值、非法版本、非法 Identifier、非法 slug 和缺失图标均明确失败。
- 路径包含空格、中文和 Windows 分隔符时仍能正确解析。

### 应用同步

- 三语 Shell、窗口标题、原生菜单、关于页、安装包名称和版本保持一致。
- 替换一张源图后，各平台图标完整生成且非透明空白图。
- `app:sync --check` 不产生工作区改动。
- `.env` 不出现在 `dist`、Runtime staging、安装包和诊断包中。

### Runtime 同步

- 默认仓库和 ref 能重现当前 Runtime。
- 替换为测试 fork 后，安装包内确实运行 fork 的可识别版本，不能仍回退到官方 npm 制品。
- 无效仓库、无效 ref、入口缺失和完整性不匹配均立即失败。
- 本地模式可联调，但正式发布门禁拒绝不可追溯制品。

### 平台验收

- 当前 macOS arm64 已完成真实 DMG 构建；安装与启动体验由对应平台的人工验收确认。
- macOS x64、Windows x64 和 Linux x64 由 GitHub Actions 原生矩阵调用同一构建链路；只有对应平台工作流及人工安装验收通过后，才能声明该平台可用。
- Windows 验收包括安装器、EXE、桌面快捷方式和开始菜单图标，以及启动时不附带终端窗口。
- Linux 验收包括 AppImage、deb、图标和 desktop entry。

## 完成标准

- 开发者只修改可选 `.env` 和一张源图即可生成定制安装包。
- 删除 `.env` 后能够构建与当前默认值一致的 DeepSeek Desktop。
- `desktop:package` 自动完成配置解析、Runtime 锁定、验证和当前平台打包。
- `package:community` 复用同一打包实现并增加社区发行门禁，不形成重复流水线。
- 应用名称、版本和图标不再要求修改业务源码。
- `HARNESS_REPOSITORY` 和 `HARNESS_REF` 真正控制打包的 Runtime。
- 发行产物包含完整、不可变、可校验的桌面与 Harness 来源记录。
- 相关单元测试、Playwright、Runtime smoke 和当前平台安装验收全部通过。
