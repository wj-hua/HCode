import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyRowOps } from "../../../../renderer/app/rows.js";
import type { TurnOutcome } from "../../../../shared/collaboration.js";
import type { NotificationFeedEvent } from "../../../../shared/remoteControl.js";
import type { ChatStateEvent, ConversationRow, PermissionRequestEvent, PermissionResolvedEvent } from "../../../../shared/types.js";
import { NotificationFeed } from "../../../remoteControl/notificationFeed.js";
import { AgySession } from "../agySession.js";

function acpMockProgram(sessionId: string) {
  return `#!${process.execPath}
    const readline = require("node:readline");
    const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
    const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
    const update = (u) => notify("session/update", { sessionId: ${JSON.stringify(sessionId)}, update: u });
    let turn = 0;
    let promptReqId = null;
    let permReqId = null;
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        } });
        return;
      }
      if (msg.method === "session/new") {
        send({ jsonrpc: "2.0", id: msg.id, result: {
          sessionId: ${JSON.stringify(sessionId)},
          models: { availableModels: [{ modelId: "gemini-4-hydrogen-high" }], currentModelId: "gemini-4-argon-medium" },
          modes: { currentModeId: "default" },
        } });
        return;
      }
      if (msg.method === "session/load") {
        // 历史重放通知应在 session/load 返回前到达并被实时会话忽略，仅保留 usage_update。
        update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "旧问题" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "旧答复" } });
        update({ sessionUpdate: "usage_update", used: 12000, size: 1048576 });
        send({ jsonrpc: "2.0", id: msg.id, result: {
          sessionId: ${JSON.stringify(sessionId)},
          models: { availableModels: [{ modelId: "gemini-4-hydrogen-high" }], currentModelId: "gemini-4-hydrogen-high" },
          modes: { currentModeId: "default" },
        } });
        return;
      }
      if (msg.method === "session/set_model" || msg.method === "session/set_mode" || msg.method === "session/set_config_option") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
        return;
      }
      if (msg.method === "session/cancel") {
        if (promptReqId !== null) {
          const id = promptReqId;
          promptReqId = null;
          send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
        }
        return;
      }
      if (msg.method === "session/prompt") {
        turn++;
        promptReqId = msg.id;
        if (turn === 1) {
          update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "正在分析文件" } });
          setTimeout(() => {
            update({ sessionUpdate: "tool_call", toolCallId: "tc-1", name: "read_file", args: { Path: "/repo/a.ts", StartLine: 1, EndLine: 20 }, status: "in_progress" });
            setTimeout(() => {
              update({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", name: "read_file", status: "completed", rawOutput: { output: "Created At: x\\nCompleted At: y\\n\\nhello" } });
              update({ sessionUpdate: "usage_update", used: 25000, size: 1048576 });
              update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已读取" } });
              setTimeout(() => {
                update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完毕" } });
                promptReqId = null;
                send({ jsonrpc: "2.0", id: msg.id, result: {
                  stopReason: "end_turn",
                  usage: { inputTokens: 15000, cachedReadTokens: 10000, outputTokens: 200 },
                } });
              }, 20);
            }, 20);
          }, 20);
          return;
        }
        if (turn === 2) {
          update({ sessionUpdate: "tool_call", toolCallId: "tc-2", name: "edit_file", args: { Path: "/repo/a.ts", Target: "a", Replacement: "b" }, status: "in_progress" });
          permReqId = 9001;
          send({ jsonrpc: "2.0", id: permReqId, method: "session/request_permission", params: {
            toolCall: { toolCallId: "tc-2", name: "edit_file", args: { Path: "/repo/a.ts", Target: "a", Replacement: "b" }, title: "Edit a.ts" },
            options: [{ optionId: "opt-allow", kind: "allow_once", name: "Allow" }, { optionId: "opt-deny", kind: "reject_once", name: "Deny" }],
          } });
          return;
        }
        if (turn === 3) {
          update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "等待取消" } });
          return;
        }
      }
      if (msg.id === permReqId) {
        permReqId = null;
        update({ sessionUpdate: "tool_call_update", toolCallId: "tc-2", name: "edit_file", status: "completed", rawOutput: {} });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已修改" } });
        const id = promptReqId;
        promptReqId = null;
        send({ jsonrpc: "2.0", id, result: {
          stopReason: "end_turn",
          usage: { inputTokens: 2000, cachedReadTokens: 23000, outputTokens: 80 },
        } });
      }
    });
  `;
}

