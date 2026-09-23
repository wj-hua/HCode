# HCode

macOS 桌面版编程助手工作台，界面与对话卡片复刻 [ZCode](../ZCode)。v1 支持 **Claude Code CLI**：

- 项目列表：自动汇总 `~/.claude/projects` 里所有会话的工作目录，也可手动添加文件夹、置顶、移除
- 会话历史：按项目列出 Claude Code 历史会话（包括终端里创建的），用 ZCode 卡片查看完整对话
- 新建会话 / 续聊历史会话，流式输出，随时停止（Esc）
- 审批卡片：改文件、跑命令前询问（允许 / 本会话总是允许 / 拒绝并附原因），支持 AskUserQuestion 与计划模式审批
- 权限模式（逐条审批 / 自动接受编辑 / 计划模式 / 完全放行）与模型切换
- 终端中新建的会话自动出现；正在终端运行的会话会提示冲突风险

## 使用

需要 Node 24+、pnpm 10+，以及已登录的 `claude` 命令（默认从登录 shell 的 PATH 查找，可在设置里指定路径）。

```bash
pnpm install
pnpm dev          # 开发模式（Vite HMR + 主进程自动重启）
pnpm typecheck    # 类型检查
pnpm dist         # 打包 release/HCode-<版本>-arm64.dmg（本地未签名）
```

开发调试：`HCODE_CDP_PORT=9229 pnpm dev` 开启远程调试端口；`HCODE_DEBUG=1` 打印 claude 子进程 stderr。

未签名的 dmg 首次打开如被拦截：右键 HCode.app →「打开」，或执行 `xattr -dr com.apple.quarantine /Applications/HCode.app`。

## 结构

```
src/main/        Electron 主进程
  agents/claude/   Claude 接入：历史(SDK listSessions/getSessionMessages)、实时会话(SDK query)、审批桥接
                   rowProjector.ts 把 Claude 记录 / 流事件统一投影为 ZCode v4 ConversationRow
src/preload/     contextBridge 暴露 window.hcode（通道白名单见 src/shared/ipc.ts）
src/shared/      主/渲染进程共用类型与 IPC 契约
src/renderer/
  app/             HCode 自己的界面：外壳、侧边栏、时间线、输入框、审批卡片、设置
  zcode/           从 ZCode packages/ui/src 复制的组件（卡片、markdown、shadcn 组件、样式）
                   带 “HCode shim” 注释的文件是对 ZCode services/store 依赖的替代实现
vendor/          ZCode 的 @zcode/shared、@zcode/model-option-map 原样复制；@zcode/services 为类型桩
docs/            方案文档
```

以后接入 codex / pi / step / agy：在 `src/main/agents/` 下按 Claude 的模式实现历史读取与会话驱动，
投影成同样的 `ConversationRow` 即可复用全部界面。

## 许可

Apache-2.0。复制自 ZCode 的代码保留原许可，见 [NOTICE.md](NOTICE.md)。
