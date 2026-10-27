import { describe, expect, it } from "vitest";
import { addTab, removeTab } from "./terminalState";

describe("terminal tabs", () => {
  it("reuses the smallest index and selects the previous tab when closing", () => {
    const first = addTab();
    const second = addTab(first);
    const third = addTab(second);
    const afterClose = removeTab(third, second.active)!;
    expect(afterClose.tabs.map(tab => tab.index)).toEqual([1, 3]);
    expect(afterClose.active).toBe(third.active);
    const replacement = addTab(afterClose);
    expect(replacement.tabs.map(tab => tab.index)).toEqual([1, 3, 2]);
    expect(removeTab(replacement, replacement.active)?.active).toBe(third.active);
  });
  it("removes the workspace only when its last shell exits", () => {
    const state = addTab();
    expect(removeTab(state, "missing")).toBe(state);
    expect(removeTab(state, state.active)).toBeNull();
  });
});
