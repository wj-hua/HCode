// 通知深链（远程网页）：推送点按后以 `?agent=&session=&project=` 打开网页，初始化时直接定位到对应会话。
// 参数来自外部链接，这里只校验格式；项目是否允许远程访问由主进程的远程 policy 裁决。
import { AGENTS } from "@hcode/shared/agents";
import type { AgentKind } from "@hcode/shared/types";
import { hcode } from "../bridge";
import type { AppState } from "./appStore";

/** 与 GTools 转发器生成的链接参数一致，改名需两端同步。 */
const PARAMS = { agent: "agent", session: "session", project: "project" } as const;

export interface SessionLink {
  agent: AgentKind;
  sessionId: string;
  projectPath: string;
}

type SessionLinkState = Pick<AppState, "openSession" | "toggleProject">;

export function parseSessionLink(search: string): SessionLink | null {
  const params = new URLSearchParams(search);
  const agent = params.get(PARAMS.agent);
  const sessionId = params.get(PARAMS.session);
  const projectPath = params.get(PARAMS.project);
  if (!agent || !sessionId || !projectPath || !Object.hasOwn(AGENTS, agent)) return null;
  return { agent: agent as AgentKind, sessionId, projectPath };
}

/** 读取后立即从地址栏移除参数：刷新页面或切到其他会话后，不会再被拉回通知对应的会话。 */
export function takeSessionLink(): SessionLink | null {
  const url = new URL(window.location.href);
  const link = parseSessionLink(url.search);
  for (const name of Object.values(PARAMS)) url.searchParams.delete(name);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  return link;
}

/**
 * 在项目会话列表里按 CLI 与会话 id 找到摘要后打开；历史由 openSession 继续加载，不阻塞首屏。
 * 会话已删除或项目已移出远程范围时抛出错误，由调用方提示并停在默认页面。
 */
export async function openSessionLink(get: () => SessionLinkState, link: SessionLink): Promise<void> {
  const sessions = await hcode.invoke("sessions:list", link.projectPath);
  const summary = sessions.find(session => session.id === link.sessionId && session.agent === link.agent);
  if (!summary) throw new Error("通知对应的会话不存在或已删除");
  get().toggleProject(link.projectPath, true);
  void get().openSession(summary);
}
