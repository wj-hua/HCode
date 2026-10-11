# HCode S5b 最终审查与安装版验收记录

日期：2026-10-12。范围为两项独立代码任务并行、人工生命周期、安全采纳与本机 macOS arm64 安装版验证。承接 [S5b 并行验收](./HCode-多AI协作-S5b并行实施与验收记录.md)。

## 最终代码审查

审查覆盖启动契约、共同基线与目录隔离、写入白名单、冻结版本/报告/检查对应关系、并发和累计预算、单任务失败/续跑、重启未知状态、逐工作区采纳日志与恢复，以及桌面/IPC 和本地打包资源。

发现并修复一项生命周期竞争：采纳、恢复、接管和续跑已互斥，但停止/取消入口未共享互斥边界。续跑在异步核验文件或日志时，整轮取消或单任务取消可能被接受，再被续跑覆盖。`RunControls.stop` 和 `cancelDelivery` 现在也使用 RunOperations，只在动作准入和状态持久化期间互斥，不锁住整个后台模型执行。运行期间正常取消仍可用。

三个公开接口回归分别验证暂停、整轮取消和单任务取消在续跑核验期间被拒绝。修复前整轮/单任务取消请求实际 fulfilled；修复后明确拒绝竞争操作，续跑 completed。既有取消、审批、迟到结果和停止确认回归继续通过。并行候选失效提示也改为正确的代码修订描述。

在本次审查范围内未发现其他阻塞发布的问题。审查不替代自动审查的正确性保证，也不扩大已准入平台、后端或项目类型。

## 提交前验证

- 并行 Service 行为测试：11 项通过；另有副本创建失败回滚 1 项通过。
- `pnpm test`：263 项通过，17 项条件测试跳过；48 份通过，10 份跳过。
- `pnpm typecheck`、`pnpm build` 和 `git diff --check`：通过。
- 本段原生 Claude/Codex 并行、真实阻塞修订和复审证据见前述记录；安装版验证单独进行，不用开发版结果代替。

## 安装版验证

代码提交：`ea51e33c9150fe0bc20cdecca7bc541d0bc24f68`，`feat(协作): 打通独立写任务并行并修复生命周期竞争`。`pnpm dist` 成功，生成 `release/HCode-0.18.0-arm64.dmg`，SHA-256 为 `86651a9909a59f5bb1e07e76f9c83f49a16d1fb2a604f560fd993dbe905d0700`。

从只读挂载的实际 DMG 安装到 `/Applications/HCode.app`，通过关于窗口确认版本 0.18.0，界面 URL 来自安装包内 `app.asar`。包内主进程文件与本次构建一致，预加载、渲染入口及解包的验证原生库均存在。替换现有 0.16.0 前保留旧应用和正式版数据备份；首次启动时 settings/projects/usage 文件与备份逐字节相同，不将开发版数据覆盖到正式版。后续仅通过界面新增专用验收项目，已有项目和普通会话在重启后仍可见。

### 真实委派、阻塞修订与复审

专用项目：`/Users/geraldgan/Documents/Codex/2026-10-12/hcode-s5b-installed-fixture`。冻结共同基线包含实际已安装的 smol-toml 依赖、两个既有测试及未提交的 `user-context.txt`。从正式安装版当前 Codex 会话确认两项独立写任务及各自文件范围，宿主运行检查，模型不能自动采纳或写回。

