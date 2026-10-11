// 显式真实工具澄清→活动回合接管→回复→原生会话续跑→独立审查与汇总。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("../../util/trash.js", () => ({ trashPaths: async () => { throw new Error("原生验收禁止删除历史"); } }));
import { nativeFixture } from "./nativeFixture.js";

it.skipIf(process.env.HCODE_NATIVE_S2 !== "1")("S2 真实澄清、暂停接管及回复后续跑", async () => {
  let pausing: Promise<void> | undefined;
  const data = await nativeFixture("hcode-s2-native-", undefined, (snapshot) => {
    if (!pausing && snapshot.status === "running" && snapshot.messages?.some((message) => message.type === "clarification")) pausing = data.service.controls.stop(snapshot.id, "pause");
  });
  let restarted: Awaited<ReturnType<typeof nativeFixture>> | undefined;
  try {
    await writeFile(join(data.root, "source.ts"), "export const allowed = [0, 42];\n");
    const start = await data.service.start({ initiator: { agent: "claude", sessionKey: randomUUID(), projectPath: data.root, permissionMode: "default", model: "sonnet" }, executor: { agent: "codex" }, objective: "必须只委派一个任务给执行者。source.ts 的 allowed 含 0 和42。调研实际源码与产品期望是否一致。产品是否允许0尚未确定，不能自行决定：要求执行者首先调用宿主 request_context，requiresUser=true，提问用户是否允许0，然后结束此回合；回复前不生成报告。用户回答后依据回复和实际源码出带证据报告，说明未运行测试。" });
    await vi.waitFor(() => expect(data.latest()?.stage).toBe("finished"), { timeout: 240_000, interval: 1000 });
    await pausing;
    expect(data.latest()?.status, JSON.stringify(data.latest())).toBe("paused");
    expect(data.latest()?.tasks.every((task) => task.status !== "running")).toBe(true);
    data.service.dispose(); data.agents.dispose();
    restarted = await nativeFixture("hcode-s2-restarted-", undefined, undefined, data.root);
    const recovered = await restarted.service.get(start.id);
    expect(recovered.status).toBe("paused");
    expect(restarted.latest()).toBeUndefined();
    const question = recovered.messages!.find((entry) => entry.type === "clarification")!;
    expect(question.requiresUser).toBe(true);
    await restarted.service.controls.reply(start.id, question.id, "用户决定：允许0和42；当前源码符合期望。仍只读调研，不执行测试。" );
    await restarted.service.controls.resume(start.id, { action: "execute" });
    await vi.waitFor(() => expect(restarted!.latest()?.status).toBe("completed"), { timeout: 300_000, interval: 1000 });
    const final = await restarted.service.get(start.id);
    expect(final.deliveries).toHaveLength(1);
    expect(final.deliveries[0]!.status).toBe("accepted");
    expect(final.messages).toHaveLength(2);
    const workers = final.tasks.filter((task) => task.role === "execution");
    expect(workers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(workers.map((task) => task.nativeSessionId)).size).toBe(1);
    expect(final.deliveries[0]!.reviews.at(-1)?.verdict).toBe("approved");
  } finally { if (restarted) await restarted.cleanup(); else await data.cleanup(); }
}, 600_000);
