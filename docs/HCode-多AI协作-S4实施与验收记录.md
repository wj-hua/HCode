# HCode 多 AI 协作 S4 实施与验收记录

日期：2026-10-11。范围：现有 Antigravity CLI Provider 的 Gemini 只读执行与独立审查；复用 S1/S2/S5a/S1b 的协作工作流。测试使用真实本机登录，不改变账号、全局 MCP 或安装版 HCode。

## 1. 交付边界

- 当前 Claude/Codex 会话保持发起者身份，可选择 `agent=agy` 和明确的 Gemini modelId 执行只读研究。
- 独立审查者可单独选择 Claude、Codex、Antigravity / Gemini；默认仍是发起者品牌的独立会话。旧记录没有 reviewer 字段时保持原行为。
- Gemini 可审查只读报告及 Claude/Codex 生成的隔离代码候选。阻塞意见进入原执行者会话修订，复审使用新的独立审查会话。
- Gemini 代码写入未准入；界面和服务均拒绝将其选作代码执行者。agy 当前会话的自主委派与同会话恢复桥接未验收，不能发起本流程，也不会切换成其他品牌代发起。
- 专家流程仍归后续 S3；本切片交付其可复用的受限 Gemini 执行/审查能力，不代表专家互审已经上线。

## 2. 真实 CLI 验证与权限设计

本机 `/Users/geraldgan/.local/bin/agy` 返回版本 `1.3.3`。`agy models` 返回 TAB 分隔的实际列表；本次账户可见 Gemini 3.8/3.7/3.6 Flash 与 Gemini 3.1 Pro。界面只从实际列表筛选 Gemini，用户必须选择模型；查询失败、空列表或非法模型明确失败，不使用静态列表替代，也不自动换模型。列表可见不等于额度可用，实际回合仍需成功返回。

先用原生 stream-json 验证了当前认证、Gemini 3.1 Pro High 和 Gemini 3.8 Flash Low 的真实响应，再验证自定义角色和本地 MCP，最后通过生产 Provider 执行完整工作流。完整闭环模型为从实际列表选出的 `gemini-3.8-flash-low`。

