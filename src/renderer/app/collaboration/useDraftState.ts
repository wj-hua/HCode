// 草案展示的共同订阅、版本排序和动作反馈；业务编辑与确认规则仍由各模式管理。
import { useEffect, useRef, useState } from 'react';
import type { PlanningDraft } from '@hcode/shared/planningDraft';
import type { Conversation } from '../store/appStore';
const STATUS_ORDER = { editing: 0, preparing: 1, ready: 2, blocked: 2, cancelled: 2, starting: 3, started: 4, abandoned: 4 } as const;
interface DraftPort<T> { list(key?: string, nativeId?: string): Promise<T[]>; subscribe(receive: (value: T) => void): () => void }
export function useDraftState<T extends PlanningDraft, Edit>(conversation: Conversation, port: DraftPort<T>, editable: (draft: T) => Edit) {
  const [draft, setDraft] = useState<T>(), [edit, setEdit] = useState<Edit>(), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const latest = useRef<T | undefined>(undefined);
  const accept = (value: T) => {
    const previous = latest.current;
    if (previous?.id === value.id && (previous.revision > value.revision || previous.revision === value.revision && STATUS_ORDER[previous.status] > STATUS_ORDER[value.status] || JSON.stringify(previous) === JSON.stringify(value))) return;
    latest.current = value; setDraft(value); setEdit(editable(value));
  };
  useEffect(() => {
    let current = true;
    const dispose = port.subscribe(value => { if (current && (value.params.initiator.sessionKey === conversation.sessionKey || Boolean(conversation.sessionId && value.params.initiator.resumeSessionId === conversation.sessionId))) accept(value); });
    if (conversation.sessionKey || conversation.sessionId) void port.list(conversation.sessionKey, conversation.sessionId).then(values => {
      if (current && values[0] && !['started', 'abandoned'].includes(values[0].status)) accept(values[0]);
    }).catch(reason => { if (current) setError(`读取计划失败：${String(reason)}`); }).finally(() => { if (current) setLoading(false); });
    else setLoading(false);
    return () => { current = false; dispose(); };
  }, [conversation.sessionKey, conversation.sessionId, port, editable]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const changed = Boolean(draft && edit && JSON.stringify(edit) !== JSON.stringify(editable(draft)));
  return { draft, edit, busy, loading, error, latest, accept, act, changed, setEdit, setError };
}
