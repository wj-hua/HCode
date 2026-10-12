import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStateEvent, RowOp } from "../../../shared/types.js";
import type { TurnOutcome } from "../../../shared/collaboration.js";
import type { AgentEvents, AgentSendParams } from "../types.js";
import { clineDataDir, clineSummary } from "../cline/clineHistory.js";
import { ClineRowProjector } from "../cline/clineProjector.js";
import { ClineSession } from "../cline/clineSession.js";
import { ClineResponseMetrics } from "../cline/clineResponseMetrics.js";
import { withFileReferences } from "../fileAttachments.js";
import { applyRowOps } from "../../../renderer/app/rows.js";
import { ofKind } from "./helpers.js";
vi.mock("../../util/trash.js", () => ({ trashPaths: vi.fn() }));
import { ClineAgent } from "../cline/clineAgent.js";

// 真实子进程与 NDJSON 传输，模拟 CLI 的审批、回放、结束及异常退出。
const CLI = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if(process.argv.includes('--version')) {console.log('3.0.70');process.exit(0);}
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const update = (value,sessionId='native') => send({method:'session/update',params:{sessionId,update:value}});
let prompt;
createInterface({input:process.stdin}).on('line', line => {
 const message=JSON.parse(line);
 const reply=result=>send({id:message.id,result});
 if(message.method==='initialize') return reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(message.method==='session/new') {
  if(process.env.REQUIRE_KEY && !process.env.CLINE_API_KEY) return send({id:message.id,error:{code:-32000,message:'Authentication required'}});
  const model=process.env.CLINE_MODEL||'default';
  return reply({sessionId:'native',models:{currentModelId:model,availableModels:[{modelId:model,name:model}]}});
 }
 if(message.method==='session/load') {
  update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'第一轮'}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'旧回复'}});
  return reply({});
 }
 if(message.method==='session/set_model') {
  if(process.env.CAPTURE) writeFileSync(process.env.CAPTURE+'.model',message.params.modelId);
  return reply({});
 }
 if(message.method==='session/set_mode') return reply({});
 if(message.method==='session/prompt') {
  prompt=message;
  if(process.env.CAPTURE) writeFileSync(process.env.CAPTURE,JSON.stringify({...message.params,provider:process.env.CLINE_PROVIDER,configuredModel:process.env.CLINE_MODEL,backend:process.env.CLINE_SESSION_BACKEND_MODE}));
  if(process.env.STYLE==='silent'||process.env.STYLE==='partial-error') {
   if(process.env.STYLE==='partial-error') update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'半截回复'}});
   return send({id:message.id,result:{stopReason:'end_turn'}});
  }
  if(process.env.STYLE==='invalid') {process.stdout.write('invalid-json\\n');return;}
  if(process.env.STYLE==='failed') return send({id:message.id,error:{code:-32000,message:'provider failed'}});
  update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'思考'}});
  update({sessionUpdate:'tool_call',toolCallId:'tool',title:'run_commands: echo test',kind:'execute',rawInput:{commands:['echo test']}});
  send({id:'permission',method:'session/request_permission',params:{sessionId:'native',toolCall:{toolCallId:'tool',title:'run_commands: echo test',kind:'execute',rawInput:{commands:['echo test']}},options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'},{optionId:'always',kind:'allow_always'}]}});
  return;
 }
 if(message.method==='session/cancel') {send({id:prompt.id,result:{stopReason:'cancelled'}});return;}
 if(message.id==='permission') {
  if(message.result.outcome.outcome==='cancelled') return;
  const allowed=message.result.outcome.optionId==='yes';
  update({sessionUpdate:'tool_call_update',toolCallId:'tool',status:allowed?'completed':'failed',rawOutput:allowed?'test':'rejected'});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:allowed?'完成':'计划'}});
  send({id:prompt.id,result:{stopReason:'end_turn'}});
 }
});
`;

describe("Cline ACP 接入", () => {
  let root: string, path: string;
  let active: ClineSession | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hcode-cline-test-"));
    path = join(root, "cline.mjs");
    await writeFile(path, CLI);
    await chmod(path, 0o755);
  });
  afterEach(async () => { active?.dispose(); await rm(root, { recursive: true, force: true }); });

  function fixture(style = "approval", readHistory?: (id: string) => Promise<ClineRowProjector>) {
    const states: ChatStateEvent[] = [], outcomes: TurnOutcome[] = [], ops: RowOp[] = [];
    const events: AgentEvents = {
      state: (value) => states.push(value), turnOutcome: (value) => outcomes.push(value), rows: (_key, value) => ops.push(...value),
      permission: vi.fn(), permissionResolved: vi.fn(), indexChanged: vi.fn(), commands: vi.fn(), quotaStale: vi.fn(),
    };
    const params: AgentSendParams = { agent: "cline", sessionKey: "key", projectPath: root, text: "执行", permissionMode: "default", executionTurnId: "turn" };
    const session = new ClineSession(params, events, async (cwd, effort) => ({ path, cwd, effort, env: { ...process.env as Record<string, string>, CLINE_SESSION_BACKEND_MODE: "hub", STYLE: style, CAPTURE: join(root, "prompt.json") } }), join(root, "attachments"), vi.fn(), readHistory);
    active = session;
    return { session, params, events, states, outcomes, ops };
  }

  it("流式工具审批等待用户，完成后只产生一个原生终态；下一轮回放保留历史", async () => {
    const data = fixture();
    const running = data.session.send(data.params);
    await vi.waitFor(() => {
      expect(data.states.at(-1)?.error).toBeUndefined();
      expect(data.events.permission).toHaveBeenCalledTimes(1);
    }, { timeout: 5000 });
    expect(data.states.at(-1)?.state).toBe("awaitingApproval");
    expect(data.outcomes).toHaveLength(0);
    const request = vi.mocked(data.events.permission).mock.calls[0]![0];
    expect(request.canAllowForSession).toBe(false);
    expect(data.session.respondPermission(request.interactionId, { decision: "allow" })).toBe(true);
    await running;
    expect(data.states.at(-1)).toMatchObject({ state: "idle", sessionId: "native", usage: { ttftMs: expect.any(Number) } });
    expect(data.outcomes).toEqual([expect.objectContaining({ outcome: "succeeded", executionTurnId: "turn", nativeSessionId: "native", text: "完成" })]);
    await data.session.send({ ...data.params, text: "继续", permissionMode: "bypass", executionTurnId: "next" });
    const rows = applyRowOps([], data.ops);
    expect(ofKind(rows, "userInput").map((row) => row.text)).toEqual(["第一轮", "继续"]);
    expect(ofKind(rows, "assistantText").map((row) => row.text)).toEqual(["旧回复", "完成"]);
    expect(data.outcomes).toHaveLength(2);
  });

  it("计划模式拒绝写入与命令工具，完全放行自动批准", async () => {
    const data = fixture();
    await data.session.send({ ...data.params, permissionMode: "plan" });
    expect(data.events.permission).not.toHaveBeenCalled();
    expect(ofKind(applyRowOps([], data.ops), "toolCall")[0]).toMatchObject({ status: "error", output: { text: "rejected" } });
    expect(data.outcomes[0]).toMatchObject({ outcome: "succeeded", text: "计划" });
    await data.session.send({ ...data.params, permissionMode: "bypass", executionTurnId: "next" });
    expect(data.outcomes[1]).toMatchObject({ outcome: "succeeded", text: "完成" });
  });

  it("审批时停止会清理审批，等待真实进程退出后落为取消", async () => {
    const data = fixture();
    const running = data.session.send(data.params);
    await vi.waitFor(() => expect(data.events.permission).toHaveBeenCalledOnce());
    await data.session.interrupt();
    await running;
    expect(data.events.permissionResolved).toHaveBeenCalledOnce();
    expect(data.outcomes).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
    expect(data.states.at(-1)?.state).toBe("idle");
    expect(ofKind(applyRowOps([], data.ops), "turnHeader")[0]?.state).toBe("completedInterrupted");
  });

  it("启动期间停止不发送 prompt，当前回合未结束时拒绝重复输入", async () => {
    const data = fixture();
    const running = data.session.send(data.params);
    await expect(data.session.send(data.params)).rejects.toThrow("仍在运行");
    await data.session.interrupt();
    await running;
    expect(data.outcomes).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
    await expect(readFile(join(root, "prompt.json"))).rejects.toThrow();
  });

  it.each(["failed", "invalid"])("%s 协议或模型错误产生失败终态，保留用户消息", async (style) => {
    const data = fixture(style);
    await data.session.send(data.params);
    expect(data.outcomes).toEqual([expect.objectContaining({ outcome: "failed", error: expect.any(String) })]);
    expect(data.states.at(-1)?.state).toBe("error");
    expect(ofKind(applyRowOps([], data.ops), "userInput")[0]?.text).toBe("执行");
  });

  it("ACP 没有发送正文时从本轮原生历史恢复回复，不伪造流式指标", async () => {
    const data = fixture("silent", async () => {
      const projector = new ClineRowProjector();
      projector.history([{ role: "user", ts: Date.now(), content: "执行" }, { role: "assistant", ts: Date.now(), content: "保存的完整回复" }]);
      return projector;
    });
    await data.session.send(data.params);
    expect(data.outcomes[0]).toMatchObject({ outcome: "succeeded", text: "保存的完整回复", usage: {} });
    expect(ofKind(applyRowOps([], data.ops), "assistantText")[0]?.text).toBe("保存的完整回复");
  });

  it("完成后读取本轮真实用量并向界面及终态发送吞吐，下一轮缺失用量时清空", async () => {
    let turn = 0;
    const data = fixture("approval", async () => {
      const projector = new ClineRowProjector();
      projector.history([
        { role: "user", ts: 1, content: "旧问题" },
        { role: "assistant", ts: 2, content: "旧回复", metrics: { inputTokens: 9999, outputTokens: 9999 } },
        { role: "user", ts: Date.now(), content: "执行" },
        { role: "assistant", ts: Date.now(), content: "完成", ...(turn++ === 0 ? { metrics: { inputTokens: 100, outputTokens: 50 } } : {}) },
      ]);
      return projector;
    });
    await data.session.send({ ...data.params, permissionMode: "bypass" });
    expect(data.states.at(-1)?.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, outputSpeedBasis: "activeTurn", outputTokensPerSecond: expect.any(Number) });
    expect(data.outcomes[0]?.usage).toEqual(data.states.at(-1)?.usage);
    await data.session.send({ ...data.params, permissionMode: "bypass", executionTurnId: "next" });
    expect(data.states.at(-1)?.usage?.outputTokens).toBeUndefined();
    expect(data.states.at(-1)?.usage?.outputTokensPerSecond).toBeUndefined();
  });

  it("历史保存了隐藏错误时保留错误卡片，部分输出不能被标记为成功", async () => {
    const data = fixture("partial-error", async () => {
      const projector = new ClineRowProjector();
      projector.history([{ role: "user", ts: Date.now(), content: "执行" }, { role: "assistant", ts: Date.now(), content: "半截回复" }, { role: "assistant", ts: Date.now(), metadata: { displayOnly: true, displayRole: "error" }, content: 'Unknown or disabled provider "custom".' }]);
      return projector;
    });
    await data.session.send(data.params);
    expect(data.outcomes[0]).toMatchObject({ outcome: "failed", error: 'Unknown or disabled provider "custom".' });
    const rows = applyRowOps([], data.ops);
    expect(ofKind(rows, "turnHeader")).toHaveLength(1);
    expect(ofKind(rows, "turnHeader")[0]?.state).toBe("failed");
    expect(ofKind(rows, "assistantText").map((row) => row.state)).toEqual(["complete", "failed"]);
  });

  it("空结果不能显示成功，也不能把上一轮同名输入的历史回复补到本轮", async () => {
    const data = fixture("silent", async () => {
      const projector = new ClineRowProjector();
      projector.history([{ role: "user", ts: 1, content: "执行" }, { role: "assistant", ts: 2, content: "上一轮回复" }]);
      return projector;
    });
    await data.session.send(data.params);
    expect(data.outcomes[0]).toMatchObject({ outcome: "failed", error: expect.stringContaining("没有返回回复") });
    expect(ofKind(applyRowOps([], data.ops), "assistantText").some((row) => row.text === "上一轮回复")).toBe(false);
  });

  it("图片和文件以本地路径发送，图片内容确实保存且用户消息显示原附件", async () => {
    const data = fixture();
    await data.session.send({ ...data.params, permissionMode: "bypass", images: [{ data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png", name: "截图.png" }], files: [{ path: "/tmp/文档.pdf", name: "文档.pdf", mimeType: "application/pdf", size: 10 }] });
    const prompt = JSON.parse(await readFile(join(root, "prompt.json"), "utf8"));
    expect(prompt.prompt[0].text).toContain("/tmp/文档.pdf");
    const imagePath = /"path":"([^"]+\.png)"/.exec(prompt.prompt[0].text)?.[1];
    expect(await readFile(imagePath!, "utf8")).toBe("image-bytes");
    expect(ofKind(applyRowOps([], data.ops), "userInput")[0]?.attachments?.map((file) => file.fileName)).toEqual(["截图.png", "文档.pdf"]);
  });

  it("完整适配器读取自定义提供商，选择另一提供商的模型后发送正确的原生 ID", async () => {
    const data = fixture();
    const settingsDir = join(root, "state/settings");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "providers.json"), JSON.stringify({ version: 1, lastUsedProvider: "first", providers: {
      first: { settings: { apiKey: "first-key", model: "first-model" } },
      second: { settings: { apiKey: "second-key", model: "second-model" } },
    } }));
    await writeFile(join(settingsDir, "models.json"), JSON.stringify({ providers: {
      first: { provider: { name: "First" }, models: { "first-model": { name: "First model" } } },
      second: { provider: { name: "Second" }, models: { "second-model": { name: "Second model" } } },
    } }));
    const provider = new ClineAgent(data.events, () => ({ ...process.env as Record<string, string>, CLINE_DATA_DIR: join(root, "state"), REQUIRE_KEY: "true", CAPTURE: join(root, "prompt.json") }), () => path, join(root, "attachments"));
    try {
      const models = await provider.listModels();
      expect(models.map((model) => model.value)).toEqual(["", "cline-model:first/first-model", "cline-model:second/second-model"]);
      expect(JSON.stringify(models)).not.toContain("key");
      await provider.send({ ...data.params, model: models[2]!.value, permissionMode: "bypass" });
      await vi.waitFor(() => expect(data.outcomes[0]?.outcome).toBe("succeeded"));
      expect(await readFile(join(root, "prompt.json.model"), "utf8")).toBe("second-model");
      const prompt = JSON.parse(await readFile(join(root, "prompt.json"), "utf8"));
      expect(prompt).toMatchObject({ provider: "second", configuredModel: "second-model", backend: "local" });
    } finally { provider.dispose(); }
  });
});

describe("Cline 历史投影", () => {
  it("只汇总最后一轮的模型用量，工具结果与显示消息不计入，缺失用量不猜测", () => {
    const projector = new ClineRowProjector();
    const messages = [
      { role: "user", ts: 1, content: "旧问题" },
      { role: "assistant", ts: 2, content: "旧回复", metrics: { inputTokens: 1000, outputTokens: 1000 } },
      { role: "user", ts: 3, content: "问题" },
      { role: "assistant", ts: 4, content: [{ type: "tool_use", id: "read", name: "read_files", input: {} }], metrics: { inputTokens: 100, outputTokens: 20 } },
      { role: "user", ts: 5, content: [{ type: "tool_result", tool_use_id: "read", content: "文件" }] },
      { role: "assistant", ts: 6, content: "完成", metrics: { inputTokens: 200, outputTokens: 30 } },
      { role: "assistant", ts: 7, content: "状态", metadata: { displayOnly: true, displayRole: "status" } },
    ];
    projector.history(messages);
    expect(projector.lastTurnUsage).toEqual({ inputTokens: 300, outputTokens: 50 });
    const missing = new ClineRowProjector();
    missing.history([...messages, { role: "assistant", ts: 8, content: "缺少用量" }]);
    expect(missing.lastTurnUsage).toEqual({});
  });
  it("工具结果中的 user role 不创建额外轮次，恢复正文、思考、附件和 sidecar 工具", () => {
    const projector = new ClineRowProjector();
    projector.history([
      { role: "user", ts: 1, content: [{ type: "text", text: '<user_input mode="act">问题</user_input><mode_notice>隐藏</mode_notice>' }] },
      { role: "assistant", ts: 2, content: [{ type: "thinking", thinking: "想法" }, { type: "tool_use", id: "read", name: "read_files", input: { files: ["a.ts"] } }] },
      { role: "user", ts: 3, content: [{ type: "tool_result", tool_use_id: "read", content: "文件内容" }] },
      { role: "user", ts: 4, metadata: { kind: "completion_reminder", userRunSpan: 0 }, content: "隐藏提醒" },
      { role: "assistant", ts: 5, metadata: { modelToolActivities: [{ toolCallId: "search", toolName: "web_search", input: { query: "搜索" }, output: "结果", execution: "provider" }] }, content: "回复" },
      { role: "user", ts: 6, content: [{ type: "text", text: "看图" }, { type: "image", data: "YQ==", mediaType: "image/png" }] },
      { role: "assistant", ts: 7, content: "好了" },
    ]);
    const rows = projector.snapshot();
    expect(ofKind(rows, "userInput").map((row) => row.text)).toEqual(["问题", "看图"]);
    expect(ofKind(rows, "turnHeader")).toHaveLength(2);
    expect(ofKind(rows, "reasoning")[0]?.text).toBe("想法");
    expect(ofKind(rows, "toolCall").map((row) => row.status)).toEqual(["success", "success"]);
    expect(ofKind(rows, "userInput")[1]?.attachments?.[0]?.ref).toBe("data:image/png;base64,YQ==");
  });

  it("从原生列表恢复目录与标题，排除子代理并尊重自定义数据目录", () => {
    const row = { sessionId: "session", cwd: "/repo", startedAt: "2026-10-12T01:00:00Z", updatedAt: "2026-10-12T02:00:00Z", metadata: { title: "会话标题" }, prompt: "原问题" };
    expect(clineSummary(row)).toMatchObject({ agent: "cline", id: "session", projectPath: "/repo", title: "会话标题", updatedAt: Date.parse(row.updatedAt) });
    expect(clineSummary({ ...row, isSubagent: true })).toBeNull();
    expect(clineSummary({ ...row, parentSessionId: "parent" })).toBeNull();
    expect(clineDataDir({ CLINE_DIR: "/custom" })).toBe("/custom/data");
    expect(clineDataDir({ CLINE_DATA_DIR: "/state" })).toBe("/state");
  });

  it("历史中的多块用户文字合为一轮，路径附件只恢复一次", () => {
    const projector = new ClineRowProjector();
    projector.history([{ role: "user", ts: 1, content: [
      { type: "text", text: "读取" },
      { type: "text", text: withFileReferences("文档", [{ path: "/tmp/document.pdf", name: "文档.pdf", mimeType: "application/pdf", size: 1 }]) },
    ] }, { role: "assistant", ts: 2, content: "好的" }]);
    const users = ofKind(projector.snapshot(), "userInput");
    expect(users).toHaveLength(1);
    expect(users[0]?.text).toBe("读取\n文档");
    expect(users[0]?.attachments?.map((file) => file.fileName)).toEqual(["文档.pdf"]);
  });
});

describe("Cline 响应吞吐", () => {
  it("按 prompt 到结束计时，工具及重叠审批只扣除一次，下一轮重置", () => {
    let now = 0;
    const metrics = new ClineResponseMetrics(() => now);
    metrics.start();
    now = 1000;
    metrics.beginTurn("first");
    now = 2000;
    metrics.output("思考");
    now = 3000;
    metrics.update({ sessionUpdate: "tool_call", toolCallId: "tool" });
    metrics.approval("permission", true);
    now = 7000;
    metrics.approval("permission", false);
    now = 8000;
    metrics.update({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" });
    now = 10000;
    metrics.output("完成");
    now = 11000;
    metrics.finishTurn("completed");
    expect(metrics.snapshot(250)).toEqual({ ttftMs: 2000, outputTokensPerSecond: 50, outputSpeedBasis: "activeTurn", outputSpeedDurationMs: 5000 });
    expect(metrics.snapshot()).toEqual({ ttftMs: 2000 });
    metrics.start();
    metrics.beginTurn("next");
    now = 12000;
    metrics.output("停止");
    metrics.finishTurn("cancelled");
    expect(metrics.snapshot(250)).toEqual({ ttftMs: 1000 });
  });
});
