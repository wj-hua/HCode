// 内部原生会话按 Run 归组；导航使用真实线程与工作区，不重命名或改写原生记录。
import { collaborationGroupMatchesQuery, type groupCollaborationSessions } from '@hcode/shared/collaborationPresentation';
import { AGENTS } from '@hcode/shared/agents';
import { useAppStore } from '../store/appStore';
import { useState } from 'react';
import { openPresentation } from './openPresentation';

export function InternalSessionGroups({ groups, query }: { groups: ReturnType<typeof groupCollaborationSessions>['groups']; query: string }) {
  const openSession = useAppStore(state => state.openSession);
  const [error, setError] = useState('');
  const openResult = async (entry: Parameters<typeof openPresentation>[0]) => {
    setError('');
    try { await openPresentation(entry); }
    catch (reason) { setError(String(reason)); }
  };
  const visible = groups.filter(group => collaborationGroupMatchesQuery(group, query));
  if (!visible.length) return null;
  return <details open={query ? true : undefined} className="px-2.5 text-ui-sm">
    <summary className="cursor-pointer rounded-md py-2 text-foreground-subtle focus-visible:ring-2 focus-visible:ring-ring">内部协作会话 · {visible.length} 个任务组</summary>
    <div className="space-y-2 border-l border-border pl-2">
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {visible.map(({ entry, sessions }) => <details key={entry.id} open={query ? true : undefined}>
        <summary className="cursor-pointer py-1 focus-visible:ring-2 focus-visible:ring-ring"><span className="line-clamp-2">{entry.objective}</span><span className="text-foreground-subtlest">{entry.status}</span></summary>
        <button type="button" disabled={!entry.source.nativeSessionId} className="rounded-md px-2 py-1 text-foreground-subtle hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" onClick={() => void openResult(entry)}>查看任务组结果</button>
        <ul className="mt-1 space-y-1">{sessions.map(session => <li key={`${session.agent}:${session.id}`}><button type="button" className="w-full rounded-md p-2 text-left hover:bg-surface-hover active:bg-selected focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void openSession(session)}><span className="line-clamp-2">{session.title}</span><span className="text-foreground-subtlest">{AGENTS[session.agent].name}</span></button></li>)}</ul>
      </details>)}
    </div>
  </details>;
}
