import { beforeEach, expect, it } from "vitest";
import { useUiStore } from "../store/uiStore";
beforeEach(() => useUiStore.getState().setSidePanel(null));
it("文件证据可以返回原协作，关闭不会留下旧返回入口", () => {
  const original = { type: "collaboration" as const, viewId: "source" };
  useUiStore.getState().setSidePanel(original);
  useUiStore.getState().setSidePanel({ type: "file", viewId: "source", source: { type: "file", path: "/project/rules.md", title: "rules" } });
  expect(useUiStore.getState().returnPanel).toEqual(original);
  useUiStore.getState().setSidePanel(useUiStore.getState().returnPanel);
  expect(useUiStore.getState().sidePanel).toEqual(original);
  expect(useUiStore.getState().returnPanel).toBeNull();
  useUiStore.getState().setSidePanel(null);
  expect(useUiStore.getState().sidePanel).toBeNull();
});
it("切换其他会话的文件不能返回之前会话的协作", () => {
  useUiStore.getState().setSidePanel({ type: "collaboration", viewId: "first" });
  useUiStore.getState().setSidePanel({ type: "diff", viewId: "first" });
  useUiStore.getState().setSidePanel({ type: "file", viewId: "second", source: { type: "file", path: "/other/readme.md", title: "readme" } });
  expect(useUiStore.getState().returnPanel).toBeNull();
});
