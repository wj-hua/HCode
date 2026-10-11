# HCode 多 AI 协作：S1b 当前 Codex 会话委派 Claude

日期：2026-10-11。开发分支：`codex/multi-ai-collaboration-plan`。S1b 已实现并通过真实原生闭环和桌面开发版验收：当前 Codex 会话调用宿主委派工具，Claude 在隔离副本实现，独立 Codex 审查，阻塞意见回到原 Claude 修订，复验和复审后原 Codex 会话汇总。复用 S0–S2/S5a 的协作与代码交付规则。

## 使用入口与产品边界

新建 Codex 会话，先打开“多 AI 协作”，选择只读调研或隔离代码交付。默认执行者为 Claude，审查者为独立 Codex 会话；代码模式仍需确认检查计划。当前会话决定发起者身份，执行会话与审查会话单独创建；发起和汇总保持同一 Codex 原生线程。

本机 Codex 0.162.0 只能在 `thread/start` 注册 `dynamicTools`，`thread/resume` 不支持新增工具。已发送普通消息且未注册委派工具的旧线程，界面明确提示“请在新建 Codex 会话发送普通消息之前启动协作”，保留原线程与历史。具有匹配工具目录的线程可恢复；缺工具或工具契约变化不能以 resume 成功冒充兼容。

代码通过后仍为待采纳候选，没有写回原项目的入口。本切片不接入 agy/Gemini、不实现专家互审、采纳、多写任务或自动发布，也不修改全局 MCP/CLI 配置、已安装 HCode 或 A10 历史备份。

## 模块职责与协议约束

| 模块 | 职责与验证边界 |
| --- | --- |
| `collaborationCapabilities.ts`、共享 Source/IPC 契约 | 分开核验后端执行能力和当前线程发起资格；查询只读，不启动模型或替换线程 |
| `CollaborationPanel` | 使用当前会话身份查询能力，Codex 默认委派 Claude，显示独立 Codex 审查；旧线程原因直接呈现 |
| `CodexAgent`、`CodexSession` | 复用原生线程配置协作运行时，新建时注册工具，恢复时核验工具目录；结束协作后清除宿主运行时，下一普通回合恢复原权限模式 |
| `toolCatalog.ts` | 通过服务端 `thread/read` 返回路径读取创建元数据，限制在实际 CODEX_HOME 内，核验线程 ID、工具名称/描述/schema；不扫描任意用户文件 |
| `HostedToolCalls` | 按 threadId/turnId/callId 绑定运行时，按 JSON-RPC 请求 id 回复；同调用重复请求共用一次真实执行，冲突、越界及未知工具拒绝 |
| `researchTools.ts` | 将同一宿主工具定义转为 Codex 动态工具；严格校验参数，成功/失败按 `success` 与 `contentItems/inputText` 返回 |
| `CollaborationService`、`RunExecutor` | 允许已验证的 Claude/Codex 发起；按选定执行者运行任务，独立审查与汇总使用当前发起者后端，沿用现有 Delivery、Review 与预算状态机 |

协议以本机生成的 0.162.0 实验 schema 和实际回合为准。工具创建字段与恢复字段已分别核对；协议源参考 [Codex app-server thread 定义](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)，上游变化不能替代本机准入验证。

宿主工具不能自行指定其他 Run、任意执行者权限或 shell 命令。重复调用重放同一结果；每回合最多 128 个调用。取消先终止宿主等待并拒绝迟到结果，再沿用原生中断和回合终态确认。迟到的 turn/start 响应或通知不能重开已取消工具作用域。旧回合、跨线程、未知命名空间、额外参数均不执行。工具取消不代表原生进程已停止，工作区锁继续遵循 S2/S5a 规则。

## 真实阻塞、修订与复审

显式运行 `nativeCodeDelivery.test.ts` 的 Codex 发起用例，耗时 182 秒。完整目标要求任何 `divisor === 0`（含 0/0、负数除零和 -0）抛 RangeError，普通除法不变。验收仅收窄执行者首轮任务以种入遗漏，审查者读取完整目标和真实冻结文件，未预置或替换审查结论。

Run：`4103c2f6-9b27-4473-99a7-ac0ed23cedc2`。

