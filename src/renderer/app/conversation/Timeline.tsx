import { readAsyncReply } from "@hcode/shared/codexAsyncQuestions";
// 对话时间线：按轮（turnId）分组渲染 ZCode v4 行。
// 用户气泡 / 助手正文 / 思考块 / 工具卡片分别复用 ZCode 的组件（见各 import）。
import { presentationBelongsToSource, presentationTaskForTurn } from "@hcode/shared/collaborationPresentation";
import type { PresentationConversation } from "@hcode/shared/collaborationPresentation";
import { usePresentationStore } from "../collaboration/presentationStore";
import { ExpertConversationResult } from "../collaboration/ExpertConversationResult";
import { presentationContent } from "@hcode/shared/collaborationPresentation";
import { CollaborationProgress } from "../collaboration/CollaborationProgress";
import { AlertCircleIcon, BrainIcon, ChevronRightIcon, CopyIcon, FilePenIcon, GitBranchIcon, PencilIcon, RotateCcwIcon, SearchIcon, TerminalIcon, Undo2Icon } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { ForkMode, PermissionRequestEvent } from "@hcode/shared/types";
import { isTurnStartInput } from "@hcode/shared/conversationTurns";
import { lostContextAfterCompaction } from "@hcode/shared/conversationChanges";
import { Button } from "@/components/ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildConversationTurnRenderUnits,
  type AssistantWorkRow,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationTurnWorkSegment, ConversationTurnWorkStatus } from "@/v4/conversationTurnWorkSegments.js";
import {
  formatAssistantSummaryStatistics,
  getAssistantSummaryIconCategory,
  groupConsecutiveAssistantSummaries,
} from "@/v4/conversationAssistantWorkItems.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { ChatLoading } from "./ChatLoading";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { hcode, isRemote } from "../bridge";
import { REMOTE_MEDIA_PATH } from "@hcode/shared/remoteControl";
import { formatDuration } from "../format";
import { ImageAttachments } from "../ImageAttachments";
import { FileAttachments } from "../FileAttachments";
import { useAppStore } from "../store/appStore";
import { useUiStore } from "../store/uiStore";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { PermissionCard } from "./PermissionCard";
import { useFilePreview } from "./FilePreviewContext";
import { ToolDetailsContext } from "@/ToolCallBlocks/ToolDetailsContext.js";
import { useRemoteToolDetails } from "./useRemoteToolDetails";
import { TurnChangeSummary } from "./TurnChangeSummary";

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
  presentation,
  workspacePath,
  permissions,
  running,
  canFork,
  canResend,
  highlightedRowId,
  warnCompactionContextLoss = false,
}: {
  presentation?: PresentationConversation & { viewId: string };
  rows: readonly ConversationRow[];
  workspacePath: string;
  permissions: Readonly<Record<string, PermissionRequestEvent>>;
  running: boolean;
  /** 用户消息悬停时显示分叉 / 回退按钮。 */
  canFork: boolean;
  /** 用户消息悬停时显示编辑重发 / 重试按钮。 */
  canResend: boolean;
  highlightedRowId: number | null;
  /** 压缩可能不带摘要的代理（Codex）才提示核对任务，避免对保留摘要的代理误报。 */
  warnCompactionContextLoss?: boolean;
}) {
  const entries = usePresentationStore(state => state.entries);
  const turns = useMemo(() => groupTurns(rows), [rows]);
  const units = useMemo(() => new Map(buildConversationTurnRenderUnits(rows).map((unit) => [unit.turnId, unit])), [rows]);
  const lastUserRowId = useMemo(() => rows.findLast(isTurnStartInput)?.rowId ?? null, [rows]);
  return (
    <div className="flex flex-col gap-6">
      {turns.map((turn, index) => {
        const owned = presentation ? presentationTaskForTurn(entries, presentation, turn.turnId) : undefined;
        const content = <TurnView key={turn.turnId} turn={turn} unit={units.get(turn.turnId)} workspacePath={workspacePath} permissions={permissions} isLast={index === turns.length - 1} running={running} canFork={owned ? false : canFork} canResend={owned ? false : canResend} lastUserRowId={lastUserRowId} highlightedRowId={highlightedRowId} warnCompactionContextLoss={warnCompactionContextLoss} />;
        if (!owned || Object.keys(permissions).length) return content;
        const highlighted = turn.rows.some(row => row.rowId === highlightedRowId);
        const isSource = presentation && presentationBelongsToSource(owned.entry, presentation);
        return <div key={turn.turnId} className="space-y-3">
          {isSource && presentation && owned.entry.experts?.summary && presentationContent(owned.entry, owned.task).summary
            ? <ExpertConversationResult entry={owned.entry} viewId={presentation.viewId} />
            : <CollaborationProgress entry={owned.entry} task={owned.task} viewId={isSource ? presentation?.viewId : undefined} />}
          <details open={highlighted ? true : undefined} className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-ui-sm text-foreground-subtle focus-visible:ring-2 focus-visible:ring-ring">原始提示词与原生响应</summary>
            <div className="mt-4">{content}</div>
          </details>
        </div>;
      })}
    </div>
  );
}