describe("Antigravity ACP 会话", () => {
  it("实时推送思考与正文流、映射 1.5 工具路径、处理审批与取消", async () => {
    const root = await mkdtemp(join(tmpdir(), "hcode-agy-acp-"));
    const sessionId = randomUUID();
    const program = join(root, "acp-mock.cjs");
    await writeFile(program, acpMockProgram(sessionId), { mode: 0o755 });

    let rows: ConversationRow[] = [];
    const states: ChatStateEvent[] = [];
    const permissions: PermissionRequestEvent[] = [];
    const resolved: PermissionResolvedEvent[] = [];
    const outcomes: TurnOutcome[] = [];

    const session = new AgySession({
      resolveLaunch: async (_cwd, args) => ({ path: program, cwd: root, env: {}, args }),
      emitRows: (_key, ops) => { rows = applyRowOps(rows, ops); },
      emitState: (event) => states.push(event),
      emitPermission: (event) => permissions.push(event),
      emitPermissionResolved: (event) => resolved.push(event),
      emitTurnOutcome: (event) => outcomes.push(event),
      onSettled: () => {},
    }, {
      key: randomUUID(),
      projectPath: root,
      permissionMode: "default",
      model: "gemini-4-hydrogen-high",
      transport: "acp",
    });

    try {
      await session.send("先读文件", [{ data: "AA==", mimeType: "image/png" }], [], "turn-1");
      await vi.waitFor(() => expect(outcomes).toHaveLength(1));
      expect(outcomes[0]).toMatchObject({
        executionTurnId: "turn-1",
        nativeSessionId: sessionId,
        outcome: "succeeded",
        text: "已读取完毕",
      });
      const turn1Rows = rows.filter((r) => r.turnId === "turn-1");
      expect(turn1Rows.map((r) => r.kind)).toEqual(["turnHeader", "userInput", "reasoning", "toolCall", "assistantText"]);
      const reasoning = turn1Rows.find((r) => r.kind === "reasoning")!;
      expect(reasoning).toMatchObject({ text: "正在分析文件", state: "complete" });
      expect(reasoning.durationMs).toBeGreaterThanOrEqual(0);
      const readTool = turn1Rows.find((r) => r.kind === "toolCall")!;
      expect(readTool).toMatchObject({
        toolName: "Read",
        input: { file_path: "/repo/a.ts", offset: 1, limit: 20 },
        output: { text: "hello" },
        status: "success",
      });
      expect(states.at(-1)?.usage).toMatchObject({
        contextUsedTokens: 25000,
        contextWindowTokens: 1_048_576,
        inputTokens: 25000,
        outputTokens: 200,
      });

      // 第二轮：触发权限审批并放行
      const turn2Promise = session.send("改文件", [], [], "turn-2");
      await vi.waitFor(() => expect(permissions).toHaveLength(1));
      expect(states.at(-1)?.state).toBe("awaitingApproval");
      expect(permissions[0]).toMatchObject({
        toolName: "Edit",
        input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
        canAllowForSession: false,
      });
      expect(session.respondPermission(permissions[0]!.interactionId, { decision: "allow" })).toBe(true);
      expect(resolved).toHaveLength(1);
      await turn2Promise;
      await vi.waitFor(() => expect(outcomes).toHaveLength(2));
      expect(outcomes[1]).toMatchObject({ outcome: "succeeded", text: "已修改" });

      // 第三轮：运行中通过 session/cancel 取消
      const turn3Promise = session.send("长任务", [], [], "turn-3");
      await vi.waitFor(() => expect(rows.some((r) => r.turnId === "turn-3" && r.kind === "reasoning" && r.state === "streaming")).toBe(true));
      await session.interrupt();
      await turn3Promise;
      await vi.waitFor(() => expect(outcomes).toHaveLength(3));
      expect(outcomes[2]).toMatchObject({ executionTurnId: "turn-3", outcome: "cancelled" });
      expect(states.at(-1)?.state).toBe("idle");
    } finally {
      session.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("恢复历史会话时忽略 session/load 重放流，保留实时上下文容量", async () => {
    const root = await mkdtemp(join(tmpdir(), "hcode-agy-acp-load-"));
    const sessionId = randomUUID();
    const program = join(root, "acp-load-mock.cjs");
    await writeFile(program, acpMockProgram(sessionId), { mode: 0o755 });

    let rows: ConversationRow[] = [];
    const states: ChatStateEvent[] = [];
    const outcomes: TurnOutcome[] = [];
    const session = new AgySession({
      resolveLaunch: async (_cwd, args) => ({ path: program, cwd: root, env: {}, args }),
      emitRows: (_key, ops) => { rows = applyRowOps(rows, ops); },
      emitState: (event) => states.push(event),
      emitTurnOutcome: (event) => outcomes.push(event),
      onSettled: () => {},
    }, {
      key: randomUUID(),
      projectPath: root,
      sessionId,
      permissionMode: "default",
      transport: "acp",
    });

    try {
      session.seedHistory([
        { type: "USER_INPUT", step_index: 0, content: "<USER_REQUEST>\n旧问题\n</USER_REQUEST>" },
        { type: "PLANNER_RESPONSE", step_index: 1, status: "DONE", content: "旧答复" },
      ]);
      const beforeCount = rows.length;
      await session.send("新问题", [], [], "turn-next");
      await vi.waitFor(() => expect(outcomes).toHaveLength(1));
      expect(rows.filter((r) => r.kind === "userInput").map((r) => r.text)).toEqual(["旧问题", "新问题"]);
      expect(rows.length).toBeGreaterThan(beforeCount);
      expect(states.at(-1)?.usage?.contextUsedTokens).toBe(25000);
    } finally {
      session.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("后台任务在 prompt 结束后保持运行态，完成后唤醒回合正常投影并触发完成通知", async () => {
    const root = await mkdtemp(join(tmpdir(), "hcode-agy-acp-bg-"));
    const sessionId = randomUUID();
    const program = join(root, "acp-bg-mock.cjs");
    await writeFile(program, `#!${process.execPath}
      const readline = require("node:readline");
      const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
      const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
      const update = (u) => notify("session/update", { sessionId: ${JSON.stringify(sessionId)}, update: u });
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          return;
        }
        if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: ${JSON.stringify(sessionId)}, modes: { currentModeId: "default" } } });
          return;
        }
        if (msg.method === "session/set_model" || msg.method === "session/set_mode" || msg.method === "session/set_config_option") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          update({ sessionUpdate: "tool_call", toolCallId: "bg-1", name: "run_command", args: { CommandLine: "pnpm dist" }, title: "pnpm dist", status: "in_progress" });
          setTimeout(() => {
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正在执行 pnpm dist，完成后立即通知你。" } });
            update({ sessionUpdate: "usage_update", used: 30000, size: 1048576 });
            send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });

            // 模拟后台任务完成并自动唤醒模型：先执行检查命令，再输出最终完成回复
            setTimeout(() => {
              update({ sessionUpdate: "tool_call_update", toolCallId: "bg-1", name: "run_command", title: "pnpm dist", status: "completed", rawOutput: { output: "dist ok" } });
              setTimeout(() => {
                update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "检查打包产物" } });
                update({ sessionUpdate: "usage_update", used: 31000, size: 1048576 });
                setTimeout(() => {
                  update({ sessionUpdate: "tool_call", toolCallId: "verify-1", name: "run_command", args: { CommandLine: "ls -lh release" }, title: "ls -lh release", status: "in_progress" });
                  setTimeout(() => {
                    update({ sessionUpdate: "tool_call_update", toolCallId: "verify-1", name: "run_command", title: "ls -lh release", status: "completed", rawOutput: { output: "HCode.dmg 118M" } });
                    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "打包已完成，产物为 HCode.dmg。" } });
                    update({ sessionUpdate: "usage_update", used: 32000, size: 1048576 });
                  }, 50);
                }, 10);
              }, 20);
            }, 60);
          }, 20);
        }
      });
    `, { mode: 0o755 });

    let rows: ConversationRow[] = [];
    const states: ChatStateEvent[] = [];
    const notifications: NotificationFeedEvent[] = [];
    let settledCount = 0;
    let session!: AgySession;
    const feed = new NotificationFeed(Date.now, undefined, () => session.liveRows(), (event) => notifications.push(event));

    session = new AgySession({
      resolveLaunch: async (_cwd, args) => ({ path: program, cwd: root, env: {}, args }),
      emitRows: (_key, ops) => { rows = applyRowOps(rows, ops); },
      emitState: (event) => {
        states.push(event);
        feed.observe("chat:state", event);
      },
      onSettled: () => { settledCount++; },
    }, {
      key: randomUUID(),
      projectPath: root,
      permissionMode: "default",
      transport: "acp",
      acpNativeSettleMs: 35,
    });

    try {
      await session.send("打包吧", [], [], "turn-pack");
      // prompt 刚结束时，后台任务仍在运行且工具行不被误标为 cancelled
      expect(session.hasBackgroundTasks).toBe(true);
      expect(states.at(-1)).toMatchObject({
        state: "idle",
        backgroundTasks: 1,
        backgroundTaskDetails: [{ id: "bg-1", description: "pnpm dist", status: "running", toolUseId: "bg-1" }],
      });
      const bgToolRunning = rows.find((r) => r.kind === "toolCall" && r.toolCallId === "bg-1");
      expect(bgToolRunning).toMatchObject({ status: "running" });

      // 等待后台任务完成、唤醒回合跑完并再次结算
      await vi.waitFor(() => expect(settledCount).toBe(2), { timeout: 5000 });
      expect(session.hasBackgroundTasks).toBe(false);
      expect(states.at(-1)?.state).toBe("idle");
      expect(states.at(-1)?.backgroundTasks).toBeUndefined();
      expect(states.at(-1)?.backgroundTaskDetails).toMatchObject([{ id: "bg-1", status: "completed" }]);

      const bgToolDone = rows.find((r) => r.kind === "toolCall" && r.toolCallId === "bg-1");
      expect(bgToolDone).toMatchObject({ status: "success", output: { text: "dist ok" } });
      const verifyTool = rows.find((r) => r.kind === "toolCall" && r.toolCallId === "verify-1");
      expect(verifyTool).toMatchObject({ status: "success", output: { text: "HCode.dmg 118M" } });
      const texts = rows.filter((r) => r.kind === "assistantText").map((r) => r.text);
      expect(texts).toContain("打包已完成，产物为 HCode.dmg。");

      // NotificationFeed 应在唤醒回合结束时再次发出完成通知，且摘要为最终回复
      const doneSummaries = notifications.filter((n) => n.type === "done").map((n) => n.summary);
      expect(doneSummaries).toContain("打包已完成，产物为 HCode.dmg。");
    } finally {
      session.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("后台唤醒回合支持手动中断且不会卡在运行中", async () => {
    const root = await mkdtemp(join(tmpdir(), "hcode-agy-acp-bg-cancel-"));
    const sessionId = randomUUID();
    const program = join(root, "acp-bg-cancel-mock.cjs");
    await writeFile(program, `#!${process.execPath}
      const readline = require("node:readline");
      const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
      const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
      const update = (u) => notify("session/update", { sessionId: ${JSON.stringify(sessionId)}, update: u });
      let cancelled = false;
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
          return;
        }
        if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: ${JSON.stringify(sessionId)}, modes: { currentModeId: "default" } } });
          return;
        }
        if (msg.method === "session/cancel") {
          cancelled = true;
          return;
        }
        if (msg.method === "session/prompt") {
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          setTimeout(() => {
            if (!cancelled) update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "异步唤醒持续思考中" } });
          }, 25);
        }
      });
    `, { mode: 0o755 });

    let rows: ConversationRow[] = [];
    const states: ChatStateEvent[] = [];
    const session = new AgySession({
      resolveLaunch: async (_cwd, args) => ({ path: program, cwd: root, env: {}, args }),
      emitRows: (_key, ops) => { rows = applyRowOps(rows, ops); },
      emitState: (event) => states.push(event),
      onSettled: () => {},
    }, {
      key: randomUUID(),
      projectPath: root,
      permissionMode: "default",
      transport: "acp",
      acpNativeSettleMs: 5000,
    });

    try {
      await session.send("设个提醒", [], [], "turn-1");
      await vi.waitFor(() => expect(states.at(-1)?.state).toBe("running"), { timeout: 3000 });
      await session.interrupt();
      expect(states.at(-1)?.state).toBe("idle");
      expect(rows.some((r) => r.kind === "reasoning" && r.state === "interrupted")).toBe(true);
    } finally {
      session.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