| 原生身份/候选 | 实际结果 |
| --- | --- |
| 发起 Codex `01a12a68-b71b-7ad0-9d41-b7853cd5ef40` | 实际调用委派和等待工具，后续汇总及 Provider 重建后的汇总沿用同一原生线程 |
| 执行 Claude `62565ee6-2c95-4d56-94de-bb4248b1f23c` | 首版只处理正数除零；收到阻塞意见后，同一执行会话修订实现和测试 |
| 候选 v1 `389d99b5-858d-4b8f-89d4-01e5d74a3846` | 仅修改实现；真实 Node 检查通过，但既有测试不足以发现完整目标的遗漏 |
| 独立 Codex `01a12a69-4a5a-7ff0-b55e-ba24df5682c8` | 两条阻塞：除零处理不完整、缺少边界回归测试；交付不接受 |
| 候选 v2 `6ad1f3ed-eee0-4754-8be5-55498aa0cd0c` | 实现和测试均修订，宿主实际检查通过 |
| 独立 Codex `01a12a6a-146c-76f2-a61d-5f3c1e4f6689` | v2 approved，无遗留意见 |
| 重建 Provider 后独立 Codex `01a12a6a-bd4b-7230-b478-bf00fff680f3` | 显式再次检查/审查 v2，通过；新审查线程，原发起线程保持不变 |

共 8 个协作原生回合成功。之后使用重建后的 Provider 在原发起 Codex 线程发送普通消息，实际返回“S1b普通会话恢复成功”，nativeSessionId 保持不变。验收断言同一执行者修订、审查者身份独立、冻结版本对应检查记录以及原项目内容/文件权限不变；dirty/untracked 上下文保留。

真实记录、冻结历史及检查结果保存在 `/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s1b/`。普通消息恢复验证使用原生会话记录及执行终态，不计入 Run 的 8 个协作回合。

## 桌面开发版验收

在独立测试项目 `hcode-s5a-ui-fixture` 新建 Codex 会话，从“多 AI 协作”确认代码目标和检查计划后启动。界面实际显示 Claude 执行、独立 Codex 审查；原 Codex 历史中出现 `Hcode_delegate_task` 和 `Hcode_wait_tasks` 工具记录。

Run：`6c24ea73-70cd-46c4-afb0-ad21f82b7fcc`。发起 Codex：`01a12a6d-bc52-75a2-93c0-dfc4a27fa798`；执行 Claude：`bca499d8-ed78-4692-9d8e-de2c535c7d10`。Claude 修改实现及测试两文件，宿主运行确认过的 pnpm test，14 项测试通过，独立 Codex approved。

在发起者汇总阶段点击“暂停并接管”，原生汇总回合实际取消。随后选择“重新验证并审查候选”，宿主再次运行检查（14 项通过），另一独立 Codex 复审通过，原 Codex 线程完成汇总。最终 Run completed、交付 accepted、候选“验证与审查通过 · 待采纳”；累计 6 回合，其中第 4 个汇总 cancelled，其余成功，取消记录保留。

最终汇总“失败：记录中无失败”的模型文本不能代替原生终态：界面原生历史明确显示第 4 回合已停止。本次验收以宿主记录为准；暂停不是失败的自动续跑，也不抹除取消历史。汇总同时指出若干边界组合未单独覆盖，14 项测试通过不能证明所有输入组合已覆盖。

原测试项目 4 个文件逐项核对 SHA-256 与权限，均与冻结基线一致。UI Run、事件、冻结历史和检查记录归档到 `/Users/geraldgan/Documents/Codex/2026-10-11/hcode-ui-s1b-final/`；原开发版记录保留在 `~/Library/Application Support/HCode-dev/collaborations/`。

另选择已有普通 Codex 会话，打开协作面板，实际显示缺少 HCode 委派工具的限制原因；没有执行旧提示词、创建替代线程或改变历史。返回已完成的 Codex 协作线程，工具资格和待采纳结果仍正常显示。

## 检查命令与验证缺口

项目检查全部通过：`pnpm typecheck`、`pnpm test`（189 通过，7 个原生用例默认跳过）、`pnpm build`、`git diff --check`。新增行为覆盖包括 Codex→Claude 复用交付流程、工具重复/冲突/作用域/取消、旧线程拒绝、工具目录身份/schema 核验、版本/平台准入。外部模型传输可替换，业务规则、工作区及持久化不替换。

真实 Codex 发起用例另显式执行通过（同文件原 Claude 发起用例本次跳过，已在 S5a 实际执行）：

```sh
HCODE_NATIVE_CODEX_SOURCE=1 \
HCODE_NATIVE_EVIDENCE_DIR=/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s1b \
pnpm test src/main/collaboration/__tests__/nativeCodeDelivery.test.ts
```

实际环境为 Apple Silicon macOS、Codex 0.162.0、Claude CLI 2.1.296/SDK 0.3.280、Node 24/25 与本机 pnpm。其他 OS/CLI 版本、发行签名包、真实额度耗尽、CLI 升级后的工具元数据兼容尚未验收。首版沿用 S5a 的普通 Node Git 项目准入限制；未开放移动端构建或任意大型项目。

新线程需先启动协作、旧普通线程不能补工具，这是已验证的协议限制。具有匹配工具目录的线程可重连并继续普通对话；恢复不会自动派发。下一切片按计划为 S4：复用现有 agy Provider，验证 Gemini 模型的协作执行与独立审查，然后进入专家互审。所有开发改动尚未提交、推送或发布。
