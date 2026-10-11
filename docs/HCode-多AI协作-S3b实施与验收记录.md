# HCode 多 AI 协作：S3b 实施与验收记录

日期：2026-10-11。范围：七类复合专家的本机角色与 Skills 指令导入，以及只读独立调研、领域互审、原会话汇总。

## 实现边界

从当前会话的“多 AI 协作 → 专家独立研究与互审”选择 2–7 位专家。专家类型与 AI 品牌分离，每位可配置 Claude、Codex 或账号可用的 agy/Gemini 模型。当前 Claude/Codex 会话继续主持和汇总；agy 发起自主委派仍未准入。

主进程发现本机 `.codex/agents/*.toml`，用 TOML 解析器提取完整 `developer_instructions`；不继承角色文件的 model、sandbox 或权限。Skills 来源包括现有 Extensions 目录、本机/项目 `.codex`、`.agents`、`.claude` Skill 目录，以及固定组合明确引用的本机插件缓存。

全部后端本阶段均为**指令加载**。主 Skill 正文和角色职责进入研究、审查任务，关联文本资源冻结为白名单，模型只能通过 `read_expert_resource` 按需读取。脚本作为文本，不执行。插件包级共享引用必须留在同一版本包内；源路径不是模型可任意访问的文件权限。

配置、源文件和资源分别保存 SHA-256；启动校验预览版本，续跑使用冻结内容，本机文件改动不改变既有任务。多个缓存副本只有正文、关联资源及资源限制完全一致才合并，并显示采用的源路径；不同内容明确报同名冲突。缺文件、无效 TOML、缺引用、越界符号链接和超限均有可见失败。

普通委派及旧三角色记录继续使用既有规则。未修改本机角色、Skills、全局启用状态、历史备份或已安装 HCode。

## 七类固定组合

| 专家 | 本机角色 | 本阶段导入的 Skills |
| --- | --- | --- |
| iOS | swift-expert、mobile-app-developer、mobile-developer | apple-design、swiftui-ui-patterns、swiftui-performance-audit、ios-debugger-agent |
| 安卓 | kotlin-specialist、mobile-app-developer、mobile-developer | apple-design、architecture-deepening、bug-diagnosis |
| 前端 | frontend-developer、react-specialist | apple-design、frontend-skill、architecture-deepening |
| Java 服务端 | java-architect、spring-boot-engineer、architect-reviewer | architecture-deepening、tdd-quality |
| 需求调研 | business-analyst、research-analyst、market-researcher、ux-researcher | task-slicing |
| UI 设计 | ui-designer、ux-researcher | apple-design、frontend-skill、product-design:index、product-design:audit |
| 测试 | qa-expert、test-automator、accessibility-tester | tdd-quality、bug-diagnosis |

表中 iOS 三项专项 Skills 的完整名称带 `build-ios-apps:` 前缀。具体本机路径、版本和哈希见每位专家的“组合角色与 Skills”详情及 Run 冻结记录。Figma 未接入本阶段的只读宿主；设计角色明确展示此缺口，不宣称具备设计产物制作能力。

框架要求按实际项目应用：Foundation 类不当成 SwiftUI 页面，安卓不强制 Compose，非 React / Spring 项目不使用相关框架规则。apple-design 在 iOS、安卓、前端和 UI 设计中用于层级、反馈、可中断交互与无障碍，原生端不照搬 Web 示例。

## 调度、预算与可见记录

七人基础闭环需要 16 个模型执行回合：当前会话确认 1 + 独立调研 7 + 互审 7 + 原会话汇总 1。专家预算独立配置，界面默认 24、硬上限 32；最低值须覆盖所选人数。格式修正最多一次，显式续跑继续累计，工作者并发仍为 2。这里是宿主模型执行回合数，不等同精确 API 次数或货币费用。

审查按实际参与角色确定领域关系；每份报告由另一专家核对，缺相关领域角色时明确标为通用证据审查。同一个专家可以审查多份报告，各次使用独立审查会话和目标版本。报告全部成功后才进入互审，互审全部成功后才汇总；不以多数票替代源码证据。

界面展示完整组合、路径/哈希、加载方式、关联资源数量、任务指令加载记录和实际资源读取记录。加载或读取留痕证明任务输入与工具调用，不能证明模型的专业判断正确。

## 验证记录

自动化行为覆盖：冻结后本机变更、资源白名单、来源缺失、无效 TOML、单文件和组合超限、关联资源缺失、资源符号链接、等价副本、同正文不同资源冲突、未接受只读限制、启动前完整预检、冻结损坏、七人最小预算、同专家多目标审查、原会话恢复，以及损坏配置使旧汇总失效。仅替换外部模型传输，文件和主业务编排使用真实边界。

真实验收以独立跨端登录刷新样例为材料，包含 Swift、Kotlin、React、Spring Java、需求、交互草案和测试源码。它验证真实 Provider 调用及静态领域分析，不代表这些平台已构建、运行或完成真机验收。

基线 Run：`d279b4fb-6266-4d5d-a6d6-233d0cd7e48b`。通用实现 Codex + 通用验证 Claude，无角色/Skill 任务包，同一目标，6 回合完成。基线报告保留在验收目录。

