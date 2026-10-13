// 跨视图共用只读展示索引；订阅先于查询，拒绝慢查询覆盖随后到达的运行事件。
import { create } from 'zustand';
import { presentationForRun, presentationForDraft, mergePresentationEntry } from '@hcode/shared/collaborationPresentation';
import type { CollaborationPresentation } from '@hcode/shared/collaborationPresentation';
import { hcode } from '../bridge';

interface PresentationState { entries: CollaborationPresentation[]; errors: string[]; accept(entry: CollaborationPresentation): void }
export const usePresentationStore = create<PresentationState>(set => ({
  entries: [], errors: [],
  accept: entry => set(state => ({ entries: [...mergePresentationEntry(state.entries, entry)] })),
}));

/** 先订阅再查询初始目录；返回取消订阅动作，读取错误独立保留。 */
export function subscribePresentation() {
  const updated = new Set<string>();
  let active = true;
  const accept = (entry: CollaborationPresentation) => { updated.add(entry.id); usePresentationStore.getState().accept(entry); };
  const disposers = [
    hcode.on('collaboration:updated', snapshot => accept(presentationForRun(snapshot))),
    hcode.on('collaboration:draftUpdated', draft => accept(presentationForDraft(draft))),
    hcode.on('collaboration:expertDraftUpdated', draft => accept(presentationForDraft(draft))),
    hcode.on('collaboration:codeDraftUpdated', draft => accept(presentationForDraft(draft))),
  ];
  void hcode.invoke('collaboration:presentation').then(catalog => {
    if (!active) return;
    for (const entry of catalog.entries) if (!updated.has(entry.id)) usePresentationStore.getState().accept(entry);
    usePresentationStore.setState({ errors: catalog.errors });
  }, reason => { if (active) usePresentationStore.setState({ errors: [`读取协作展示索引失败：${String(reason)}`] }); });
  return () => { active = false; disposers.forEach(dispose => dispose()); };
}
