// 对话时间线：按轮（turnId）分组渲染 ZCode v4 行。
// 用户气泡 / 助手正文 / 思考块 / 工具卡片分别复用 ZCode 的组件（见各 import）。
import { CopyIcon, GitBranchIcon, LoaderIcon, PencilIcon, RotateCcwIcon, Undo2Icon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { ForkMode, PermissionRequestEvent } from "@hcode/shared/types";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { hcode } from "../bridge";
import { formatDuration } from "../format";
import { ImageAttachments } from "../ImageAttachments";
import { FileAttachments } from "../FileAttachments";
import { useAppStore } from "../store/appStore";
import { useUiStore } from "../store/uiStore";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { PermissionCard } from "./PermissionCard";

interface Turn {
  turnId: string;
  header?: TurnHeaderRow;
  rows: ConversationRow[];
}

function groupTurns(rows: readonly ConversationRow[]): Turn[] {
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  for (const row of rows) {
    let turn = byId.get(row.turnId);
    if (!turn) {
      turn = { turnId: row.turnId, rows: [] };
      byId.set(row.turnId, turn);
      turns.push(turn);
    }
    if (row.kind === "turnHeader") turn.header = row;
    else turn.rows.push(row);
  }
  return turns;
}

const openExternal = (url: string) => void hcode.invoke("app:openExternal", url);

export function Timeline({
  rows,
  workspacePath,
  permissions,
  running,
  canFork,
  canResend,
  highlightedRowId,
}: {
  rows: readonly ConversationRow[];
  workspacePath: string;
  permissions: Readonly<Record<string, PermissionRequestEvent>>;
  running: boolean;
  /** 用户消息悬停时显示分叉 / 回退按钮。 */
  canFork: boolean;
  /** 用户消息悬停时显示编辑重发 / 重试按钮。 */
  canResend: boolean;
  highlightedRowId: number | null;
}) {
  const turns = useMemo(() => groupTurns(rows), [rows]);
  const lastUserRowId = useMemo(() => rows.findLast((row) => row.kind === "userInput")?.rowId ?? null, [rows]);
  return (
    <div className="flex flex-col gap-6">
      {turns.map((turn, index) => (
        <TurnView
          key={turn.turnId}
          turn={turn}
          workspacePath={workspacePath}
          permissions={permissions}
          isLast={index === turns.length - 1}
          running={running}
          canFork={canFork}
          canResend={canResend}
          lastUserRowId={lastUserRowId}
          highlightedRowId={highlightedRowId}
        />
      ))}
    </div>
  );
}

function TurnView({
  turn,
  workspacePath,
  permissions,
  isLast,
  running,
  canFork,
  canResend,
  lastUserRowId,
  highlightedRowId,
}: {
  turn: Turn;
  workspacePath: string;
  permissions: Readonly<Record<string, PermissionRequestEvent>>;
  isLast: boolean;
  running: boolean;
  canFork: boolean;
  canResend: boolean;
  lastUserRowId: number | null;
  highlightedRowId: number | null;
}) {
  const header = turn.header;
  const turnRunning = header?.state === "running" && isLast && running;
  const last = turn.rows.at(-1);
  const showThinking =
    turnRunning &&
    !(
      last &&
      ((last.kind === "assistantText" && last.state === "streaming") ||
        (last.kind === "reasoning" && last.state === "streaming") ||
        (last.kind === "toolCall" && last.status === "pendingApproval"))
    );

  return (
    <div className="flex flex-col gap-3">
      {turn.rows.map((row) => (
        <div key={row.rowId} data-search-row-id={row.rowId} className={row.rowId === highlightedRowId ? "rounded-lg ring-2 ring-primary/50" : undefined}>
          <RowView row={row} workspacePath={workspacePath} permissions={permissions} canFork={canFork} canResend={canResend} isLastUser={row.rowId === lastUserRowId} />
        </div>
      ))}
      {showThinking ? (
        <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
          <LoaderIcon className="size-4 animate-spin" />
          <span className="animate-pulse">正在处理…</span>
        </div>
      ) : null}
      {header && header.state !== "running" && header.activeMs !== undefined && hasAssistantWork(turn) ? (
        <TurnFooter header={header} />
      ) : null}
    </div>
  );
}

function hasAssistantWork(turn: Turn): boolean {
  return turn.rows.some((row) => row.kind !== "userInput");
}

function TurnFooter({ header }: { header: TurnHeaderRow }) {
  const label =
    header.state === "completedInterrupted"
      ? "已停止"
      : header.state === "failed"
        ? "出错"
        : "已处理";
  return (
    <div className="flex items-center gap-2 text-ui-sm text-foreground-subtlest">
      <span className="h-px flex-1 bg-border/60" />
      <span>
        {label}
        {header.activeMs ? ` · ${formatDuration(header.activeMs)}` : ""}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

const RowView = memo(function RowView({
  row,
  workspacePath,
  permissions,
  canFork,
  canResend,
  isLastUser,
}: {
  row: ConversationRow;
  workspacePath: string;
  permissions: Readonly<Record<string, PermissionRequestEvent>>;
  canFork: boolean;
  canResend: boolean;
  isLastUser: boolean;
}) {
  switch (row.kind) {
    case "userInput":
      return <UserBubble row={row} canFork={canFork} canResend={canResend} isLastUser={isLastUser} />;
    case "assistantText":
      return <AssistantText row={row} />;
    case "reasoning":
      return <ReasoningView row={row} />;
    case "toolCall": {
      const request = row.approvalInteractionId ? permissions[row.approvalInteractionId] : undefined;
      if (row.status === "pendingApproval" && request) {
        return <PermissionCard request={request} workspacePath={workspacePath} />;
      }
      return <ToolRow row={row} workspacePath={workspacePath} />;
    }
    case "timelineMarker":
      return row.marker.type === "compact" ? (
        <div className="flex items-center gap-2 text-ui-sm text-foreground-subtlest">
          <span className="h-px flex-1 bg-border/60" />
          <span>上下文已压缩</span>
          <span className="h-px flex-1 bg-border/60" />
        </div>
      ) : null;
    default:
      return null;
  }
});

const FORK_ACTIONS: { mode: ForkMode; label: string; hint: string; icon: typeof GitBranchIcon }[] = [
  { mode: "fork", label: "从这里分叉", hint: "新会话保留到这条消息及其回复，原会话不变", icon: GitBranchIcon },
  { mode: "rewind", label: "回退到这里", hint: "新会话只保留这条消息之前的内容，并把它放回输入框重新编辑；原会话不变，文件改动不会撤销", icon: Undo2Icon },
];

const copyText = (text: string) => {
  void hcode.invoke("app:copyText", text).then(() => toast("已复制"));
};

function ActionButton({ label, hint, icon: Icon, disabled, onClick }: {
  label: string;
  hint?: string;
  icon: typeof GitBranchIcon;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label} {...(hint ? { description: hint } : {})}>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}>
        <Icon />
      </Button>
    </ControlHintTooltip>
  );
}

function MessageActions({ row, canFork, canResend, isLastUser }: {
  row: UserInputRow;
  canFork: boolean;
  canResend: boolean;
  isLastUser: boolean;
}) {
  const forkFromMessage = useAppStore((state) => state.forkFromMessage);
  const retryMessage = useAppStore((state) => state.retryMessage);
  const editMessage = useAppStore((state) => state.editMessage);
  const [pending, setPending] = useState(false);
  return (
    <div className="flex gap-0.5 opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100">
      {row.text.trim() ? <ActionButton label="复制" icon={CopyIcon} onClick={() => copyText(row.text)} /> : null}
      {canResend ? (
        <ActionButton label="编辑后重发" hint="把这条消息放回输入框修改，作为新消息发送；原对话保留" icon={PencilIcon} onClick={() => editMessage(row.rowId)} />
      ) : null}
      {canResend && isLastUser ? (
        <ActionButton label="重试" hint="原样再发送一次这条消息" icon={RotateCcwIcon} onClick={() => void retryMessage(row.rowId)} />
      ) : null}
      {canFork
        ? FORK_ACTIONS.map(({ mode, label, hint, icon }) => (
            <ActionButton
              key={mode}
              label={label}
              hint={hint}
              icon={icon}
              disabled={pending}
              onClick={() => {
                setPending(true);
                void forkFromMessage(row.rowId, mode).finally(() => setPending(false));
              }}
            />
          ))
        : null}
    </div>
  );
}

function UserBubble({ row, canFork, canResend, isLastUser }: { row: UserInputRow; canFork: boolean; canResend: boolean; isLastUser: boolean }) {
  const images = (row.attachments ?? []).filter((attachment) => attachment.ref.startsWith("data:image/")).map((attachment) => ({ src: attachment.ref, name: attachment.fileName }));
  const files = (row.attachments ?? []).filter((attachment) => !attachment.ref.startsWith("data:image/")).map((attachment) => ({ path: attachment.ref, name: attachment.fileName, mimeType: attachment.mime, size: attachment.bytes }));
  return (
    <div className="group/user flex flex-col items-end gap-2">
      <ImageAttachments images={images} className="justify-end" />
      <FileAttachments files={files} className="justify-end" />
      {row.text.trim() ? (
        <div className="flex max-w-xl flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground">
          <ConversationUserInputBody contentText={row.text} rowId={row.rowId}>
            <ConversationUserInputContent text={row.text} />
          </ConversationUserInputBody>
        </div>
      ) : null}
      <MessageActions row={row} canFork={canFork} canResend={canResend} isLastUser={isLastUser} />
    </div>
  );
}

function AssistantText({ row }: { row: AssistantTextRow }) {
  const theme = useUiStore((state) => state.theme);
  const codePreviewSettings = useUiStore((state) => state.codePreviewSettings);
  const isOfficeMode = useIsOfficeMode();
  if (row.state === "failed") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-base whitespace-pre-wrap text-destructive">
        {row.text}
      </div>
    );
  }
  return (
    <div className="group/assistant w-full text-ui-base">
      <MessageResponse
        streaming={row.state === "streaming"}
        forceCodeWrap={isOfficeMode}
        streamingAnimationKey={String(row.rowId)}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenExternalUrl={openExternal}
      >
        {row.text}
      </MessageResponse>
      {row.state !== "streaming" && row.text.trim() ? (
        <div className="mt-1 flex opacity-0 transition-opacity group-hover/assistant:opacity-100 focus-within:opacity-100">
          <ActionButton label="复制" icon={CopyIcon} onClick={() => copyText(row.text)} />
        </div>
      ) : null}
    </div>
  );
}

