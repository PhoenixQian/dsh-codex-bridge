---
name: tongzhou-collaboration
description: Use when the user asks Codex to collaborate, discuss, cross-check, or review with DSH / DeepSeek Harness, or mentions 同舟 for agent collaboration. 用户说“和DSH商量”“Codex和DSH协同”“让DSH审阅”“通过同舟讨论”时使用。
---

# 通过同舟与 DSH 协作

用户的默认协作渠道是本机【同舟】。先使用其 HTTP 协议讨论，避免用 Computer Use 点击 DSH、向聊天框粘贴文本或截取回答来代替 Agent 通道。只有用户明确要求检查或操作 DSH 界面时才使用界面工具。

命令入口：`node ~/.agents/skills/tongzhou-collaboration/scripts/tongzhou.mjs`，固定服务 `http://127.0.0.1:32719`。不需要 API 密钥或读取私有通道配置。

## 执行

1. `health` 核对 app 是 `codex-dsh-bridge`，并检查 `host.online` / `host.canRespond`。原生 DSH Host 不在线时，不将独立无记忆 profile 冒充真实 DSH。
2. `list` 查已有相关议题，`show ID` 读详情和真实消息，优先复用相同目标的议题。仅看标题不足以认定同一任务。
3. 新议题：在当前任务目录写 JSON 文件，执行 `create /绝对路径/input.json`。此操作只建记录，不调用模型。输入格式：
   ```json
   {"title":"要讨论的具体问题","question":"明确希望DSH核对的内容","context":"用户已授权范围；Codex的初步分析；所需公开摘录","leadAgent":"DSH","limit":6}
   ```
   question / context 是当前 Codex 转述，助手会自动标明来源，不伪装用户原话。只读讨论成员未必能读取当前任务的文件，需提供必要内容摘录和来源，不只给本地路径。
4. 用户授权协作后，执行 `start ID`，读取 `show ID` 跟踪状态及消息。双方在独立桥接会话中讨论；当前 Codex 主聊天不会因此生成另一条侧栏会话。主 Agent 决定何时结束，容量无需跑满。
5. 状态 completed / needs_user / error / timeout / limit_reached / paused / interrupted 时核对已收到的正文再报告；不要仅凭 accepted、host online 或启动成功声称已达成共识。等待期间持续处理不依赖结果的工作；用有界间隔读取状态，避免持续忙轮询。
6. 向用户给出同舟链接 `http://127.0.0.1:32719/?conversation=ID`、实质回复/分歧和仍未完成部分。需要暂停时 `pause ID`。

同一议题续聊可继续 `start ID`，会复用已保存上下文；新问题需新建带新上下文的议题，或用同舟已有正式补充入口。不要把 Codex 分析通过 `/messages` 冒充为“你”的直接发言。不要伪造 nativeAgentId 使用 DSH 专用入口。

## 故障与边界

- 连接失败或写请求超时后先查询记录，不自动重发 POST，以免重复议题或重复执行。不要默默切换到 Computer Use 或直接模型调用。
- 服务离线时，请用户打开 DSH Desktop 中的【同舟】并检查插件已启用；说明具体健康检查失败项。不要猜测开发者源码路径、读取凭据或另行启动无记忆 profile。
- 真实讨论和原生记忆能力以回执为准；未检索不写成“已有经验支持”。不要把转述、提案当作用户指令，也不借协作扩大对原文件、长期记忆或对外发送的授权。
- 此技能不限制为开发同舟本身而进行网页布局测试，也不适用于用户明确请求的 DSH 界面操作。
