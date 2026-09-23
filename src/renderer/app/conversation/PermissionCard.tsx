// 工具审批卡片：普通工具复用 ZCode 的 PermissionDialog；AskUserQuestion / ExitPlanMode 用专用卡片。
import { CheckIcon, ClipboardListIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { PermissionRequestEvent } from "@hcode/shared/types";
import type { ZCodePermissionOption, ZCodePermissionRequest } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { cn } from "@/components/lib/utils.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { useAppStore } from "../store/appStore";
import { useUiStore } from "../store/uiStore";

export function PermissionCard({
  request,
  workspacePath,
}: {
  request: PermissionRequestEvent;
  workspacePath: string;
}) {
  if (request.toolName === "AskUserQuestion") return <QuestionCard request={request} />;
  if (request.toolName === "ExitPlanMode") return <PlanApprovalCard request={request} />;
  return <ToolPermissionCard request={request} workspacePath={workspacePath} />;
}

function ToolPermissionCard({
  request,
  workspacePath,
}: {
  request: PermissionRequestEvent;
  workspacePath: string;
}) {
  const respondPermission = useAppStore((state) => state.respondPermission);
  const [responding, setResponding] = useState(false);

  const zcodeRequest = useMemo<ZCodePermissionRequest>(() => {
    const allow = { decision: "allow" } as ZCodePermissionOption["response"];
    const deny = { decision: "deny" } as ZCodePermissionOption["response"];
    const options: ZCodePermissionOption[] = [
      { optionId: "allow", kind: "allow_once", name: "允许", response: allow },
      ...(request.canAllowForSession
        ? [{ optionId: "allowSession", kind: "allow_always", name: "本会话总是允许", response: allow }]
        : []),
      { optionId: "deny", kind: "reject_once", name: "拒绝", response: deny },
    ];
    const description =
      request.title ??
      [request.description, request.decisionReason].filter(Boolean).join(" · ") ??
      request.toolName;
    return {
      type: "permission_request",
      taskId: request.sessionKey,
      traceId: request.sessionKey as ZCodePermissionRequest["traceId"],
      requestId: request.interactionId,
      description: description || request.toolName,
      kind: request.toolName,
      ...(request.title ? { title: request.title } : {}),
      options,
      freeText: true,
      raw: { toolName: request.toolName, rawInput: request.input, input: request.input },
    };
  }, [request]);

  return (
    <PermissionDialog
      request={zcodeRequest}
      workspacePath={workspacePath}
      responding={responding}
      onRespond={(interactionId, option, feedback) => {
        setResponding(true);
        const decision =
          option.optionId === "allow"
            ? ({ decision: "allow" } as const)
            : option.optionId === "allowSession"
              ? ({ decision: "allowSession" } as const)
              : ({ decision: "deny", ...(feedback?.trim() ? { message: feedback.trim() } : {}) } as const);
        void respondPermission(interactionId, decision).finally(() => setResponding(false));
      }}
    />
  );
}

interface QuestionOption {
  label: string;
  description?: string;
}
interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

function readQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.filter(
    (item): item is Question =>
      typeof item === "object" && item !== null && typeof (item as Question).question === "string",
  );
}