- Run：`01c2075c-0225-4197-8a2e-a33247cbd498`，9/12 轮完成。两项 execution 的 running 状态在持久化事件中重叠，使用相同基线和两个不同工作区。发起规划与最终汇总复用当前 Codex 原生会话 `01a12c0d-6c49-7762-885f-d70575f6f437`。
- Claude 交付：`ffb865a6-973e-4fb4-b297-3ad52a385474`，只改 `divide.mjs`、`zero.test.mjs`。真实 Codex 首审提出阻塞意见 `missing-negative-zero-over-positive-zero`，要求补齐 `divide(-0, 0)`。Claude 在原工作会话修订到代码 v2 `409353f2-5283-4703-b755-61f92bfc8d5f`，宿主真实检查 7 项通过，独立复审 approved；最终报告 v2 `68d50e6f-bb30-4504-82dc-8e57112e6dcf`。
- Codex 交付：`35ac3846-1117-45ad-bdea-7fd626e1984f`，只改 `normalize.mjs`、`normalize.test.mjs`。请求读取项目外的全局开发规范被权限边界拒绝后，真实进入澄清；通过安装版界面补充已读取规范的准确摘要，未扩大读取权限，随后复用原工作会话继续。代码 v1 `f07c318b-0078-47db-ac82-49a9093bf897` 的宿主检查 8 项通过，独立审查 approved，无审查意见；报告 `5da7b63f-ab3b-4bbb-896e-85f46c064c7a`。
- 当前会话通过结果工具读取两份报告并完成汇总，明确列出候选、实际宿主检查和未解决意见。Claude 最终报告仍有一条非阻塞 `outdated-validation-report`：报告在宿主检查前生成，“尚未验证”的文字未更新，真实当前版本检查已通过。汇总也指出该文字过时。本轮未宣称报告完全无意见。

最终 Claude 交付的 Codex 复审原生会话为 `01a12c0e-e950-7bb3-9eb5-9dcf234b9222`，Codex 交付的独立审查原生会话为 `01a12c10-4d33-7960-8142-9b013308ec44`。以宿主 `reviews.reviewer.nativeSessionId` 为准；模型汇总中“审查会话”一词引用了 reviewer.sessionKey，不能将该字段当作原生会话 ID。

### 安全采纳与重启

采纳前对原项目所有文件的 SHA-256 和权限核对，均与验收基线一致。通过正式安装版分别选择 Claude v2 和 Codex v1，核对冻结差异、运行冲突检查并明确确认采纳。两项冲突检查均通过，界面分别显示“已采纳”；采纳记录使用不同 adoptionId 和 workspaceId，各自仅包含两个授权路径，无自动合并、提交或推送。

联合写回后实际运行 `/opt/homebrew/bin/node --test`：13 项通过、0 项失败。原项目仅 `divide.mjs`、`zero.test.mjs`、`normalize.mjs`、`normalize.test.mjs` 四个路径变化；既有测试、依赖、未提交文件及其权限保持一致。

通过正式版菜单正常退出并重新启动，重新打开原 Codex 会话和协作面板：两份“已采纳”状态、冻结候选、审查与历史均保留，汇总标记“采纳前”。持久化 Run 与重启前相同，任务仍为 9 项，未自动重新派发，原项目文件和权限也保持一致。本轮未再次执行强杀中断或采纳恢复演示，既有证据和相关行为回归见前述记录。

### 证据与备份

本轮目录：`/Users/geraldgan/Documents/Codex/2026-10-12/hcode-s5b-release`。旧应用保存在 `HCode-0.16.0.app` 和替换时保留的 `HCode-installed-before.app`；正式版原数据保存在 `HCode-profile-before`。原 A10 备份和先前真实验收目录未修改。

- `package-verification.json`：版本、构建提交、包 hash 和原生资源核对。
- `installed-run/01c2075c-0225-4197-8a2e-a33247cbd498`：本轮完整 Run、事件、冻结产物、工作区及独立采纳日志。
- `installed-run-before-adoption.json`、`installed-run-after-adoption.json`、`installed-run-after-restart.json`：阶段快照。
- `installed-fixture-before.json`、`installed-original-before-adoption.json`、`installed-original-after-adoption.json`：原项目文件 hash 与权限证据。
- `installed-original-node-test.log`、`installed-verification.json`：联合 13 项测试和重启核对结果。

检查日志已复制到本轮目录的 `logs/`，包括 `hcode-s5b-final-control-red.log`、`hcode-s5b-final-control-green.log`、`hcode-s5b-final-tests.log`、`hcode-s5b-final-types.log`、`hcode-s5b-final-build.log`、`hcode-s5b-final-dist.log`。`/tmp/` 中同名文件为执行时日志，长期证据以本轮目录为准。

## 保留限制

首版两项独立写任务，不自动合并、提交或推送；采纳后组合行为需在原项目复测。Gemini 写入、agy 发起、联网专家和移动/Java 真实构建环境不在本次发布验收范围。包为本地未签名构建，未做 Developer ID 签名、公证和公开发行。