七专家 Run：`5cd896e3-bd6d-4fbf-9623-a2648a1b2071`。iOS/Java/UI 使用 Claude，安卓/前端/测试使用 Codex，需求调研使用账号实际返回的 `gemini-3.8-flash-low`。原会话 Codex 线程：`01a12b12-acf1-7a92-a79b-fb839e44a03c`。

首次真实运行遇到 agy 研究桥未接受新增资源工具，需求专家发送失败，其他六人的已冻结报告保留。补充只读工具白名单并通过 HTTP/MCP 回归后，用公开 `resumeExperts(action=research, expertId=需求专家)` 续跑；没有重写成功报告、重置预算或排除失败专家。初次失败快照与原始 Provider 结果另存，续跑结果继续记录到同一 Run。

七专家续跑验收通过，最终 `completed`，累计 19/24 回合。七份独立报告共 26 条 claim，七份互审逐项覆盖：19 条 supported、4 条 disputed、3 条 insufficientEvidence。原 Codex 会话汇总保留 5 项共识、4 项分歧、6 项未验证事项、9 项局限，failedExperts 为空。原项目七份材料逐字未变，冻结配置重读及持久化一致性通过。

真实互审纠正了具体过度推断：`expirySeconds()` 的名称不能证明实际单位；缺 repository/issuer 和全局异常映射，不能断言系统无事务或必然返回 500；Web catch 只设置错误，没有清空旧 token；401 不会使 fetch 自动抛错。专项角色也可能犯错，互审和证据不足必须保留。

iOS 实际读取 `build-ios-apps:swiftui-ui-patterns/references/async-state.md`。设计专家在独立研究及三次审查中实际读取 `product-design:audit/references/design-audit-framework.md`。本轮有四位专家被分配为审查者；其他三位的报告仍由他人审查，不是失败专家。主持第一次汇总错误地将这三人列入失败名单，宿主拒绝；同原会话进行一次有界格式/语义校验修正后通过。修正计入上述累计回合。汇总提示现已与宿主校验一致：参与是报告纳入本轮且接受互审，不要求每位专家都担任审查者；仅实际排除的失败专家进入 failedExperts。

真实恢复命令：

```sh
HCODE_NATIVE_EXPERT_PROFILE_RUN=5cd896e3-bd6d-4fbf-9623-a2648a1b2071 \
HCODE_NATIVE_EVIDENCE_DIR=/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s3b \
pnpm exec vitest run src/main/collaboration/__tests__/nativeExpertProfileRecovery.test.ts
```

验收目录：`/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s3b`，保留基线、初次失败快照、首次及续跑 Provider 终态、冻结配置/报告和样例项目。恢复 harness 仅还原自身临时样例目录，不改写 Run 的源会话、报告或启动配置。

自动化检查：`pnpm typecheck` 通过；`pnpm test` 235 项通过、15 项真实调用测试按环境开关跳过；`pnpm build` 通过。另运行上述真实恢复测试 1 项通过。`smol-toml` 用于完整 TOML 解析并打进主进程包；lockfile 只增加该依赖，未升级无关依赖。

桌面已确认七类预设、iOS 完整移动端角色与四项 Skills、源路径/哈希、等价缓存说明、只读缺口、模型实时列表和启动前确认。新发现 IPC 的 preload 白名单遗漏在真实 UI 中复现并修复，现已通过该入口实际加载七类。另用样例项目内临时同名 Skill 制造冲突，真实界面确认已选的冲突专家仍可取消；取消后保持未选且禁用，Java/测试选择不变。清理该临时文件后重新发现，七类恢复可选。桌面三方 Run `10a898ca-344f-4b60-938f-0eaecf2d9c3f` 已完成，9/24 回合，10 条 claim 中 8 条 supported、2 条 disputed，最终汇总包含 6 项共识、2 项分歧、6 项未验证事项和 8 项局限。前端改由 Claude、Java 改由 Codex、测试改由 Gemini，固定角色/Skill 包及结果契约保持一致；没有遍历全部专家×后端的组合矩阵。

桌面原 Codex 线程 `01a12b23-37bd-7d11-b0ce-fb37688ec050` 的确认与汇总身份一致。闭环结束后，同一会话正常回复“S3b 原会话已恢复”，用时 3 秒。桌面记录及未改变的样例另存于 `/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s3b-ui`。这里只验证 HCode 研究调用链路完成；样例功能、业务验收和真实平台测试没有执行。

## 报告效果与人工验收范围

同一目标的基线已能发现核心契约与测试问题；加入角色/Skills 不意味着基线做不到这些判断。七专家运行额外展现移动端生命周期/取消、平台反馈、事务与幂等、需求边界及可访问性视角；iOS 实际读取 SwiftUI 状态资源后区分当前 Foundation 实现的适用限制，设计专家实际读取设计审查资源。最终结论以逐项互审和主持汇总为准。

该比较是定性观察：参与人数、角色和部分模型不同，不能据此宣称 Skills 的独立因果增益、准确率提升或效果已普遍验证。Role/Skill 正文里要求的实施、测试、设备、访谈、联网、插件和设计制作步骤未执行，仍在界面及报告中标注。

HITL：用户核对本机组合和只读适配；业务人员确认未定义的取消/弱网/无障碍验收；平台工程师在真实项目执行构建、设备、性能和辅助技术验证。专家输出是带证据的研究材料，不能代替发布或产品决定。