function TurnView({
  turn,
  unit,
  workspacePath,
  permissions,
  isLast,
  running,
  canFork,
  canResend,
  lastUserRowId,
  highlightedRowId,
  warnCompactionContextLoss,
}: {
  turn: Turn;
  unit?: ConversationTurnRenderUnit;
  workspacePath: string;
  permissions: Readonly<Record<string, PermissionRequestEvent>>;
  isLast: boolean;
  running: boolean;
  canFork: boolean;
  canResend: boolean;
  lastUserRowId: number | null;
  highlightedRowId: number | null;
  warnCompactionContextLoss: boolean;
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
  const renderRow = (row: ConversationRow) => (
    <div key={row.rowId} data-search-row-id={row.rowId} className={row.rowId === highlightedRowId ? "rounded-lg ring-2 ring-primary/50" : undefined}>
      <RowView row={row} workspacePath={workspacePath} permissions={permissions} canFork={canFork} canResend={canResend} isLastUser={row.rowId === lastUserRowId} />
    </div>
  );
  const work: WorkContext = {
    turnRunning,
    tailRowId: unit?.assistantWorkRows.at(-1)?.rowId,
    failed: header?.state === "failed",
    workspacePath,
    highlightedRowId,
    renderRow,
  };

  return (
    <div className="flex flex-col gap-3">
      {unit?.leadingBoundaryRows.map(renderRow)}
      {unit ? turnWorkSegments(unit).map((segment) => <WorkSegment key={segment.key} segment={segment} work={work} />) : null}
      {unit?.assistantTailRows.map(renderRow)}
      {unit?.browserTurnEndRows.map(renderRow)}
      {header && header.state !== "running" ? <TurnChangeSummary rows={turn.rows} /> : null}
      {warnCompactionContextLoss && header?.state === "completedSuccess" && lostContextAfterCompaction(turn.rows) ? (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-ui-sm text-foreground-subtle">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>上下文压缩后本轮没有文件改动就结束了，可能已丢失任务上下文。请核对回复，必要时重新说明任务和工作目录。</p>
        </div>
      ) : null}
      {showThinking ? (
        <ChatLoading startedAt={header?.startedAt} />
      ) : null}
    </div>
  );
}

interface WorkContext {
  turnRunning: boolean;
  /** 整轮最后一条工作行：只有包含它的摘要组在运行中仍可继续追加。 */
  tailRowId: number | undefined;
  failed: boolean;
  workspacePath: string;
  highlightedRowId: number | null;
  renderRow: (row: ConversationRow) => ReactNode;
}

function turnWorkSegments(unit: ConversationTurnRenderUnit): ConversationTurnWorkSegment[] {
  if (unit.workSegments?.length) return unit.workSegments;
  return [{
    key: unit.key,
    flowItems: unit.flowItems,
    assistantWorkRows: unit.assistantWorkRows,
    assistantHistoryRows: unit.assistantHistoryRows,
    assistantFollowingRows: unit.assistantFollowingRows,
    assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
    ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
  }];
}

// 照 ZCode ConversationWorkSegmentFlow：完成后把思考、工具和中间正文收进“已工作 N”，最终答复留在外面。
function WorkSegment({ segment, work }: { segment: ConversationTurnWorkSegment; work: WorkContext }) {
  const [historyOpen, setHistoryOpen] = useState(segment.assistantHistoryDefaultOpen);
  useEffect(() => {
    setHistoryOpen(segment.assistantHistoryDefaultOpen);
  }, [segment.assistantHistoryDefaultOpen, segment.key]);
  const pinned = work.turnRunning || segment.assistantHistoryDefaultOpen;
  const highlighted = work.highlightedRowId !== null && segment.assistantHistoryRows.some((row) => row.rowId === work.highlightedRowId);
  const open = pinned || historyOpen || highlighted;
  const status = !work.turnRunning && segment.workStatus && segment.workStatus.state !== "running" ? segment.workStatus : undefined;
  const firstAssistantIndex = segment.flowItems.findIndex((item) => item.kind !== "userInput");
  const statusHeader = status ? <WorkStatusHeader status={status} failed={work.failed} open={open} collapsible={!pinned} /> : null;

  return (
    <Collapsible
      open={open}
      onOpenChange={pinned ? undefined : setHistoryOpen}
      // flex gap 不计入 Radix 测量的内容高度，收起动画末帧会跳；兄弟节点改用外边距，history 的间距放进动画层。
      className="flex flex-col [&>*+*:not([data-slot='collapsible-content'])]:mt-3"
    >
      {segment.flowItems.map((item, index) => {
        let content: ReactNode;
        if (item.kind === "userInput" || item.kind === "assistantText") content = work.renderRow(item.row);
        else if (item.kind === "assistantHistory") {
          content = (
            <CollapsibleContent className="-mx-1 -mb-1 px-1 pb-1">
              <div className="pt-3"><WorkRows rows={item.rows} work={work} /></div>
            </CollapsibleContent>
          );
        } else content = <WorkRows rows={item.rows} work={work} />;
        const key = item.kind === "userInput" || item.kind === "assistantText" ? `${item.kind}:${item.row.rowId}` : item.kind === "cuaGroup" ? item.key : `${item.kind}:${item.rows[0]?.rowId}`;
        return (
          <Fragment key={key}>
            {index === firstAssistantIndex ? statusHeader : null}
            {content}
          </Fragment>
        );
      })}
      {firstAssistantIndex < 0 ? statusHeader : null}
    </Collapsible>
  );
}

function WorkStatusHeader({ status, failed, open, collapsible }: {
  status: ConversationTurnWorkStatus;
  failed: boolean;
  open: boolean;
  collapsible: boolean;
}) {
  const duration = status.durationMs ? formatDuration(status.durationMs) : undefined;
  const label =
    status.state === "interrupted"
      ? "已停止"
      : failed
        ? "出错"
        : duration
          ? `已工作 ${duration}`
          : "已处理";
  const text = status.state === "completed" && !failed ? label : `${label}${duration ? ` · ${duration}` : ""}`;
  const Status = collapsible ? CollapsibleTrigger : "span";
  return (
    <div className="flex w-full items-center border-b border-border/50 pb-2">
      <Status className="inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused">
        <span className="truncate">{text}</span>
        {collapsible ? (
          <ChevronRightIcon aria-hidden className={cn("size-4 shrink-0 text-foreground-subtlest opacity-70 transition-transform", open && "rotate-90")} />
        ) : null}
      </Status>
    </div>
  );
}

function WorkRows({ rows, work }: { rows: readonly AssistantWorkRow[]; work: WorkContext }) {
  const groups = useMemo(() => groupConsecutiveAssistantSummaries(rows), [rows]);
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) =>
        group.length < 2
          ? work.renderRow(group[0]!)
          : <SummaryGroup key={`group:${group[0]!.rowId}`} rows={group} work={work} />,
      )}
    </div>
  );
}

