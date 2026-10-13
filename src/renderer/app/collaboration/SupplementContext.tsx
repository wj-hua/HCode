// 一份资料绑定一个真实任务/专家；保存与启动续跑分开，未保存文本不发送给模型。
import { useState } from 'react';
import { COLLABORATION_LIMITS } from '@hcode/shared/collaboration';
import { Button } from '@/components/ui/button.js';
import { hcode } from '../bridge';
import { useCollaborationAction } from './useCollaborationAction';

export function SupplementContext({ runId, targetId, target }: { runId: string; targetId: string; target: string }) {
  const [text, setText] = useState('');
  const { busy, error, feedback, act } = useCollaborationAction();
  const save = async () => {
    if (await act(() => hcode.invoke('collaboration:supplement', runId, targetId, text.trim()), `资料已保存，接收目标：${target}；尚未启动 AI，请选择下方续跑操作。`)) setText('');
  };
  return <details className="mt-2">
    <summary className="cursor-pointer text-ui-sm">给此目标补资料</summary>
    <form className="mt-2 flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="flex flex-col gap-1">补充资料<textarea required rows={2} maxLength={COLLABORATION_LIMITS.maxContextLength} value={text} onChange={event => setText(event.target.value)} placeholder="填写决定、背景或项目内文件位置；权限和文件范围保持原计划" className="rounded-md border border-border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <Button className="self-start active:brightness-90" variant="outline" type="submit" disabled={busy || !text.trim()}>{busy ? '正在保存…' : '仅保存资料'}</Button>
      {feedback ? <p role="status" className="text-ui-sm">{feedback}</p> : null}
      {error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{error}</p> : null}
    </form>
  </details>;
}
