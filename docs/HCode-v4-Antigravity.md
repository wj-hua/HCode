# HCode v4：接入 Antigravity CLI（agy）

## 目标
在 v3（Claude Code + Codex + StepCode）基础上接入 Google Antigravity 的命令行 `agy`，支持文字与图片输入，
与其他 CLI 共用项目列表、会话历史、时间线卡片与输入框。

## 接入方式
| 功能 | 做法 |
|---|---|
| 会话列表 | 遍历 `~/.gemini/antigravity-cli/brain/<会话>/.system_generated/logs/transcript_full.jsonl`；工作区读 `conversation_summaries.db` 的 `workspace_uris`，没有时读 `conversations/<会话>.db` 里 `trajectory_metadata_blob` 中的 `file://` 路径（用 Node 自带的 `node:sqlite` 只读打开）。没有工作区的会话无法归到项目，不列出 |
| 标题 / 重命名 | `annotations/<会话>.pbtxt` 的 `title`（agy 自己改名写这里）> 摘要库 title > 第一条用户消息；HCode 改名写 pbtxt，并同步摘要库 |
| 历史内容 | transcript 每行一个 step：`USER_INPUT`（取 `<USER_REQUEST>` 内的原文）、`PLANNER_RESPONSE`（thinking / content / tool_calls）、`GENERIC`（按顺序对应工具结果）、`CHECKPOINT`（压缩） |
| 新建 / 续聊 | 每个 HCode 会话一个 `agy --add-dir <项目> [--conversation <id>] --input-format stream-json --output-format stream-json -p=` 进程，stdin 每行 `{"event":"user","message":{...}}` 跑一轮，进程在轮次之间保持 |
| 流式输出 | `init`（conversation_id）、`step_update`（agent_response 的 text_delta / thinking_delta，tool 的 parameters / output）、`result`（一轮结束，含 error、denied_actions） |
| 停止 | 发 SIGINT（agy 结束当前轮后退出），下次发送用 `--conversation` 重启续上 |
| 模型列表 | `agy models`（每行 “id<TAB>名称”），发送时 `--model <id>` |

`--add-dir` 必须带：项目目录不在 agy 的信任列表里时，agy 不设工作区，命令会跑在它的 scratch 目录，会话也记不下工作区。该参数只对本次运行生效，不改 agy 的 settings.json。

## 图片输入
agy 的 stream-json 输入只接受文字块（`image` 块会报 “only text”），`@路径` 在无头模式下也不会附加图片。
所以按 agy 自己粘贴图片的做法：把图片写到 `brain/<会话>/.user_uploaded/uploaded_media_*.png`，
在消息末尾附上与 agy 相同格式的说明 “The user has uploaded N image(s): - 路径”，模型会用 `view_file` 读图。
历史里的图片（agy 原生的 `media` 字段和 HCode 附的说明）都还原为缩略图，说明文字不显示。

## 权限模式
无头模式（`-p`）不能交互审批：需要确认的操作由 agy 自动拒绝，一轮结束时 HCode 列出被拒绝的操作（`denied_actions`）。
| HCode | agy 启动参数 |
|---|---|
| 按 agy 设置（默认） | 无，遵循 agy 的 settings.json 权限规则 |
| 自动接受编辑 | `--mode accept-edits` |
| 完全放行 | `--dangerously-skip-permissions` |

计划模式在无头下会自动通过计划审阅，不提供。权限模式、模型中途切换后，下一次发送时重启进程续上同一个会话。

## agy 工具 → ZCode 卡片
| agy 工具 | 卡片 |
|---|---|
| view_file | Read |
| write_to_file | Write |
| replace_file_content / multi_replace_file_content | Edit |
| run_command | Bash（toolSummary 作为说明） |
| grep_search | Grep |
| find_by_name / list_dir | Glob |
| search_web | WebSearch |
| read_url_content | WebFetch |
| 其他 | 原名，通用卡片 |

## 实测（本机 agy 1.2.9）
- 列出 163 个有工作区的会话首次约 0.46 秒，之后按缓存约 8 毫秒。
- 新建会话发图片：模型用 view_file 读到图片并正确回答颜色；工具卡片、流式正文正常；停止后当前工具显示为已取消。
- 续聊历史会话（切换模型、自动接受编辑）：进程重启并续上原会话，模型记得前文图片。
- 重新打开历史：图片缩略图还原，附带的说明文字不显示；改名后列表标题更新。

## 已知限制
- 没有审批卡片（agy 无头模式不支持），需要确认的操作会被拒绝，可切到“自动接受编辑”或“完全放行”。
- 流式事件里 write_to_file 等工具的参数可能不完整，一轮结束后重新打开历史可看到完整内容。
- 版本号 0.4.0。
