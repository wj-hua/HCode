// 原生验收共用真实 Provider/执行入口；测试可缩窄首版输入，但不伪造任何模型结果。
import { cp, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "../../../shared/types.js";
import type { AgentProvider, AgentEvents, AgentSendParams } from "../../agents/types.js";
import type { CollaborationSnapshot, TurnOutcome } from "../../../shared/collaboration.js";
import { ClaudeAgent } from "../../agents/claude/claudeAgent.js";
import { CodexAgent } from "../../agents/codex/codexAgent.js";
import { AgyAgent } from "../../agents/agy/agyAgent.js";
import { GEMINI_MODEL_PREFIX } from "../../agents/agy/agyResearchSession.js";
import { AgentRegistry } from "../../agents/registry.js";
import { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { CollaborationRepository } from "../collaborationRepository.js";
import {ExpertProfileService} from "../experts/profiles/expertProfileService.js";
import { CollaborationService } from "../collaborationService.js";

export async function nativeFixture(name: string, transform: (input: AgentSendParams) => AgentSendParams = (input) => input, observed?: (snapshot: CollaborationSnapshot) => void, existingRoot?: string, includeAgy = false) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), name));
  let execution: SessionExecutionService;
  let latest: CollaborationSnapshot | undefined;
  const outcomes: TurnOutcome[] = [];
  const events: AgentEvents = { turnOutcome: (result) => { outcomes.push(result); execution.acceptOutcome(result); }, rows: () => {}, state: () => {}, commands: () => {}, permission: () => {}, permissionResolved: () => {}, indexChanged: () => {}, quotaStale: () => {} };
  const env = () => process.env as Record<string, string>;
  const claude = new ClaudeAgent(events, env, () => join(process.env.HOME!, ".local/bin/claude"));
  const codex = new CodexAgent(events, env, () => "/opt/homebrew/bin/codex", name);
  const agents = new AgentRegistry({ claude, codex, ...(includeAgy ? { agy: new AgyAgent(events, env, () => join(process.env.HOME!, ".local/bin/agy"), join(root, "agy-runtime")) } : {}) } as unknown as Record<AgentKind, AgentProvider>);
  execution = new SessionExecutionService({ prepare: async (input) => input, send: (input) => agents.send(transform(input)), interrupt: async (key) => { await agents.bySessionKey(key)?.interrupt(key); }, failedToSend: () => {}, finishedSending: () => {} });
  const repository = new CollaborationRepository(join(root, "records"));
  await mkdir(repository.root, { recursive: true });
  const service = new CollaborationService(repository, execution, agents, (snapshot) => { latest = snapshot; observed?.(snapshot); },process.platform,new ExpertProfileService(repository.root,{discoverSkills:project=>codex.listManagedSkills(project)}));
  return { root, repository, service, agents, execution, outcomes, latest: () => latest, cleanup: async () => { service.dispose(); agents.dispose(); if (process.env.HCODE_NATIVE_EVIDENCE_DIR) { await cp(join(root, "records"), process.env.HCODE_NATIVE_EVIDENCE_DIR, { recursive: true }); await writeFile(join(process.env.HCODE_NATIVE_EVIDENCE_DIR, `${latest?.id ?? name}-native-outcomes.json`), JSON.stringify(outcomes, null, 2)); } await rm(root, { recursive: true, force: true }); } };
}

/** 原生验收从实时列表选 Gemini，优先低推理 Flash；无模型时明确失败。 */
export async function selectGeminiModel(agents: AgentRegistry) {
  const models = (await agents.get("agy").listModels()).filter((model) => model.value.startsWith(GEMINI_MODEL_PREFIX));
  const selected = models.find((entry) => /flash.*low/.test(entry.value)) ?? models[0];
  if (!selected) throw new Error("本机 agy 未返回可用于 S4 验收的 Gemini 模型");
  return selected.value;
}
