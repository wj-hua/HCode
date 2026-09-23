# HCode v3：接入 StepCode CLI

## 目标
在 v2（Claude Code + Codex）基础上接入 StepCode（`step`，阶跃星辰基于 pi 的编程 CLI），三者共用同一套项目列表、会话历史、时间线卡片、审批卡片与输入框。

## 接入方式
| 功能 | 做法 |
|---|---|
| 会话列表 / 历史内容 | 读 `~/.stepcode/agent/sessions/*/*.jsonl`（step 没有列会话的 RPC 命令；格式见 step 自带的 `docs/session-format.md`）。尊重 `STEP_CODING_AGENT_DIR` / `STEP_CODING_AGENT_SESSION_DIR`。会话是一棵树，展示最后一条条目所在的分支 |
| 新建 / 续聊 | 每个 HCode 会话起一个 `step --mode rpc` 进程（续聊加 `--session <文件>`），发 `prompt` |
| 停止 | `abort` |
| 重命名 | `set_session_name`（会话不在运行时临时起一个进程） |
| 模型列表 | `get_available_models`，取值 `provider/id` |
| 流式输出 | `message_update`（text / thinking / toolcall 增量）、`message_end`（以它为准）、`tool_execution_update`、`agent_settled`（一轮结束） |
| 审批 / 提问 | `extension_ui_request`：`confirm` 是工具审批（标题 `Approve <tool> [id]`，正文第一行 `Call: <toolCallId>`）；`select` / `input` / `editor` 显示为问答卡片 |

`step` 优先用 `~/.stepcode/bin/step`，避免和同名的 smallstep 命令混淆。

## 权限模式与模型
| HCode | step 启动参数 | step 预设 |
|---|---|---|
| 逐条审批（默认） | `--approval-mode confirm` | ask |
| 只读 | `--approval-mode strict` | read-only |
| 自动执行 | `--approval-mode auto` | bypass（危险命令仍会询问） |

step 的 `/permissions` 会改写全局 `~/.stepcode/config.toml`，所以不用它；权限模式、模型都在启动参数里指定，
中途切换后，下一次发送时用 `--session` 重启进程续上同一个会话文件。

审批：允许 → `confirmed: true`；拒绝 → `confirmed: false`，附带的理由用 `steer` 发给模型；
“本会话总是允许”由 HCode 记住工具名，之后同名工具的普通审批自动通过（危险命令仍会询问）。

`clarify_user` 工具只能在 step 的终端界面里用，RPC 下会直接报错，所以启动时加 `--exclude-tools clarify_user`，模型会改为直接用文字提问。

## step 工具 → ZCode 卡片
| step 工具 | 卡片 |
|---|---|
| read_file | Read |
| write_file | Write |
| edit_file | Edit（search / replace → old_string / new_string）|
| run_command | Bash |
| search_files | Grep |
| find_files / list_directory | Glob |
| search_web | WebSearch |
| task_update / task_list（结果带任务清单） | TodoWrite |
| 其他 | 原名，通用卡片 |

## 实测（本机 step 0.1.0）
- 列出 9 个会话约 16 毫秒，全部投影共 485 行。
- 新建会话：write_file / run_command 审批卡片 → 允许；“本会话总是允许”后同名工具不再询问。
- 切换到只读模式后再发送：进程重启并续上原会话，模型记得上文。
- 重命名后列表标题更新；重新打开历史，卡片与实时一致。
- 启动参数不会改动 `~/.stepcode/config.toml`。

## 发布
- 版本号 0.3.0，安装包 `release/HCode-0.3.0-arm64.dmg`（本地未签名）；打包版在最小环境变量下启动实测可同时识别 claude、codex 与 step，并能拉取 step 模型列表。

## 未做 / 已知限制
- step 的计划模式（`/plan`）在 RPC 下会自动退出、不等待批准，暂不接入。
- 子 agent（subagent）只显示为通用工具卡片。
- 图片输入仍不支持。
