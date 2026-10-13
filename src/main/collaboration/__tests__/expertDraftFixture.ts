// 专家草案服务的真实文件/角色/Skills 环境；仅 CLI 传输替换为可控边界。
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { AgentKind } from "../../../shared/types.js";
import type { AgentProvider, AgentSendParams } from "../../agents/types.js";
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";
import { AgentRegistry } from "../../agents/registry.js";
import { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { researchTools } from "../../sessions/researchRuntime.js";
import { CollaborationRepository } from "../collaborationRepository.js";
import { CollaborationService } from "../collaborationService.js";
import { ExpertProfileService } from "../experts/profiles/expertProfileService.js";
import { PROFILE_DEFINITIONS } from "../experts/profiles/profileDefinitions.js";
import { ExpertDraftService } from "../drafts/expertDraftService.js";
export async function expertDraftFixture() {
  const root = await mkdtemp(join(tmpdir(), "hcode-expert-plan-")), project = join(root, "project"), sourceKey = randomUUID();
  await mkdir(project);
  await writeFile(join(project, "source.ts"), "export const answer = 42;\n");
  for (const name of new Set(Object.values(PROFILE_DEFINITIONS).flatMap(value => value.roles))) {
    const path = join(root, ".codex/agents"); await mkdir(path, { recursive: true });
    await writeFile(join(path, `${name}.toml`), `name = "${name}"\ndeveloper_instructions = "Analyze ${name} responsibilities."\n`);
  }
  for (const name of new Set(Object.values(PROFILE_DEFINITIONS).flatMap(value => value.skills))) {
    const path = join(root, ".codex/skills", name); await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\n---\nRead-only analysis method for ${name}.\n`);
  }
  let version = "fixture-1", latest: CollaborationSnapshot | undefined;
  const agents = new AgentRegistry(Object.fromEntries((["claude", "codex", "agy"] as const).map(kind => [kind, {
    kind, getStatus: async () => ({ kind, found: true, version: kind === "codex" ? "0.162.0" : kind === "agy" ? "1.3.3" : version }),
    listModels: async () => [{ value: "gemini-fixture", label: "Gemini" }], hasSession: () => true, endResearch: async () => {},
  }])) as unknown as Record<AgentKind, AgentProvider>);
  const evidence = { path: "source.ts", startLine: 1, endLine: 1, quote: "export const answer = 42;" };
  let proposal: unknown = { confidence: "identified", summary: "依据 source.ts 和表单目标，建议前端与测试。", sources: ["source.ts"], experts: ["frontend", "testing"].map(role => ({ role, objective: `从 ${role} 视角核对 source.ts 的常量`, reason: `目标要求 ${role} 视角` })) };
  const interrupt = vi.fn(async () => {});
  const send = vi.fn(async (input: AgentSendParams) => {
    let output = proposal;
    const task = latest?.tasks.findLast(value => value.sessionKey === input.sessionKey);
    if (!task) await researchTools(input.research!).find(tool => tool.name === "read_file")!.execute({ path: "source.ts" });
    if (task?.role === "execution") output = { summary: "常量研究", findings: [{ id: "answer", title: "常量", detail: "值为42", evidence: [evidence] }], limitations: ["未运行测试"] };
    if (task?.role === "review") output = { summary: "源码核对", claims: [{ claimId: "answer", assessment: "supported", reason: "源码支持", evidence: [evidence] }], limitations: ["未运行测试"] };
    if (task?.role === "synthesis") output = { summary: "专家完成核对", consensus: [{ statement: "常量为42", sources: latest!.experts!.participants.map(value => ({ expertId: value.id, versionId: value.versions.at(-1)!.id, claimId: "answer" })) }], disagreements: [], unverified: [], limitations: ["未运行测试"], failedExperts: [] };
    execution.acceptOutcome({ sessionKey: input.sessionKey, agent: input.agent, executionTurnId: input.executionTurnId!, nativeSessionId: `native-${input.sessionKey}`, outcome: "succeeded", text: typeof output === "string" ? output : JSON.stringify(output) });
    return { sessionKey: input.sessionKey };
  });
  const execution = new SessionExecutionService({ prepare: async input => input, send, interrupt, failedToSend: () => {}, finishedSending: () => {} });
  const repository = new CollaborationRepository(join(root, "records"));
  const profiles = new ExpertProfileService(repository.root, { home: root });
  const collaboration = new CollaborationService(repository, execution, agents, snapshot => { latest = snapshot; }, "darwin", profiles);
  const drafts = new ExpertDraftService(join(root, "expert-plans"), collaboration, execution, agents);
  const input = { initiator: { agent: "claude" as const, sessionKey: sourceKey, projectPath: project, permissionMode: "default" }, objective: "只读检查前端表单的实现与测试证据", backendPreferences: [{ agent: "claude" as const }, { agent: "codex" as const }], turnLimit: 24 };
  return { root, project, drafts, collaboration, repository, send, execution, agents, input, profiles, setProposal: (value: unknown) => { proposal = value; }, setVersion: (value: string) => { version = value; }, cleanup: async () => { drafts.dispose(); collaboration.dispose(); await rm(root, { recursive: true, force: true }); } };
}
