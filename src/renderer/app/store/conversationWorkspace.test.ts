// 通过公开 store 动作验证非项目会话；仅替换 Electron IPC 和界面通知边界。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@hcode/shared/types";
import { drafts, fileDrafts, imageDrafts } from "../composer/drafts";

const { invoke, notify } = vi.hoisted(() => ({ invoke: vi.fn(), notify: vi.fn() }));
vi.mock("../bridge", () => ({ hcode: { invoke, on: vi.fn() } }));
vi.mock("@/components/ui/toast.js", () => ({ toast: notify }));
import { useAppStore } from "./appStore";

const PROJECT = "/user/project";
const WORKSPACE = "/hcode/workspace/default";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  invoke.mockReset();
  notify.mockReset();
  invoke.mockImplementation(async (channel) => {
    if (channel === "workspace:conversation") return WORKSPACE;
    if (channel === "sessions:list") return [];
    if (channel === "projects:list") return [{ path: WORKSPACE, name: "对话", purpose: "conversation", exists: true, pinned: false, sessionCount: 0, lastActiveAt: 0 }];
    if (channel === "sessions:load") return { rows: [] };
    if (channel === "agent:models") return [];
    if (channel === "chat:send") return { sessionKey: "active-session" };
    throw new Error(`未配置的 IPC: ${channel}`);
  });
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, notifyOnFinish: false }, models: {}, projects: [], sessions: {}, sessionErrors: {}, expanded: {}, conversations: {}, activeViewId: null, conversationWorkspacePending: false });
  drafts.clear();
  fileDrafts.clear();
  imageDrafts.clear();
});

afterEach(() => vi.unstubAllGlobals());

describe("不在项目中工作", () => {
  it("无需项目即可新建对话，使用现有默认 CLI 和权限", async () => {
    await useAppStore.getState().workOutsideProject();
    const state = useAppStore.getState();
    expect(state.conversations[state.activeViewId!]).toMatchObject({ projectPath: WORKSPACE, agent: DEFAULT_SETTINGS.defaultAgent, permissionMode: DEFAULT_SETTINGS.defaultPermissionModes[DEFAULT_SETTINGS.defaultAgent] });
    expect(invoke).not.toHaveBeenCalledWith("projects:add");
    expect(state.expanded[WORKSPACE]).toBe(true);
  });

  it("切换工作区保留文本、附件、CLI 和权限，并能切回项目", async () => {
    useAppStore.getState().newChat(PROJECT, "codex");
    const id = useAppStore.getState().activeViewId!;
    drafts.set(id, "保留我的草稿");
    const file = { path: "/tmp/report.txt", name: "report.txt", mimeType: "text/plain", size: 3 };
    fileDrafts.set(id, [file]);
    imageDrafts.set(id, []);
    const before = useAppStore.getState().conversations[id]!;
    await useAppStore.getState().workOutsideProject();
    expect(useAppStore.getState().activeViewId).toBe(id);
    expect(useAppStore.getState().conversations[id]).toMatchObject({ projectPath: WORKSPACE, agent: "codex", permissionMode: before.permissionMode });
    expect(drafts.get(id)).toBe("保留我的草稿");
    expect(fileDrafts.get(id)).toEqual([file]);
    useAppStore.getState().setDraftProject(PROJECT);
    expect(useAppStore.getState().conversations[id]!.projectPath).toBe(PROJECT);
    expect(drafts.get(id)).toBe("保留我的草稿");
  });

  it("目录创建失败显示错误并保留原草稿", async () => {
    useAppStore.getState().newChat(PROJECT);
    const before = useAppStore.getState().activeViewId;
    invoke.mockRejectedValueOnce(new Error("permission denied"));
    await useAppStore.getState().workOutsideProject();
    expect(useAppStore.getState().activeViewId).toBe(before);
    expect(useAppStore.getState().conversations[before!]!.projectPath).toBe(PROJECT);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("permission denied"), { variant: "warning" });
    expect(useAppStore.getState().conversationWorkspacePending).toBe(false);
  });

  it("异步目录创建期间切换了会话时，不改写新选中的会话", async () => {
    let resolveWorkspace!: (path: string) => void;
    invoke.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveWorkspace = resolve; }));
    useAppStore.getState().newChat(PROJECT);
    const pending = useAppStore.getState().workOutsideProject();
    useAppStore.getState().newChat("/another/project");
    const selected = useAppStore.getState().activeViewId!;
    resolveWorkspace(WORKSPACE);
    await pending;
    expect(useAppStore.getState().activeViewId).toBe(selected);
    expect(useAppStore.getState().conversations[selected]!.projectPath).toBe("/another/project");
  });

  it("已有会话保持原目录，从非项目入口创建独立草稿", async () => {
    useAppStore.getState().newChat(PROJECT);
    const original = useAppStore.getState().activeViewId!;
    const conversation = useAppStore.getState().conversations[original]!;
    useAppStore.setState({ conversations: { [original]: { ...conversation, sessionId: "existing-session" } } });
    await useAppStore.getState().workOutsideProject();
    const state = useAppStore.getState();
    expect(state.conversations[original]!.projectPath).toBe(PROJECT);
    expect(state.activeViewId).not.toBe(original);
    expect(state.conversations[state.activeViewId!]!.projectPath).toBe(WORKSPACE);
  });

  it("侧边栏新建入口保留其他项目草稿，并复用已有非项目草稿", async () => {
    useAppStore.getState().newChat(PROJECT);
    const original = useAppStore.getState().activeViewId!;
    drafts.set(original, "项目草稿");
    await useAppStore.getState().workOutsideProject(true);
    const outside = useAppStore.getState().activeViewId!;
    expect(outside).not.toBe(original);
    expect(useAppStore.getState().conversations[original]!.projectPath).toBe(PROJECT);
    expect(drafts.get(original)).toBe("项目草稿");
    await useAppStore.getState().workOutsideProject(true);
    expect(useAppStore.getState().activeViewId).toBe(outside);
  });

  it.each(["claude", "codex", "step", "agy", "pi"] as const)("%s 在非项目目录发送和续聊沿用现有 IPC", async (agent) => {
    await useAppStore.getState().workOutsideProject();
    useAppStore.getState().setDraftAgent(agent);
    expect(await useAppStore.getState().send("你好")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("chat:send", expect.objectContaining({ agent, projectPath: WORKSPACE, text: "你好" }));
    useAppStore.setState({ conversations: {}, activeViewId: null });
    await useAppStore.getState().openSession({ agent, id: "saved-session", projectPath: WORKSPACE, title: "旧对话", createdAt: 1, updatedAt: 2 });
    expect(await useAppStore.getState().send("继续")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("chat:send", expect.objectContaining({ agent, projectPath: WORKSPACE, resumeSessionId: "saved-session", text: "继续" }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("历史读取失败保留已有列表并支持重试", async () => {
    const history = [{ agent: "codex" as const, id: "history", projectPath: WORKSPACE, title: "原有对话", createdAt: 1, updatedAt: 2 }];
    useAppStore.setState({ sessions: { [WORKSPACE]: history } });
    invoke.mockRejectedValueOnce(new Error("读取失败"));
    await useAppStore.getState().loadSessions(WORKSPACE);
    expect(useAppStore.getState().sessions[WORKSPACE]).toEqual(history);
    expect(useAppStore.getState().sessionErrors[WORKSPACE]).toBe("读取失败");
    await useAppStore.getState().loadSessions(WORKSPACE);
    expect(useAppStore.getState().sessionErrors[WORKSPACE]).toBeUndefined();
  });
});
