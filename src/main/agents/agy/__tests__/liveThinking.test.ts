// 从 agy 1.5.8 的事件形状重放实时路径，用渲染侧同一套增量处理校验思考行。
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { applyRowOps } from "../../../../renderer/app/rows.js";
import type { ConversationRow } from "../../../../shared/types.js";
import { AgySession } from "../agySession.js";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  fixture.home = await (await import("node:fs/promises")).mkdtemp((await import("node:path")).join(os.tmpdir(), "hcode-agy-home-"));
  return { ...os, homedir: () => fixture.home };
});

it("实时事件缺 thinking 时按原生步骤补入，晚到记录仍归原轮，与旧版增量不重复", async () => {
  const root = await mkdtemp(join(tmpdir(), "hcode-thinking-cli-"));
  const id = randomUUID();
  const logs = join(fixture.home, ".gemini/antigravity-cli/brain", id, ".system_generated/logs");
  await mkdir(logs, { recursive: true });
  const program = join(root, "cli.cjs");
  await writeFile(program, `
    const send = event => console.log(JSON.stringify(event));
    const step = update => send({ event: "step_update", step_update: { conversation_id: "${id}", ...update } });
    send({ event: "init", conversation_id: "${id}" });
    let turns = 0;
    require("node:readline").createInterface({input:process.stdin}).on("line", () => {
      if (++turns === 2) {
        step({ step_type: "agent_response", step_index: 5, state: "DONE", thinking_delta: "旧版增量" });
        return;
      }
      step({ step_type: "agent_response", step_index: 1, state: "DONE" });
      step({ step_type: "tool", step_index: 2, state: "ACTIVE", tool_name: "read_file" });
      const timer = setInterval(() => {
        if (!require("node:fs").existsSync("finish")) return;
        clearInterval(timer);
        step({ step_type: "agent_response", step_index: 3, state: "DONE", text_delta: "完成" });
        send({ event:"result", result:{conversation_id:"${id}", num_turns:1, status:"SUCCESS", response:"完成"} });
      }, 10);
    });
  `);
  let rows: ConversationRow[] = [];
  const session = new AgySession({
    resolveLaunch: async () => ({ path: process.execPath, cwd: root, env: {}, args: [program] }),
    emitRows: (_key, ops) => { rows = applyRowOps(rows, ops); }, emitState: () => {}, onSettled: () => {},
  }, { key: id, projectPath: root, permissionMode: "default" });
  const transcript = join(logs, "transcript_full.jsonl");
  const planner = (index: number, thinking: string) => JSON.stringify({ step_index: index, type: "PLANNER_RESPONSE", status: "DONE", thinking });
  try {
    await session.send("查文件", [], [], "first");
    await vi.waitFor(() => expect(rows.some(row => row.kind === "toolCall")).toBe(true));
    // 文件可能晚于 stdout 创建，且首个可见版本可能只写了半行。
    const longThinking = "读取前的思考".repeat(5000); // 跨读取块的 UTF-8 原文
    const line = planner(1, longThinking);
    await writeFile(transcript, line.slice(0, -3));
    await appendFile(transcript, line.slice(-3) + "\n");
    await vi.waitFor(() => expect(rows.map(row => row.kind)).toEqual(["turnHeader", "userInput", "reasoning", "toolCall"]));
    expect(session.isBusy).toBe(true);
    await writeFile(join(root, "finish"), "");
    await vi.waitFor(() => expect(session.isBusy).toBe(false));
    await session.send("继续", [], [], "second");
    await appendFile(transcript, planner(3, "回复前的思考") + "\n" + planner(5, "旧版增量") + "\n");
    await vi.waitFor(() => expect(rows.filter(row => row.kind === "reasoning").map(row => [row.turnId, row.text])).toEqual([
      ["first", longThinking], ["first", "回复前的思考"], ["second", "旧版增量"],
    ]));
    expect(rows.filter(row => row.turnId === "first").map(row => row.kind)).toEqual([
      "turnHeader", "userInput", "reasoning", "toolCall", "reasoning", "assistantText",
    ]);
    expect(session.liveRows()).toEqual(rows);
  } finally {
    session.close();
    await rm(root, { recursive: true, force: true });
    await rm(fixture.home, { recursive: true, force: true });
  }
});