受限会话使用 HCode 自有目录作为 CLI cwd / add-dir，原项目路径不作为原生工作区传给 CLI。角色仅写入该目录的 `.agents/agents/`，`inheritCustomizations=false`、`commandExecutionPolicy=off`、`subagent=false`；仅保留原生 `finish` 与显式 HCode MCP，不暴露原生文件、shell、浏览器、子代理、Skills 或插件工具。研究调用不传完全放行参数。只用 `--add-dir` 无法实现只读；本实现通过角色工具范围与宿主路径验证共同限制 IO。[官方权限说明](https://www.antigravity.google/docs/permissions?tab=cli)、[角色说明](https://www.agy.dev/docs/subagents?tab=cli)

MCP 绑定随机 loopback 端口，校验 Host、Origin、URL 与临时 Bearer token；配置文件权限为 `0600`，令牌不进入协作记录。工具运行时绑定本次项目或候选目录，提供真实 `read_file/list_files`，执行者可使用受限 `request_context`，代码审查可读取基线。写入、委派和额外跨 Run 参数拒绝。请求大小与调用数量有上限；重复请求共用结果，参数冲突拒绝，回合终止后拒绝调用与迟到结果。不修改用户全局 MCP。[官方 MCP 说明](https://www.antigravity.google/docs/mcp?tab=cli)

实测注意：`init.tools` 会列出 CLI 全局工具注册表，不能把它当作当前角色可用工具列表；自定义角色的模型调用测试另外验证工具范围。仅配置 MCP 而不开放 `finish` 时，Gemini 可能只返回 JSON 代码块。生产角色开放 `finish` 后，真实结果返回 `structured_output`，宿主优先使用它，展示正文与可校验产物分开。[无头协议说明](https://www.antigravity.google/docs/cli/headless/)

## 3. 协议与状态归属

`AgyAgent/AgySession` 沿用原生历史与行投影，接入共享执行回合身份。新模块分别承担进程传输、result 转换、受限角色配置和 MCP 工具 IO；协作状态、预算、报告冻结、审查与有界修订仍由既有 Service 拥有。

- init 核验原生 conversation_id；研究会话还核验实际角色与模型，身份变化时不发送任务。
- result 的原生成功、错误、权限拒绝和中断明确归一；拒绝操作不能算成功。结构化输出仍经过宿主 schema、源码行引用和 hash 校验。
- 累计 num_turns 用于拒绝重复/旧终态；修订复用同一原生执行会话。取消等待进程实际 close，结果先到也不提前释放取消中的执行锁。
- 损坏的 stream-json、缺失/非对象 result 显式失败并停止子进程，不能吞掉错误等待整体超时。无 result 退出也明确失败。启动期间关闭会话不会发送任务正文，停止仍等待真实 close。
- 累计用量字段不全或倒退时，本轮用量显示未知；重新建立基线后才能继续计算差值，不以零或累计数冒充本轮用量。
- 报告格式最多修正一次，自动修订最多两次。证据错误、缺能力、额度失败或停止未确认保持显式失败/待处理状态，不假装审查通过。

## 4. 真实研究闭环证据

测试只缩窄首版任务输入以产生实际遗漏；没有伪造模型结果或审查意见，报告读取、引用验证、版本冻结与恢复均使用生产实现。

| Run | 真实链路 | 结果 |
| --- | --- | --- |
| `2ca62169-050f-495e-8134-051eaab741c9` | Codex 发起 → Gemini 执行 → Claude 审查 → 原 Gemini 修订 → 新 Claude 复审 → 原 Codex 汇总 | v1 真实遗漏正数除零、0/0、局限说明等，changesRequested；v2 approved；6 个原生回合完成 |
| `17acf5e0-48c8-4b6a-9047-236c5c79ddb5` | Claude 发起 → Codex 执行 → Gemini 审查 → 原 Codex 修订 → 新 Gemini 复审 → 原 Claude 汇总 | Gemini 提出两个真实零除边界阻塞意见；v2 approved；6 个原生回合完成 |

两条测试均校验：原项目不变；执行/修订的原生身份相同；各次独立审查身份不同；发起/汇总保持原生身份；最终报告覆盖 Infinity / NaN；结果持久化可读。

完整证据目录：`/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s4-loops/`。

生产 Provider 的 MCP 读取 smoke 与真实启动期间取消均通过，取消回合没有发送任务正文、原生停止后共享执行入口恢复空闲。最终版本再次通过这两项真实检查，证据目录：`/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s4-controls-final/`。

## 5. 代码候选与桌面验收

真实代码 Run `4fd9c050-2621-448d-835f-1ebe8b321e5c` 完成：Codex 发起 → Claude 实现 → 宿主 `node --test` → Gemini 阻塞审查 → 原 Claude 修订 → 宿主复验 → 新 Gemini 复审通过 → 原 Codex 汇总。Gemini 的实际阻塞意见为 `missing-zero-divisor-handling` 和 `missing-regression-tests`。首版现有一个测试通过仍被拒绝，第二版新增零除边界回归，六项真实测试通过后复审 approved。

测试还销毁并重建 Provider/Service，再显式重跑同版本检查与新的 Gemini 审查：六项测试再次通过、审查 approved，汇总回到同一个 Codex 原生会话；随后普通消息继续沿用该身份。两次 Claude 实现身份相同，三次 Gemini 审查身份互不相同，原项目 manifest 不变，untracked 内容保留，候选仍未应用。证据目录：`/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s4-code-review/`。

失败记录保留：首次代码测试 Run `90957845-c95c-4738-b394-7295970a1c29` 中，Gemini 正确提出实现/测试阻塞意见，Claude 修订后报告的一个测试引用漏算最后一行，宿主拒绝送审并转 awaitingUser；未降低证据校验。代码执行提示现要求改后重读最终文件、核对完整行号。重跑后通过，原失败产物没有改写。

桌面使用开发版 Electron（localhost:5388），打开已有 Codex 验收会话后，从“多 AI 协作”选择 Gemini 执行者、实时列表中的 Flash Low 与独立 Claude 审查者，实际点击启动。界面验证：两类模型分别配置，Gemini 模型缺选时不能启动，任务、报告版本、审查者及汇总可见。

桌面 Run `12fa81b5-d07f-4351-a44d-e1d5123b5a51` 经过六个真实回合完成。Claude 对 v1 提出 `overbroad-no-throw-claim` 阻塞意见：报告将 Number 的语义错误推广到所有输入。原 Gemini 会话提交 v2，补充 BigInt 与类型错误行为；新的 Claude 会话复审 approved。原 Codex 汇总明确保留三项非阻塞意见与未运行测试的局限，界面显示“交付已审查并汇总”。原项目 Git 状态仍只有此前的 `untracked.txt`。

桌面发起/汇总原生 ID 均为 `01a12a6d-bc52-75a2-93c0-dfc4a27fa798`，Gemini 执行/修订均为 `9cc79604-b0e9-429b-9be4-ac4b3f8adfe0`。持久化记录位于开发版用户目录的 `collaborations/12fa81b5-d07f-4351-a44d-e1d5123b5a51/`；完整 Run 与产物另存于 `/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s4-ui/`。

## 6. 验证命令与限制

```sh
pnpm typecheck
pnpm test
pnpm build
HCODE_NATIVE_AGY_SMOKE=1 HCODE_NATIVE_AGY_CONTROL=1 pnpm test src/main/collaboration/__tests__/nativeAgy.test.ts
HCODE_NATIVE_AGY_LOOP=1 pnpm test src/main/collaboration/__tests__/nativeAgy.test.ts
HCODE_NATIVE_AGY_CODE_REVIEW=1 pnpm test src/main/collaboration/__tests__/nativeCodeDelivery.test.ts
```

默认测试为 **206 passed / 12 skipped**，41 个文件通过，5 个文件的原生用例跳过；需要真实账号的用例通过上述环境开关单独执行。两条真实研究闭环、生产读取与真实取消两项、代码候选/重建/普通会话恢复一项均通过；桌面额外完成一次真实阻塞修订。`pnpm typecheck`、`pnpm build` 和 `git diff --check` 均通过。项目没有配置独立 ESLint/formatter 命令，不声称运行过这两项。

准入范围为本机 macOS arm64、agy 1.3.3。其他平台/版本、真实额度耗尽、Gemini 写代码、agy 发起自主委派、专家引擎、原项目采纳及安装包签名发布未验收。额度错误和权限拒绝通过协议重放测试，不声称实际耗尽账号额度。源码留在开发分支，未提交、推送或替换安装版；历史备份不修改。
