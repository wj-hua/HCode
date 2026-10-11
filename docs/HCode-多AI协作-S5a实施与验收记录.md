# HCode 多 AI 协作：S5a 单隔离工作区实施与验收

日期：2026-10-11。开发分支：`codex/multi-ai-collaboration-plan`。本切片将 S0–S2 的只读报告链路扩展为单个代码候选：当前 Claude 会话委派 Codex 实现，宿主运行用户确认的检查，独立 Claude 审查，原 Codex 按阻塞意见修订，复验和复审后原会话汇总。

## 用户可见行为与边界

当前会话的“多 AI 协作”提供只读调研与隔离代码交付。代码模式先检查项目、展示 Git 状态和实际检查命令，用户勾选并确认计划后才创建副本。界面展示执行、检查、审查、修订阶段，以及每个冻结候选的基线/候选源码、二进制或链接标记、hash 和文件权限。

检查通过与独立审查 approved 同时满足，且候选内容仍匹配冻结版本时，交付进入“待采纳”。S5a 没有写回原项目的 API 或采纳按钮。用户可暂停后接管副本；接管立即使旧通过结论失效。候选保持原样时可重新检查和审查，人工改动后需重新实现/冻结。丢弃只删除可写副本，冻结基线、版本、检查和审查历史保留。

每 Run 只允许一个代码交付；目标沿用用户完整目标。累计 12 回合、两次自动修订上限沿用 S2，续跑不清零。检查失败不能被模型的 approved 覆盖，超过修订上限保留问题等待用户。

## 模块与隔离准入

| 模块 | 职责及关键约束 |
| --- | --- |
| `shared/codeDelivery.ts`、`workspaces/codeContracts.ts` | 检查计划、冻结候选、实际检查与工作区状态；IPC/持久化严格校验 |
| `WorkspaceService`、`fileManifest` | 完整复制当前文件上下文，保留 dirty/untracked/ignored 依赖；比较双端清单；执行/验证/审查租约互斥；受控文本写入和版本冻结 |
| `validationPlan`、`ValidationRunner` | 发现并确认 Node/pnpm 检查；运行真实命令、记录退出码和日志；核对验证前后同一内容版本 |
| `CodeDeliveryWorkflow` | 实现→冻结→实际检查→独立审查→有界修订；审查者可读取冻结原始基线，核对测试是否被削弱 |
| `CollaborationService`、`RunControls` | 原会话绑定、调度、显式恢复和接管；运行时以及重启时停止未知均阻止接管 |
| Renderer 协作模块 | 计划确认、阶段、差异、检查日志、原生历史与用户动作；不自行推断通过或停止 |

首版验证范围为 macOS 普通 Node Git 项目，有 `package.json` 和 HEAD。副本不复制 `.git`；依赖已存在且链接必须为内部相对链接。外部/绝对链接、submodule、特殊文件和超过 10 万文件或 4 GiB 的项目明确拒绝。AI 不可写 `node_modules`、Git 管理目录、符号链接路径或原目录；文本单次写入上限 256 KiB，采用当前 hash 校验。

宿主允许用户选择发现的 typecheck/test/build 脚本，没有可发现脚本时展示 Node 内置测试。pre/main/post 脚本值绑定授权计划；候选改写这些脚本后不自动执行新命令。验证不自动安装依赖；缺少环境明确失败。每项检查最多 5 分钟，stdout/stderr 各保留最多 512 KiB，并标注截断。检查导致文件变化时，旧冻结版本的检查与审查不能用于接受交付，包括生成文件的构建。

验证进程采用 macOS OS 沙箱、无登录凭证的临时 HOME、关闭网络、原目录明确不可读写，写入只限候选/临时区。禁止创建新进程组、会话及通过 posix_spawn 脱离组；随包提供的 Node fork/exec 兼容库仅维持 Node 子进程兼容，运行时不编译。完成/取消后核对整个进程组已退出才释放验证租约；系统查询失败或原生中断未确认保持锁定。应用在验证中重启时不能证明旧进程已退出，恢复为停止未知，拒绝自动续跑和接管；本切片未提供强行解锁。