const SUMMARY_ICONS = { explore: SearchIcon, run: TerminalIcon, change: FilePenIcon } as const;

// 照 ZCode ConsecutiveSummaryGroup：相邻思考/查阅/执行/修改收成一行统计，点开看明细。
function SummaryGroup({ rows, work }: { rows: readonly AssistantWorkRow[]; work: WorkContext }) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const running = work.turnRunning && work.tailRowId === rows.at(-1)?.rowId;
  const highlighted = work.highlightedRowId !== null && rows.some((row) => row.rowId === work.highlightedRowId);
  const statistics = formatAssistantSummaryStatistics(rows, intl, work.workspacePath, !running);
  const category = getAssistantSummaryIconCategory(rows);
  const Icon = category ? SUMMARY_ICONS[category] : BrainIcon;
  const expanded = open || highlighted;
  return (
    <Collapsible open={expanded} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger
        aria-label={statistics}
        className="group/tool-summary flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-2 text-ui-base text-foreground-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      >
        <Icon className="size-4 shrink-0" />
        <span title={statistics} className={cn("min-w-0 truncate", running && "animated-gradient-text")}>
          {statistics}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-foreground-subtlest opacity-0 transition-[transform,opacity] group-hover/tool-summary:opacity-100 group-focus-visible/tool-summary:opacity-100",
            expanded && "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 max-h-[calc(16lh+30*var(--spacing))] overflow-y-auto">
          {/* 导线不占布局，ml-2 + pl-4 让明细与组头文字对齐。 */}
          <div className="relative ml-2 flex flex-col gap-2 pl-4 before:absolute before:inset-y-0 before:left-0 before:border-l before:border-border">
            {rows.map(work.renderRow)}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
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
      // 回合中途的插话不是回合起点：不能作为分叉 / 回退锚点
      return <UserBubble row={row} canFork={canFork && !row.guided} canResend={canResend} isLastUser={isLastUser} />;
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
      {canFork && !isRemote
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
  const preview = useFilePreview();
  const replies = readAsyncReply(row.text);
  const displayText = replies.length ? replies.map(reply => reply.answer).join("\n") : row.text;
  const imageAttachment = (ref: string) => ref.startsWith("data:image/") || ref.startsWith(REMOTE_MEDIA_PATH);
  const images = (row.attachments ?? []).filter((attachment) => imageAttachment(attachment.ref)).map((attachment) => ({ src: attachment.ref, name: attachment.fileName }));
  const files = (row.attachments ?? []).filter((attachment) => !imageAttachment(attachment.ref)).map((attachment) => ({ path: attachment.ref, name: attachment.fileName, mimeType: attachment.mime, size: attachment.bytes }));
  return (
    <div className="group/user flex flex-col items-end gap-2">
      {row.guided ? <span className="text-ui-xs text-foreground-subtlest">已插话</span> : null}
      <ImageAttachments images={images} className="justify-end" />
      <FileAttachments files={files} className="justify-end" onPreview={preview?.onOpenFilePath} />
      {row.text.trim() ? (
        <div className="flex min-w-0 max-w-[min(100%,var(--container-xl))] flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground">
          <ConversationUserInputBody contentText={displayText} rowId={row.rowId}>
            <ConversationUserInputContent text={displayText} onOpenFile={preview?.onOpenFilePath} />
          </ConversationUserInputBody>
        </div>
      ) : null}
      <MessageActions row={row} canFork={canFork} canResend={canResend} isLastUser={isLastUser} />
    </div>
  );
}

function AssistantText({ row }: { row: AssistantTextRow }) {
  const preview = useFilePreview();
  const theme = useUiStore((state) => state.theme);
  const codePreviewSettings = useUiStore((state) => state.codePreviewSettings);
  const isOfficeMode = useIsOfficeMode();
  // 回调必须保持引用稳定：MessageResponse 的 markdown 组件表依赖它，
  // 流式输出时每个 token 都会重渲染，内联箭头函数会让文件链接整体重挂载，图标反复重新加载而闪烁。
  const rowId = row.rowId;
  const handleOpenFileLink = useCallback(
    (target: Parameters<NonNullable<typeof preview>["onOpenFileLink"]>[0]) => preview?.onOpenFileLink(target, rowId),
    [preview, rowId],
  );
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
        onOpenFileLink={preview ? handleOpenFileLink : undefined}
        onOpenCodeViewer={preview?.onOpenCodeViewer}
        workspacePath={preview?.workspacePath}
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
  const preview = useFilePreview();
  const theme = useUiStore((state) => state.theme);
  const codePreviewSettings = useUiStore((state) => state.codePreviewSettings);
  const detail = useRemoteToolDetails(row);
  const node = useMemo(() => toolCallRowToLegacyNode(detail.row), [detail.row]);
  return (
    <ToolDetailsContext.Provider value={detail.details}><ToolCallBlock
      toolCallNode={node}
      workspacePath={workspacePath}
      theme={theme}
      codePreviewSettings={codePreviewSettings}
      showTodoToolCalls
      onOpenBrowserUrl={openExternal}
      onOpenFileLink={preview?.onOpenFileLink}
      onOpenCodeViewer={preview?.onOpenCodeViewer}
    /></ToolDetailsContext.Provider>
  );
});
