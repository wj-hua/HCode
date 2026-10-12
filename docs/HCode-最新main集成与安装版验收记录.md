# HCode 最新 main 集成与安装版验收

日期：2026-10-12。范围为合并最新 main，保留响应指标、厂商图标与多 AI 协作，并在实际 macOS arm64 安装版验证。承接 [S5b 最终审查](./HCode-多AI协作-S5b最终审查与安装版验收记录.md)。

## 合并基线与改动边界

功能分支原提交 `c9bd6cb`；最新 main 为 `135ae14cef8e1f7425d7f882dc68f20349c66c34`（0.19.4），包含 `9983481` 的响应速度指标/用量统计移除及 `135ae14` 的厂商图标。合并在 `codex/multi-ai-collaboration-plan` 完成验收后提交，再合入本地 main，不直接在主干开发，不推送或公开发布。

两处冲突分别位于 CodexSession 的回合完成和 AgySession 的回合开始。保留双方逻辑：Codex 的可信终态、迟到事件隔离及协作结果与响应指标并存；agy 每轮同时清空协议错误和启动响应计时。main 对设置用量页/IPC 的移除和厂商 logo 保持；旧 usage 文件不因升级被删除或伪装为新的统计来源。

本轮额外修复仅限原生 Session 与协作调度/审查边界，不新增后端、权限模式、写入能力或自动合并。

验收通过后按逻辑提交：`3de9a1b` 同步 main 与会话指标；`e1c9a3e` 补齐逐任务审查范围；`7eae11f` 限定显式续跑目标。最终代码提交 `7eae11f1a17d5b4e8c10b99e81d52193126acc9b` 的树与已打包/安装验证的源码树完全一致。

## 回归发现与修复

1. Codex 不可重试错误后仍收到 completed 时，原合并方案显示成功吞吐。公开 Agent 事件回放复现 `state=error` 但仍显示 100 tokens/s；计时结算现在服从真实 failure，错误或缺失终态不显示成功吞吐，正常 TTFT/吞吐保留。agy 通过真实子进程回放验证协议失败后的新轮清空旧错误/指标并可成功结算。
2. 实际双写审查未获得执行者已有的逐任务文件范围，把总需求中另一项任务未实现当成本交付阻塞。代码审查输入现在包含 `scope.objective/allowedPaths`，明确逐任务职责；本任务真实缺陷、必要依赖和授权矛盾仍须严格审查，组合效果留待原项目复测。公开 Service 回归修复前 awaitingUser，修复后两项 accepted；实际原生 Codex 审查消息也核对到两份不同 scope。
3. 选择一项已澄清任务复审时，等待阶段遍历全部已回复交付，自动重新执行另一项任务。公开 Service 回归修复前未选任务从 3 个回合增加到 5 个；修复后显式续跑只恢复本次选定交付，未选任务的状态、文件和预算不变。首轮父 AI 在原回合结束后回复既有上下文的机制保留。

两个首轮实际 Run `66261f04-cff3-4c92-875b-272962029680`、`b4fc90c8-88b8-4227-8f1b-718f8450f987` 的失败、澄清、修订和 11/12 轮停止记录均保留。首轮 Gemini 报告的未经原文支持的推断未全部消除，没有将该报告改成通过；新轮只读验收限定为原文核对。未增加旧轮预算、切换其模型或伪造审查结果。

## 最终自动检查与包核对

- `pnpm test`：281 项通过，17 项条件测试跳过；51 份通过，10 份跳过。
- `pnpm typecheck`、构建/打包 `pnpm dist`、`git diff --check`：通过。
- 最终包为 `release/HCode-0.19.4-arm64.dmg`；源码树在验收文档补入前为 `7f532fae6fa72ad5cf8f0de265bfcb37089ed967`。
- 从实际 DMG 安装到 `/Applications/HCode.app`，关于窗口确认 0.19.4；包内主进程与当前构建逐字节一致，预加载、渲染入口、原生验证库存在。构建输入 hash 清单冻结，提交前重新核对。
- 首次升级、范围修复包及完整修复包启动后，设置、项目、旧 usage 文件及已结束的 Run 文件 hash 均保持一致；没有复制开发版数据或自动续跑。
- 实际界面显示厂商图标；设置已无旧用量统计页。真实 Codex 会话显示 TTFT 和估算吞吐，指标不作为模型准确性保证。

