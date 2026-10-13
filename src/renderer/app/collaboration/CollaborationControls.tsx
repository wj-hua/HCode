// 将用户的接管、澄清与续跑动作交给主进程；本组件不推断原生停止状态。
import { usagePresentation } from "@hcode/shared/collaborationPresentation";
import { codeCandidates, deliveryCode } from "@hcode/shared/codeCandidates";
import { useState } from "react";
import { COLLABORATION_LIMITS } from "@hcode/shared/collaboration";
import type { CollaborationSnapshot, TaskMessage } from "@hcode/shared/collaboration";
import { Button } from "@/components/ui/button.js";
import { bindCollaborationSource } from "./sourceConversation";
import { hcode } from "../bridge";

function ContextReply({ runId, question }: { runId: string; question: TaskMessage }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reply = async () => {
    setBusy(true); setError("");
    try { await hcode.invoke("collaboration:reply", runId, question.id, text); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void reply(); }} className="rounded-lg border border-border p-3">
    <p className="font-medium">{question.requiresUser ? "需要你的决定" : "执行者请求上下文"}</p>
    <p className="mt-1 whitespace-pre-wrap">{question.text}</p>
    <label className="mt-2 flex flex-col gap-1">回复<textarea required maxLength={COLLABORATION_LIMITS.maxContextLength} value={text} onChange={(event) => setText(event.target.value)} rows={2} className="rounded-md border border-border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring" /></label>
    <Button type="submit" className="mt-2" disabled={busy || !text.trim()}>{busy ? "正在保存…" : "保存回复"}</Button>
    {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
  </form>;
}

import { adoptionBlocksEdits } from "@hcode/shared/codeAdoption";
export function CollaborationControls({ run }: { run: CollaborationSnapshot }) {
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = run.status === "running" || run.status === "stopping";
  const isCode=codeCandidates(run).length>0;
  const resumable = !active && run.status !== "cancelled" && !adoptionBlocksEdits(run.code?.adoption);
  const pending = (run.messages ?? []).filter((entry) => entry.type === "clarification" && !run.messages?.some((reply) => reply.replyTo === entry.id));
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await operation(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const resume = (deliveryId: string, action: "execute" | "review") => act(async () => {
    bindCollaborationSource(run);
    await hcode.invoke("collaboration:resume", run.id, { deliveryId, action, ...(context.trim() ? { context } : {}) });
  });
  const usage = usagePresentation(run.tasks);
  return <div className="flex flex-col gap-3">
    <details><summary className="cursor-pointer text-ui-sm text-foreground-subtle">回合与用量 · {run.tasks.length} 个回合</summary><p className="mt-2 text-ui-sm text-foreground-subtle">已用 {run.tasks.length} / {run.experts?.turnLimit ?? COLLABORATION_LIMITS.maxTurns} 回合 · 最多 {COLLABORATION_LIMITS.maxConcurrentWorkers} 个执行 / 审查回合并发。{usage.knownTurns ? `已知输入 ${usage.inputTokens}，输出 ${usage.outputTokens} Token；` : '未提供可信 Token 用量；'}{usage.unknownTurns} 个回合用量未知。额度不足会明确失败，不自动换模型。</p></details>
    <details open={active || pending.length > 0 || ['awaitingUser', 'failed', 'interrupted', 'paused'].includes(run.status) ? true : undefined}><summary className="cursor-pointer text-ui-sm">{active ? '协作控制' : '补充与继续'}</summary><div className="mt-3 flex flex-col gap-3">
    {active ? <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy || run.status === "stopping"} onClick={() => void act(() => hcode.invoke("collaboration:pause", run.id))}>暂停并接管</Button>
      <Button variant="destructive" disabled={busy || run.stopIntent === "cancel"} onClick={() => void act(() => hcode.invoke("collaboration:cancel", run.id))}>停止本次协作</Button>
      {run.status === "stopping" ? <p role="status">等待原生确认，当前仍不能接管。</p> : null}
    </div> : null}
    {run.status !== "cancelled" && run.status !== "stopping" ? pending.map((question) => <ContextReply key={question.id} runId={run.id} question={question} />) : null}
    {resumable && run.deliveries.length ? <>
      <label className="flex flex-col gap-1">补充上下文（可选）<textarea value={context} maxLength={COLLABORATION_LIMITS.maxContextLength} onChange={(event) => setContext(event.target.value)} rows={2} placeholder={isCode ? "说明需要修订的候选内容；原项目保持不变" : "说明需要修订的内容；仍限于只读调研"} className="rounded-md border border-border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <p className="text-ui-sm text-foreground-subtle">保存回复后选择具体任务继续。续跑保留历史与累计预算，先核对源码及报告；重启后不会自动执行。</p>
    </> : null}
    {run.deliveries.map((delivery, index) => <div key={delivery.id} className="flex flex-wrap items-center gap-2">
      <span className="text-ui-sm">任务 {index + 1} · {delivery.requestKey}</span>
      {active && ["queued", "executing", "reviewing", "revising"].includes(delivery.status) ? <Button variant="outline" disabled={busy} onClick={() => void act(() => hcode.invoke("collaboration:cancelDelivery", run.id, delivery.id))}>停止此任务</Button> : null}
      {resumable && delivery.status !== "cancelled" && !adoptionBlocksEdits(deliveryCode(run,delivery)?.adoption) && deliveryCode(run,delivery)?.workspace.state!=="discarded" ? <>
        <Button variant="outline" disabled={busy || pending.some((message) => message.deliveryId === delivery.id)} onClick={() => void resume(delivery.id, "execute")}>{isCode ? "重新实现 / 修订" : delivery.status === "accepted" ? "重新调研" : "恢复 / 重新执行"}</Button>
        <Button variant="outline" disabled={busy || !delivery.versions.length || pending.some((message) => message.deliveryId === delivery.id)} onClick={() => void resume(delivery.id, "review")}>{isCode ? "重新验证并审查候选" : "重新审查最新报告"}</Button>
      </> : null}
    </div>)}
    {run.messages?.length ? <details><summary className="cursor-pointer">澄清与回复记录（{run.messages.length}）</summary>{run.messages.map((message) => <p key={message.id} className="mt-2 whitespace-pre-wrap"><span className="font-medium">{message.sender === "worker" ? "执行者提问" : message.sender === "user" ? "用户" : "发起 AI"}：</span>{message.text}</p>)}</details> : null}
    </div></details>
    {busy ? <p role="status">正在处理，请等待状态确认…</p> : null}
    {error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{error}</p> : null}
  </div>;
}
