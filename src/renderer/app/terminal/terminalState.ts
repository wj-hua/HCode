export interface TerminalTab { id: string; index: number; shell?: string }
export interface TerminalTabs { tabs: TerminalTab[]; active: string }

export function addTab(state?: TerminalTabs): TerminalTabs {
  const tabs = state?.tabs ?? [];
  let index = 1;
  while (tabs.some(tab => tab.index === index)) index++;
  const tab = { id: crypto.randomUUID(), index };
  return { tabs: [...tabs, tab], active: tab.id };
}

export function removeTab(state: TerminalTabs, id: string): TerminalTabs | null {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter(tab => tab.id !== id);
  if (!tabs.length) return null;
  return { tabs, active: state.active === id ? (tabs[Math.max(0, index - 1)] ?? tabs[0]!).id : state.active };
}
