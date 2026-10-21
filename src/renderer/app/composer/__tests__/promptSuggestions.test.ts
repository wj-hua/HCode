// 验证原生事件、会话隔离与草稿保护；状态模块不请求模型，也不写消息历史或持久草稿。
import { beforeEach, expect, it } from 'vitest';
import type { ChatPromptSuggestionEvent } from '@hcode/shared/types';
import { promptSuggestionRecord, usePromptSuggestionStore, visiblePromptSuggestion } from '../promptSuggestionStore';

const identity = { agent: 'claude' as const, projectPath: '/project', sessionKey: 'source', sessionId: 'native' };
const event = (patch: Partial<ChatPromptSuggestionEvent> = {}): ChatPromptSuggestionEvent => ({ agent: 'claude', projectPath: '/project', sessionKey: 'source', sessionId: 'native', turnId: 'turn-one', revision: 1, suggestion: '运行回归检查', ...patch });
const current = () => promptSuggestionRecord(usePromptSuggestionStore.getState().records, identity);
beforeEach(() => usePromptSuggestionStore.setState({ records: {}, order: 0 }));

it('只在空闲空输入框展示，原生建议不成为用户草稿', () => {
  usePromptSuggestionStore.getState().accept(event());
  const draft = '';
  expect(visiblePromptSuggestion(current(), draft, true)).toBe('运行回归检查');
  expect(draft).toBe('');
  expect(visiblePromptSuggestion(current(), '用户已有草稿', true)).toBeNull();
  expect(visiblePromptSuggestion(current(), '', false)).toBeNull();
});

it('开始输入、接受或忽略后，该回合迟到及重复事件不能重新展示', () => {
  const store = usePromptSuggestionStore.getState();
  store.accept(event({ suggestion: null })); store.dismiss('source', 'turn-one');
  store.accept(event({ revision: 2 }));
  expect(visiblePromptSuggestion(current(), '', true)).toBeNull();
  store.accept(event({ revision: 3, turnId: 'turn-two', suggestion: null }));
  store.accept(event({ revision: 4, turnId: 'turn-two', suggestion: '新回合建议' }));
  expect(visiblePromptSuggestion(current(), '', true)).toBe('新回合建议');
  store.accept(event({ revision: 2, suggestion: '旧回合建议' }));
  expect(visiblePromptSuggestion(current(), '', true)).toBe('新回合建议');
});

it('同一原生会话重开可关联建议，其他项目、后端与会话不能串用', () => {
  const store = usePromptSuggestionStore.getState(); store.accept(event());
  const records = usePromptSuggestionStore.getState().records;
  expect(promptSuggestionRecord(records, { ...identity, sessionKey: undefined })?.event.suggestion).toBe('运行回归检查');
  expect(promptSuggestionRecord(records, { ...identity, projectPath: '/other' })).toBeUndefined();
  expect(promptSuggestionRecord(records, { ...identity, sessionId: 'other-native' })).toBeUndefined();
  expect(promptSuggestionRecord(records, { ...identity, agent: 'codex' })).toBeUndefined();
});

it('新运行时接管同一原生会话后选用最新记录，不回退到旧建议', () => {
  const store = usePromptSuggestionStore.getState(); store.accept(event());
  store.accept(event({ sessionKey: 'new-source', turnId: 'turn-two', suggestion: null }));
  expect(visiblePromptSuggestion(current(), '', true)).toBeNull();
  store.accept(event({ sessionKey: 'new-source', turnId: 'turn-two', revision: 2, suggestion: '新的运行时建议' }));
  expect(visiblePromptSuggestion(current(), '', true)).toBe('新的运行时建议');
});