## 实际验收

1. 真实模型闭环种入首版遗漏：初版只处理正数除零，而完整目标要求 0/0、负数除零和 -0。独立 Claude 提出两项阻塞意见，原 Codex 修订实现和测试，另一独立 Claude 复审 approved；两版均运行真实 Node 检查，最终 original manifest 不变、untracked 文件保留。
2. 最终原生验收 Run 为 `8857623f-d914-4734-8ea3-bd0731341e01`。候选 v1 `1d60851b-7a61-4084-8d4c-8140e066f7dc`，v2 `79db91fe-011f-4a56-88c1-31b6d3c81ced`。保存了真实阻塞意见、两版检查、修订、复审和汇总；同一执行者身份及不同审查者身份已断言。记录：`/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s5a-final/`。
3. 桌面开发版使用独立测试项目 `hcode-s5a-ui-fixture`。真实界面确认计划、创建副本、Codex 写入两文件、宿主运行 pnpm 脚本（7 个测试通过）、独立审查、待采纳差异展开均已验证。Run `1eee38c7-690d-4574-948f-64940ed3f1af`；数据在 `~/Library/Application Support/HCode-dev/collaborations/`。真实应用重启后保留原会话归属、版本、检查和审查，不自动执行。
4. 人工接管使旧接受状态失效。重启后重新审查暴露字段顺序误报：持久化 schema 调整对象字段顺序，字符串比较误判冻结记录改变；已建立失败回归并改为结构和值比较。修复后界面再次运行真实检查（7 个测试，退出码 0），新独立 Claude 会话 `17468b1e-d641-49d6-941a-1915bcbf4ada` 实际调用 `read_baseline_file` 核对实现、测试、package.json 和 untracked 文件后 approved，无遗留意见；原始项目内容和文件权限与基线逐文件一致。原会话汇总完成，UI 恢复待采纳，累计 7 个原生回合。最终 UI Run 快照与冻结历史归档到 `/Users/geraldgan/Documents/Codex/2026-10-11/hcode-ui-s5a-final/`。
5. 行为测试采用真实文件系统、工作区、服务、持久化、Node/pnpm 和 macOS 沙箱。覆盖文件漂移、真实失败退出码、原目录读写拒绝、断网、子进程取消及后台脱离进程组、内部依赖链接、授权脚本改写拒绝、基线只读、冻结历史保留、重启不派发与停止未知保护。外部模型传输和系统查询错误可被替换，不替换业务规则。

最终项目检查：`pnpm typecheck`、`pnpm test`（181 通过，6 个原生用例默认跳过）、`pnpm build`。S5a 真实原生用例另显式执行通过：

```sh
HCODE_NATIVE_CODE=1 \
HCODE_NATIVE_EVIDENCE_DIR=/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s5a-final \
pnpm test src/main/collaboration/__tests__/nativeCodeDelivery.test.ts
```

## 验证缺口与后续切片

实际验收为当前 Apple Silicon macOS、Claude CLI 2.1.296/SDK 0.3.280、Codex 0.162.0、Node 24/25 与本机 pnpm。兼容库已编译 arm64/x86_64，但 x86_64 运行、其他 OS/CLI 版本、签名发行包、掉电以及真实额度耗尽未验收。已验证含内部链接的 ignored 依赖和 pnpm 脚本；未承诺任意现有大型项目的 typecheck/test/build 都能在该沙箱运行，移动端项目也未开放。目录自身权限/空目录不作为文件差异；文本预览为完整前后内容，当前没有逐行补丁 UI。

下一切片 S1b：让当前 Codex 会话自主委派 Claude，复用现有交付、审查和修订规则；之后按计划接入 agy 和专家互审。S5b 再实现安全采纳、基线冲突与恢复日志、多写任务并行。所有开发改动尚未提交、推送或发布；已安装 HCode、全局 CLI 配置和 A10 历史备份均未修改。
