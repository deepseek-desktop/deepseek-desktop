# 第三方软件声明

安装包中的 Harness 包含锁定版本的上游 Harness 和 Node.js，两者均按 MIT License 分发。

- Upstream Harness `0.1.5-rc.2`: <https://github.com/deepseek-ai/deepseek-harness>
- Node.js `24.20.0`: <https://github.com/nodejs/node>；官方归档许可证随包保存在 `licenses/node-LICENSE.txt`。
- npm `11.19.0`：随上述经 SHA-256 校验的 Node.js 官方归档提供，用于本机源码候选中的原生平台包发布文件装配；许可证保存在 `licenses/npm-LICENSE.txt`。

构建流程会把完整的生产依赖许可证清单和校验和写入每个 Harness 暂存目录。DeepSeek Desktop 源代码按 Apache-2.0 许可证发布。
