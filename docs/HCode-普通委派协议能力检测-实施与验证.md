# 普通委派协议能力检测

日期：2026-10-30。

## 问题与边界

现场 HCode 0.19.32 的 AI 委派开关关闭，Codex CLI 为 0.165.0。原来普通宿主工具与研究隔离共用版本准入；即使开启委派，未列入版本表的 CLI 也会创建没有委派工具的普通线程。既有线程无法补注册工具，模型可能改用终端启动 Claude。

本次修改普通宿主工具的生产接入、错误反馈与相关文档，不改变已有线程身份、用户开关、安装流程或项目权限。研究沙箱和文件范围受限执行仍须独立通过版本准入。

## 实现

- 每次 app-server 启动前，使用当前可执行文件生成实验协议 JSON Schema，检查动态工具注册、上下文注入、工具回调及结果字段。检测不启动模型、不创建线程、不修改 CLI 配置，临时目录在检测结束后清理。
- 协议兼容时协商 experimentalApi，实际注册或调用错误仍由原生响应报告；Schema 声明不等于所有运行行为已验证。
- 协议检测失败保留具体原因并记录警告。普通聊天可继续，申请宿主工具的回合明确失败，不创建缺少已开启工具的新线程。
- 旧线程缺少工具时，提示先开启委派、再新建 Codex 会话；保留原线程中已有的匹配工具。
- 委派指令要求工具缺失或失败时说明原因，不通过终端另起 AI CLI 代替；用户明确要求终端时除外。这是模型行为约束，不是拦截所有终端命令。
- Codex Provider 对所有研究入口单独核验隔离准入；目标发现准确返回只读与并行能力，未验证研究隔离时不能改用普通执行。

协议生成依据：[OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server#message-schema)。Schema 由当前本机 CLI 生成，不使用下载的固定版本定义。

## 验证

环境：macOS，本机 `/opt/homebrew/bin/codex` 0.165.0；使用已有登录，真实验收只操作临时项目。

- 相关单元与集成回归共 91 项通过，覆盖协议兼容/缺失/生成失败、普通会话、旧线程、工具分发、委派生命周期、并行隔离、研究准入及共享宿主接口的记忆行为。
- `pnpm exec tsc -p tsconfig.node.json --noEmit` 通过。
- `HCODE_NATIVE_CODEX_PROTOCOL=1 HCODE_CODEX_PATH=/opt/homebrew/bin/codex pnpm exec vitest run src/main/agents/codex/__tests__/nativeHostedTools.test.ts` 通过：实际协议检测、动态工具注册、成功和失败结果、app-server 重启后同线程重新绑定。
- `HCODE_NATIVE_INVOCATION=1 pnpm exec vitest run src/main/invocations/__tests__/nativeInvocation.test.ts -t 'codex 普通消息实际调用 claude'` 通过：源 Codex 使用 HCode 委派工具，Claude 在临时项目交付文件，工具结果返回后源 Codex 在同一回合继续交付。未运行该文件的其余三个后端组合。
- `git diff --check` 通过。

## 生效与限制

本次不替换正在运行的 App，不开启 AI 委派，不提交或推送。安装包含本改动的版本后，在「设置 → 模型与 CLI → AI 委派」开启普通跨 AI 委派，并新建 Codex 会话。原先无工具的线程保持可读，不自动迁移或重建。

已验证的是本机 CLI 和主进程调用链；尚未在重新安装后的桌面界面验收右侧调用面板。Codex 0.165.0 的研究沙箱与文件范围受限执行仍未准入，不能把普通工具验收当作其隔离验证。
