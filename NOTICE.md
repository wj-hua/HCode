# NOTICE

HCode 包含复制自 ZCode v3.14（Apache License 2.0，许可证副本见 LICENSE.zcode）的源代码：

- `src/renderer/zcode/`：来自 ZCode `packages/ui/src`（部分文件被替换为 HCode shim，文件头有注明）
- `vendor/zcode-shared/`、`vendor/zcode-model-option-map/`：来自 ZCode `packages/shared`、`packages/model-option-map`
- `src/main/util/loginShellEnv.ts`：来自 ZCode `packages/services/src/runtime-tools/runtimeLoginShellEnvCapture.ts`
- `src/main/window.ts` 中的 macOS 窗口参数参照 ZCode `packages/desktop/src/main/desktopWindowChrome.ts`

“不在项目中工作”功能参照 [ZCode](https://github.com/zai-org/ZCode) 的 `packages/ui/src/root/useConversationWorkspaceActions.ts`、`packages/ui/src/ChatEmptyState.tsx` 与 `packages/services/src/file/fileService.ts`，适配为 HCode 的多 CLI 会话、应用数据目录和 IPC：`src/main/conversationWorkspace.ts`、`src/renderer/app/store/conversationWorkspaceActions.ts`、`src/renderer/app/shell/ConversationSection.tsx` 及输入框项目菜单。

ZCode 自身包含的第三方派生代码：`components/ui` 派生自 shadcn/ui（MIT），`components/ai-elements`
派生自 Vercel AI Elements（Apache-2.0），详见 ZCode `third-party/copied-components.json` 与 `THIRD-PARTY-NOTICES.md`。