function QuestionCard({ request }: { request: PermissionRequestEvent }) {
  const respondPermission = useAppStore((state) => state.respondPermission);
  const questions = useMemo(() => readQuestions(request.input), [request.input]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const answers = Object.fromEntries(
    questions.map((q) => {
      const picks = [...(selected[q.question] ?? [])];
      const custom = other[q.question]?.trim();
      if (custom) picks.push(custom);
      return [q.question, picks.join(", ")];
    }),
  );
  const complete = questions.every((q) => answers[q.question]);

  const toggle = (question: Question, label: string) => {
    setSelected((state) => {
      const current = state[question.question] ?? [];
      const next = question.multiSelect
        ? current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label]
        : [label];
      return { ...state, [question.question]: next };
    });
    if (!question.multiSelect) setOther((state) => ({ ...state, [question.question]: "" }));
  };

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
        <MessageCircleQuestionIcon className="size-4 text-brand" />
        需要你做个选择
      </div>
      {questions.map((question) => (
        <div key={question.question} className="flex flex-col gap-2">
          <div className="text-ui-base text-foreground">
            {question.header ? (
              <span className="mr-2 rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
                {question.header}
              </span>
            ) : null}
            {question.question}
            {question.multiSelect ? <span className="ml-1 text-foreground-subtlest">（可多选）</span> : null}
          </div>
          <div className="flex flex-col gap-1">
            {question.options.map((option) => {
              const active = (selected[question.question] ?? []).includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => toggle(question, option.label)}
                  className={cn(
                    "flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                    active
                      ? "border-brand/60 bg-brand/8"
                      : "border-border hover:border-border-hover hover:bg-surface-hover",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                      active ? "border-brand bg-brand text-foreground-inverse" : "border-border",
                    )}
                  >
                    {active ? <CheckIcon className="size-3" /> : null}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-ui-base text-foreground">{option.label}</span>
                    {option.description ? (
                      <span className="text-ui-sm text-foreground-subtle">{option.description}</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            <input
              value={other[question.question] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setOther((state) => ({ ...state, [question.question]: value }));
                if (!question.multiSelect && value) {
                  setSelected((state) => ({ ...state, [question.question]: [] }));
                }
              }}
              placeholder="其他（自己填写）"
              className="h-9 rounded-lg border border-input-border bg-input px-3 text-ui-base text-foreground outline-none focus:border-input-border-focused"
            />
          </div>
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="lg"
          disabled={submitting}
          onClick={() => {
            setSubmitting(true);
            void respondPermission(request.interactionId, {
              decision: "deny",
              message: "用户跳过了这个问题",
            });
          }}
        >
          跳过
        </Button>
        <Button
          size="lg"
          disabled={!complete || submitting}
          className="bg-brand text-foreground-inverse hover:bg-brand/80"
          onClick={() => {
            setSubmitting(true);
            void respondPermission(request.interactionId, {
              decision: "allow",
              updatedInput: { ...request.input, answers },
            });
          }}
        >
          提交
        </Button>
      </div>
    </div>
  );
}

function PlanApprovalCard({ request }: { request: PermissionRequestEvent }) {
  const respondPermission = useAppStore((state) => state.respondPermission);
  const setPermissionMode = useAppStore((state) => state.setPermissionMode);
  const theme = useUiStore((state) => state.theme);
  const codePreviewSettings = useUiStore((state) => state.codePreviewSettings);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const plan = typeof request.input.plan === "string" ? request.input.plan : "";

  const approve = async (mode: "acceptEdits" | "default") => {
    setSubmitting(true);
    await setPermissionMode(mode);
    await respondPermission(request.interactionId, { decision: "allow" });
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
        <ClipboardListIcon className="size-4 text-brand" />
        Claude 制定了执行计划，是否开始执行？
      </div>
      {plan ? (
        <div className="max-h-96 overflow-y-auto rounded-lg border border-border bg-background px-4 py-3">
          <MessageResponse theme={theme} codePreviewSettings={codePreviewSettings}>
            {plan}
          </MessageResponse>
        </div>
      ) : null}
      <Textarea
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        placeholder="如需修改计划，在这里写下意见，然后点“继续规划”"
        className="min-h-16 text-ui-base"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="lg"
          disabled={submitting}
          onClick={() => {
            setSubmitting(true);
            void respondPermission(request.interactionId, {
              decision: "deny",
              message: feedback.trim() || "用户希望继续完善计划",
            });
          }}
        >
          继续规划
        </Button>
        <Button variant="outline" size="lg" disabled={submitting} onClick={() => void approve("default")}>
          批准（逐条审批）
        </Button>
        <Button
          size="lg"
          disabled={submitting}
          className="bg-brand text-foreground-inverse hover:bg-brand/80"
          onClick={() => void approve("acceptEdits")}
        >
          批准并自动接受编辑
        </Button>
      </div>
    </div>
  );
}
