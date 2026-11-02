// 固定在所属会话输入框上方。异步问题可以在工作继续时回答，不占用审批状态或聊天草稿。
import { useId, useMemo, useState, type FormEvent } from "react";
import { MessageCircleQuestionIcon } from "lucide-react";
import { pendingAsyncQuestions, type AsyncQuestion } from "@hcode/shared/codexAsyncQuestions";
import { Button } from "@/components/ui/button.js";
import { useActiveCollaboration } from "../collaboration/useCollaborationSession";
import { useAppStore, type Conversation } from "../store/appStore";

export function CodexAsyncQuestionPanel({ conversation }: { conversation: Conversation }) {
  const collaboration = useActiveCollaboration(conversation);
  const questions = useMemo(() => pendingAsyncQuestions(conversation.rows), [conversation.rows]);
  const remaining = questions.filter(question => conversation.asyncAnswerStates?.[question.id] !== "sent");
  const question = remaining[0];
  if (!question || collaboration) return null;
  return <QuestionForm key={question.id} question={question} viewId={conversation.viewId}
    remaining={remaining.length} sending={conversation.asyncAnswerStates?.[question.id] === "sending"} />;
}

function QuestionForm({ question, viewId, remaining, sending }: {
  question: AsyncQuestion; viewId: string; remaining: number; sending: boolean;
}) {
  const group = useId();
  const submitAnswer = useAppStore(state => state.answerAsyncQuestion);
  const [selected, setSelected] = useState<number | null>(question.options.length ? 0 : null);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");
  const answer = selected === null ? custom.trim() : question.options[selected];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!answer || sending) return;
    setError("");
    try { await submitAnswer(viewId, question.id, answer); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return (
    <form aria-label="Codex 异步提问" onSubmit={submit}
      className="mb-2 flex max-h-[40dvh] min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-3 text-ui-base text-foreground">
      <div className="flex items-center gap-2 font-medium">
        <MessageCircleQuestionIcon aria-hidden="true" className="size-4 shrink-0 text-brand" />
        Codex 有个问题{remaining > 1 && <span className="text-ui-sm text-foreground-subtle">剩余 {remaining} 题</span>}
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-1 py-1">
        <fieldset disabled={sending} className="min-w-0 space-y-1">
          <legend className="mb-2 whitespace-pre-wrap font-medium [overflow-wrap:anywhere]">{question.title}</legend>
          {question.options.map((option, index) => (
            <label key={index} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 hover:bg-surface-hover focus-within:ring-1 focus-within:ring-brand">
              <input type="radio" name={group} checked={selected === index} onChange={() => setSelected(index)} className="mt-1 shrink-0 accent-brand" />
              <span className="[overflow-wrap:anywhere]">{option}</span>
            </label>
          ))}
          <div className="flex flex-col gap-1 text-ui-sm text-foreground-subtle">
            <label htmlFor={group + "-answer"}>{question.options.length ? "其他回答" : "你的回答"}</label>
            <input id={group + "-answer"} value={custom} onFocus={() => { if (custom.trim()) setSelected(null); }} onChange={event => { setSelected(null); setCustom(event.target.value); }}
              className="h-10 rounded-lg border border-input-border bg-input px-3 text-ui-base text-foreground focus-visible:outline-brand" />
          </div>
        </fieldset>
      </div>
      {error && <p role="alert" className="text-ui-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={sending || !answer}>{sending ? "正在发送…" : "发送回答"}</Button>
      </div>
    </form>
  );
}
