# 同舟 · dsh-codex-bridge

[English](README.en.md)

让本机 Codex 与 DeepSeek Harness（DSH）通过具名消息讨论、复核方案，并在两侧查看同一份讨论记录。DSH 插件包含完整的本机服务和阅读页面，不需要另外下载开发者工作区。

## 首版支持

- macOS，DSH Desktop **0.2.2-rc.1**；目前对其他 DSH 版本明确报出未验证状态。
- 本机 Codex CLI 或带 Codex CLI 的桌面应用，已使用用户自己的账号登录。未接入 Codex 时可以打开同舟、整理议题和阅读记录；双 Agent 讨论需要两端都就绪。
- 开发/命令行运行需要 Node.js **24.9.0 或更新版本**；测试环境为 Node.js 26。DSH Desktop 加载插件时使用其宿主运行时。

这是一款社区插件，与 OpenAI、DeepSeek 无隶属关系。它不会代装 Codex、复制登录状态或提供共享账号。模型调用按各自产品的账号与使用规则计费。

## 安装

1. 从本仓库 [Releases](https://github.com/PhoenixQian/dsh-codex-bridge/releases) 下载 `dsh-codex-bridge-0.3.0.tgz`。
2. 在 **DSH Desktop 的插件管理器**中安装该包并启用。安装到桌面 profile；Web profile 不会出现在桌面侧栏。
3. 打开 DSH 侧栏的【同舟】。插件会启动只监听 `127.0.0.1:32719` 的本机服务，不会因此发起模型调用。
4. 点击侧栏【接入本机 Codex】检查状态，再点【一键接入 Codex】安装协作技能。Codex 需要事先安装并登录；如果自动发现失败，可指定本机可执行文件路径。
5. 在 Codex 中说“通过同舟和 DSH 讨论……”，或明确调用 `$tongzhou-collaboration`。若当前会话未发现新技能，重新打开会话或重启 Codex。

技能只安装到 `~/.agents/skills/tongzhou-collaboration/`，不修改全局 `AGENTS.md`、Codex 模型配置或账号。已存在的不同技能不会被静默覆盖。DSH 插件自身即可显示同舟，Codex 侧无需另装 DSH 插件。

市场目录收录需由社区维护者审核；正式收录后可从 dshmarket 直接安装。Release 包可独立安装，不要求 npm 账号。

## 使用

新建议题，写明问题、背景、成员和最大往返次数，再点击开始。新建记录和打开页面都不会自动调用模型。主 Agent 可在答案充分时提前结束；用户可以暂停或补充要求。

- Codex 与 DSH 的消息分别署名，用户审阅意见单独记录。
- 同舟讨论复用独立桥接会话，不把后台来信注入当前 Codex 主聊天。
- DSH 的桥接原生会话属于【同舟】工作区，默认显示易读的讨论正文；可切回原生协议记录。
- 健康检查在线仅表示服务/Host 就绪；最终结论应以实际回复和回执为准。
- 讨论成员只能使用明确开放的只读检索工具；来信和引用文件不会扩大用户授权，也不会自动写入长期记忆。

若需要执行任务，请在任务页选择工作目录并查看授权范围。任务使用 macOS 沙箱；不支持的环境会明确停用，不会自动降级成不受限制的执行。Python 为可选能力，需要配置独立解释器；插件不会安装 Python、Conda、系统组件或下载依赖。

## 数据与配置

代码与用户数据分离。默认数据目录为 `~/.dsh/tongzhou/`；若设置 `DSH_HOME`，则为 `$DSH_HOME/tongzhou/`，也可用 `TONGZHOU_DATA_DIR` 指定。

原生压缩日志的补充阅读需要支持拼接 Zstd 帧的运行时；宿主不支持时会明确提示，同舟共享正文仍可阅读。

讨论、会话映射和交付状态保存在本机；模型请求仍发送给用户已配置的 Codex / DSH 服务。安装包不包含作者的讨论记录、密钥、会话、日志或个人路径。插件不读取或复制 `auth.json`，也不接收用户在聊天中粘贴密钥。Codex 登录状态通过其原生命令查询。

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `TONGZHOU_DATA_DIR` | 同舟可写数据目录 |
| `TONGZHOU_CODEX_CLI` | Codex CLI 的绝对路径 |
| `TONGZHOU_DSH_RESOURCES` | 非标准 DSH Desktop 安装的 Resources 路径 |
| `TONGZHOU_DSH_EXECUTABLE` | 非标准 DSH Desktop 可执行文件 |
| `TONGZHOU_PYTHON_CODEX` / `TONGZHOU_PYTHON_DSH` | 可选独立 Python 解释器 |
| `TONGZHOU_PYTHON_CODEX_PREFIX` / `TONGZHOU_PYTHON_DSH_PREFIX` | 对应独立 Python 环境目录 |

首版一台机器只支持一个同舟实例，固定端口 `32719`。如端口已被其他安装占用，请先关闭另一实例；插件会报告冲突。嵌入页还会通过 DSH 原生连接核对安装与数据目录的非密钥指纹；身份不匹配或无法核实时不显示页面，也不会自动切换原生会话。

## 排查与卸载

- 页面离线：确认 DSH 插件已启用；检查数据目录中的 `web-service.log`。反馈问题时请先移除消息正文、路径和账号信息。
- Codex 未发现：先确认原生 Codex 能正常运行并登录，再填写可执行文件路径。插件不会把缺失认证自动替换成 API key 或其他账号。
- DSH 未就绪：检查同舟中的 Host 状态和支持版本；不要用“服务在线”代替真实回复验证。
- 卸载：在 DSH 插件管理器停用/卸载。讨论数据不会自动删除；确认不再需要后可自行删除同舟数据目录。若不再使用 Codex 技能，可删除 `~/.agents/skills/tongzhou-collaboration/`。保留的独立本机服务可在退出 DSH 后按数据目录的运行状态确认并停止。

## 开发

本仓库只包含可发布源码。DSH 宿主模块由已安装的 DSH Desktop 提供，未打包进本插件；插件没有安装脚本。

```sh
npm test
npm run check
npm pack --ignore-scripts
```

测试使用临时数据目录，不应连接或改动日常实例。提交前检查 tarball 的文件清单，确认未包含运行状态或个人数据。发布包可以在临时目录解包后启动服务进行验证。

## 许可证

[MIT](LICENSE)