function ReasoningView({ row }: { row: ReasoningRow }) {
  const streaming = row.state === "streaming";
  const durationSeconds =
    row.durationMs === undefined ? undefined : Math.max(1, Math.ceil(row.durationMs / 1000));
  if (!streaming && !row.text.trim()) return null;
  return (
    <Reasoning
      className="w-full"
      isStreaming={streaming}
      autoCollapseKey={row.state}
      {...(durationSeconds === undefined ? {} : { duration: durationSeconds })}
    >
      <ReasoningTrigger streamingText={row.text} />
      <ReasoningContent>{row.text}</ReasoningContent>
    </Reasoning>
  );
}

const ToolRow = memo(function ToolRow({ row, workspacePath }: { row: ToolCallRow; workspacePath: string }) {
  const theme = useUiStore((state) => state.theme);
  const codePreviewSettings = useUiStore((state) => state.codePreviewSettings);
  const node = useMemo(() => toolCallRowToLegacyNode(row), [row]);
  return (
    <ToolCallBlock
      toolCallNode={node}
      workspacePath={workspacePath}
      theme={theme}
      codePreviewSettings={codePreviewSettings}
      showTodoToolCalls
      onOpenBrowserUrl={openExternal}
      onOpenFileLink={(target) => void hcode.invoke("app:openPath", target.path)}
    />
  );
});
