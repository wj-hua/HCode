import { useEffect, useRef, useState } from 'react';
import type { MemoryEntry, MemorySaveInput } from '@hcode/shared/memory';
import { MEMORY_LIMIT } from '@hcode/shared/memory';
import { AGENTS } from '@hcode/shared/agents';
import { Button } from '@/components/ui/button.js';
import { Switch } from '@/components/ui/switch.js';
import { useZCodeIntl } from '@/i18n/IntlProvider.js';
import { hcode, isRemote } from '../bridge';
import { useAppStore } from '../store/appStore';

const inputClass = 'w-full rounded-lg border border-input-border bg-input px-3 py-2 text-ui-sm text-foreground outline-none focus:border-input-border-focused';
const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
type Draft = Omit<MemorySaveInput, 'tags'> & { tagsText: string };

export function MemorySection() {
  const { intl, locale } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id: `memory.${id}` }, values);
  const enabled = useAppStore(state => state.settings.memoryEnabled);
  const updateSettings = useAppStore(state => state.updateSettings);
  const projects = useAppStore(state => state.projects);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (isRemote) { setLoading(false); return; }
    let request = 0;
    let active = true;
    const refresh = async () => {
      const seq = ++request;
      try {
        const values = await hcode.invoke('memory:list');
        if (active && seq === request) { setEntries(values); setError(''); }
      } catch (failure) { if (active && seq === request) setError(String(failure)); }
      finally { if (active && seq === request) setLoading(false); }
    };
    const off = hcode.on('memory:updated', () => void refresh());
    void refresh();
    return () => { active = false; mounted.current = false; off(); };
  }, []);

  useEffect(() => {
    if (isRemote) return;
    let active = true;
    const paths = [...new Set(entries.flatMap(entry => entry.projectPath ? [entry.projectPath] : []))];
    void Promise.all(paths.map(async path => {
      const info = await hcode.invoke('fs:stat', path);
      return !info?.exists || !info.isDirectory ? path : null;
    })).then(values => { if (active) setMissing(new Set(values.filter((path): path is string => path !== null))); }, failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [entries]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) { if (mounted.current) setError(String(failure)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const save = () => run(async () => {
    if (!draft) return;
    await hcode.invoke('memory:save', {
      ...(draft.id ? { id: draft.id } : {}), scope: draft.scope,
      ...(draft.scope === 'project' ? { projectPath: draft.projectPath } : {}),
      content: draft.content, tags: draft.tagsText.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean),
    });
    if (mounted.current) setDraft(null);
  });
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const key = entry.projectPath ?? '';
    const group = groups.get(key) ?? [];
    group.push(entry); groups.set(key, group);
  }
  const projectOptions = new Map(projects.filter(project => project.purpose !== 'conversation' && project.exists).map(project => [project.path, project.name]));
  // 保留已移除项目的原路径，允许编辑内容或改为全局。
  if (draft?.projectPath && !projectOptions.has(draft.projectPath)) projectOptions.set(draft.projectPath, projectName(draft.projectPath));

  return <>
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor="memory-enabled" className="text-ui-base font-medium">{t('enable')}</label>
        <p className="text-ui-sm leading-relaxed text-foreground-subtle">{t('hint')}</p>
      </div>
      <Switch id="memory-enabled" checked={enabled} disabled={busy || isRemote} onCheckedChange={value => void run(() => updateSettings({ memoryEnabled: value }))} />
    </div>
    {isRemote ? <p className="px-4 py-3 text-ui-sm text-foreground-subtle">{t('localOnly')}</p> : <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui-sm text-foreground-subtle">{t('count', { count: entries.length, limit: MEMORY_LIMIT })}</span>
        <Button size="sm" variant="outline" disabled={busy || loading || Boolean(draft) || entries.length >= MEMORY_LIMIT} onClick={() => { setError(''); setDraft({ scope: 'global', content: '', tagsText: '' }); }}>{t('add')}</Button>
      </div>
      {error ? <p role="alert" className="break-words text-ui-sm text-destructive">{error}</p> : null}
      {draft ? <form className="flex flex-col gap-3 rounded-xl border border-border p-3" onSubmit={event => { event.preventDefault(); void save(); }}>
        <h4 className="text-ui-base font-medium">{t(draft.id ? 'edit' : 'add')}</h4>
        <label className="flex flex-col gap-1 text-ui-sm">{t('content')}
          <textarea autoFocus required maxLength={1000} rows={4} disabled={busy} className={`${inputClass} resize-y`} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-ui-sm">{t('scope')}
          <select className={inputClass} disabled={busy} value={draft.scope} onChange={event => setDraft({ ...draft, scope: event.target.value as Draft['scope'] })}>
            <option value="global">{t('global')}</option><option value="project">{t('project')}</option>
          </select>
        </label>
        {draft.scope === 'project' ? <label className="flex flex-col gap-1 text-ui-sm">{t('project')}
          <select required className={inputClass} disabled={busy} value={draft.projectPath ?? ''} onChange={event => setDraft({ ...draft, projectPath: event.target.value })}>
            <option value="" disabled>{t('selectProject')}</option>
            {[...projectOptions].map(([path, name]) => <option key={path} value={path}>{name}{missing.has(path) ? ` (${t('removed')})` : ''} — {path}</option>)}
          </select>
        </label> : null}
        <label className="flex flex-col gap-1 text-ui-sm">{t('tags')}
          <input className={inputClass} disabled={busy} value={draft.tagsText} onChange={event => setDraft({ ...draft, tagsText: event.target.value })} />
        </label>
        <div className="flex gap-2">
          <Button size="sm" type="submit" disabled={busy || !draft.content.trim()}>{t(busy ? 'saving' : 'save')}</Button>
          <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('cancel')}</Button>
        </div>
      </form> : null}
      {loading ? <p role="status" className="text-ui-sm text-foreground-subtle">{t('loading')}</p> : entries.length === 0 ? <p className="text-ui-sm text-foreground-subtle">{t('empty')}</p> : null}
      {[...groups].sort(([a], [b]) => a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)).map(([path, values]) => <section key={path || 'global'} className="flex flex-col gap-2">
        <h4 className="break-words text-ui-sm font-semibold" title={path || undefined}>{path ? `${projectName(path)}${missing.has(path) ? ` · ${t('removed')}` : ''}` : t('global')}</h4>
        {values.map(entry => <article key={entry.id} className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
          <p className="whitespace-pre-wrap break-words text-ui-sm">{entry.content}</p>
          {entry.tags.length ? <div className="flex flex-wrap gap-1">{entry.tags.map(tag => <span key={tag} className="rounded bg-surface-hover px-1.5 py-0.5 text-ui-xs text-foreground-subtle">{tag}</span>)}</div> : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-ui-xs text-foreground-subtle">{entry.source.agent === 'user' ? t('user') : AGENTS[entry.source.agent].name} · {new Date(entry.updatedAt).toLocaleString(locale)}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={busy || Boolean(draft)} onClick={() => { setError(''); setDeleteId(null); setDraft({ id: entry.id, scope: entry.scope, projectPath: entry.projectPath, content: entry.content, tagsText: entry.tags.join(', ') }); }}>{t('edit')}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleteId(entry.id)}>{t('delete')}</Button>
            </div>
          </div>
          {deleteId === entry.id ? <div className="flex flex-wrap items-center gap-2 text-ui-sm">
            <span>{t('confirmDelete')}</span>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(async () => { await hcode.invoke('memory:delete', entry.id); if (mounted.current) { setDeleteId(null); if (draft?.id === entry.id) setDraft(null); } })}>{t('delete')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleteId(null)}>{t('cancel')}</Button>
          </div> : null}
        </article>)}
      </section>)}
    </div>}
  </>;
}
