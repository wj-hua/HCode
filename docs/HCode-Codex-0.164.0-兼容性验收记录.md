# Codex 0.164.0 工具协议验收

日期：2026-10-26。交付版本：HCode 0.19.18，macOS ARM64。

## 原因与修改

本机 `/opt/homebrew/bin/codex --version` 返回 `codex-cli 0.164.0`。HCode 原有准入只匹配 0.162.x/0.163.x，因此 initialize 不启用实验 API，新建普通线程不注册宿主委派工具。

0.164.0 原生验收通过后，将它作为准确版本加入 `isCodexResearchVersion`；保留 0.162.x/0.163.x，拒绝未验证的 0.164.1、0.165.0、预发布字符串和未知版本。新增版本与旧线程能力回归，旧线程缺工具时仍明确拒绝，不替换线程或伪装补工具。

新增显式启用的 `nativeHostedTools.test.ts`，使用宿主随机生成且未出现在提示词中的标记，核验成功结果、失败结果及进程重建后的同线程工具绑定。真实模型回合设置超时并清理客户端；普通测试默认跳过，不消耗模型额度。修正旧原生沙箱夹具使用相对 `codex` 路径的问题，复用 `findExecutable` 定位程序，并保留失败的实际原因。

## 协议与原生证据

从本机 0.164.0 执行 `codex app-server generate-ts --experimental`，确认 `ThreadStartParams.dynamicTools`、`DynamicToolCallParams` 的 thread/turn/call/namespace 字段，以及 `DynamicToolCallResponse.contentItems/success` 与现有适配一致。[OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)也说明需要在 initialize 启用 `experimentalApi`，动态工具经 `item/tool/call` 往返，并随线程持久化恢复。验收依据以下实际结果，而非仅依据文档或类型声明。

1. `HCODE_NATIVE_CODEX_PROTOCOL=1`：1 项通过。新线程注册 `hcode_protocol_probe`，收到三次真实 `item/tool/call`，完成项依次为 `success=true/false/true`。模型最终答复包含实际成功标记和错误标记。重建 app-server 后恢复同一原生线程，调用新的宿主闭包，获得新标记；只创建过一次线程。两个回合均为 succeeded。首次运行约 239 秒，恢复阶段较慢；测试随后加入明确的每回合超时及最终证据保存，不改变验收断言。
2. `HCODE_NATIVE_SMOKE=1`，仅选择 `S0 Codex`：1 项通过，1 项未选择。宿主读取返回项目内信号、拒绝越界；同一版本原生沙箱直接执行项目内读取成功、写入失败、项目外读取失败。不存在探测写入文件，原文件不变；取消后原生客户端仍可响应配置请求。首次修正路径后的并发运行因 90 秒截止取消，单独重跑在约 20 秒内完成。
3. `HCODE_NATIVE_INVOCATION=1`，仅选择 `codex 普通消息实际调用 claude`：1 项通过，3 项未选择。通过生产 `CodexAgent` 和新增准入规则创建测试源线程，实际调用 Claude；宿主记录子调用 succeeded，子 AI 创建并核对 `child-proof.txt`，源 Codex 收到结果后在同一回合创建 `source-proof.txt`。宿主逐字核对两个文件及双方的实际结果。约 36 秒完成。

这些是独立临时项目中的原生测试，不是当前对话已获得 `call_agent`，也没有把实现任务委派给其他 AI。没有改动用户全局 CLI 配置或已有对话。0.164.0 的 Gemini 委派与完整并行多 AI 场景未在本轮重复实测。

原生证据：`/tmp/hcode-codex164-evidence/hosted-tools.json`、`codex-claude.json`。日志：`/tmp/hcode-codex164-hosted.log`、`hcode-codex164-sandbox.log`、`hcode-codex164-invocation.log`。协议类型：`/tmp/hcode-codex164-protocol.D9rATH`。这些本机临时文件不随源码或安装包发布。

## 回归结果与已知限制

- `pnpm typecheck`：通过。
- 直接相关的 Codex、invocation、session、capability 回归：15 个文件通过、6 个跳过；100 项通过、10 项跳过。相关日志为 `/tmp/hcode-codex164-focused-tests.log`。
- 全量 `pnpm test`：82 个文件通过、1 个失败、23 个跳过；516 项通过、1 项失败、38 项跳过。失败项是未改动的 `validationRunner.test.ts` 中真实 pnpm 脚本检查：本机 Corepack 入口读取其包配置被沙箱拒绝。以本机缓存的独立 pnpm 11.7.0/10.33.2 临时副本复核，后续子进程创建仍返回 EPERM。因此全量回归未全绿；没有放宽验证沙箱来消除此失败。全量日志为 `/tmp/hcode-codex164-tests.log`，独立复核日志为 `/tmp/hcode-codex164-validation-runner.log`、`hcode-codex164-validation-runner10.log`。
- `git diff --check`：通过。

安装新版后需要完全退出并重启 HCode，再新建 Codex 会话。当前缺工具的旧线程继续保留原样。

## 安装包

`pnpm dist` 通过，生成 `release/HCode-0.19.18-arm64.dmg`，121,391,920 字节。已核对应用 Info.plist 的版本为 0.19.18，打包后的 app.asar 实际包含 0.164.0 准入规则，`hdiutil verify` 校验通过。SHA-256：`ecac33a84c7178bac9bb51d7dee4a8e31b4753173241fea35952f0469884bf72`。

打包日志：`/tmp/hcode-0.19.18-dist.log`；镜像校验日志：`/tmp/hcode-0.19.18-dmg-verify.log`。本轮仅生成本地安装包，未替换当前安装的应用。