## 最终安装版真实路径

独立项目：`/Users/geraldgan/Documents/Codex/2026-10-12/hcode-main-sync-fixture`。包含实际 smol-toml 离线依赖、两个基线测试和未提交 `user-context.txt`，不修改旧验收项目。

代码 Run `31d5ba82-4f87-4d82-9806-7de1f9502b9d` 从当前 Codex 会话同时委派 Claude 除零修复和 Codex 标题规范化；两份候选、宿主 Node 检查和独立 Codex 审查均真实完成。首次闭环 6 轮，两份 approved，无审查意见。Claude 候选检查 5 项通过，Codex 候选检查 7 项通过；两项分别覆盖多个断言，保留两个基线测试。共同基线与独立目录保留，采纳前原项目所有文件 hash 和权限与初始基线一致。

Gemini Run `7f62ca54-0ad2-454c-a134-26d440b764e8` 在完整修复包中由当前 Codex 会话发起，界面明确选择 `agy` / `gemini-3.1-pro-high`，真实读取 `review-context.md`。独立 Codex 核对后报告 v1 accepted/approved、无未解决意见，当前 Codex 会话真实读取结果并汇总，4/12 轮 completed。此任务仅核对原文，未运行测试或验证实现/安装状态，不能拿研究报告代替包和代码验收。

指定第一项候选重新验证与独立审查后，代码 Run 总计 8/12 轮 completed，新增回合仅为该项 review 和当前会话 synthesis。第二项交付的完整快照、两个既有回合和候选文件不变；再次复审第一项也 approved，无未解决意见。发起规划与两次汇总复用当前 Codex 原生会话 `01a12dc7-72f7-7ec2-bb48-e68a9942252a`。

通过安装版逐项选择冻结版本、核对差异与冲突、明确确认采纳，两项均显示“已采纳”，使用两个不同工作区和独立采纳日志。联合运行 `/opt/homebrew/bin/node --test`：10 项通过、0 项失败。仅 `divide.mjs`、`zero.test.mjs`、`normalize.mjs`、`normalize.test.mjs` 四个路径变化；原有测试、依赖和未提交文件及其权限保持一致，没有自动合并、提交或推送验收项目。

正常退出并重新启动正式安装版，重新打开两个发起会话：代码两项“已采纳”、审查、候选和“采纳前”汇总均保留；Gemini 报告仍 accepted/approved。两个 Run 文件与重启前归档逐字节一致，预算仍为 8/12 与 4/12，无自动派发或写回，原项目文件及权限也保持一致。未重复强杀/中断采纳演示，相关既有证据与回归见 S5b 记录。

最终 DMG SHA-256：`5e6b2db00ac38aa9ae46c738c891d6bd63a00b24170aadc510e11a7765b84c0d`。安装包在提交前完成验证；最后仅补入验收文档，提交时核对构建输入清单，避免将未打包代码误标为安装版已验证。

## 证据与限制

本轮证据目录：`/Users/geraldgan/Documents/Codex/2026-10-12/hcode-main-sync-release`。保留原 0.18.0 应用、正式数据、首轮/范围修复包，以及真实未通过 Run；最终 DMG/asar hash、构建源码清单、升级前后文件 hash 和执行日志均在目录中。旧 A10 与此前验收备份不修改。

主要证据：`package-verification.json`、`compiled-source-manifest.json`、`installed-verification.json`、`native-review-scopes.json`；`code-before-targeted-review.json` 与 `code-after-targeted-review-before-adoption.json`；`fixture-before-final-adoption.json` 与 `fixture-after-adoption.json`；`joint-node-test.log`；完整 `accepted-runs/`、`initial-runs-final/` 与 `logs/`。

包为本地未签名、未公证构建。真实代码验证仍限于本机 Claude/Codex Node 依赖项目；Gemini 写入、agy 自主发起、移动/Java 实际构建和其他平台另行准入。自动审查不能保证发现全部缺陷，历史未通过报告和人工采纳边界保留。
