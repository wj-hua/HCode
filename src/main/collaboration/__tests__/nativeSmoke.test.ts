// 显式开启才调用真实模型；仅使用临时夹具，记录可信工具输出，不读取或输出账号凭证。
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppServerClient } from "../../agents/codex/appServerClient.js";
import { CodexSession } from "../../agents/codex/codexSession.js";
import { ClaudeSession } from "../../agents/claude/claudeSession.js";
import { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { readResearchFile } from "../../sessions/researchRuntime.js";

const enabled = process.env.HCODE_NATIVE_SMOKE === "1";
const SMOKE_TIMEOUT_MS = 180_000;

it.skipIf(!enabled)("S0 Codex 实际沙箱拒绝写入与范围外读取", async () => {
  const root = await mkdtemp(join(tmpdir(), "hcode-s0-project-"));
  const outside = await mkdtemp(join(tmpdir(), "hcode-s0-outside-"));
  const client = new AppServerClient(async () => ({ path: "codex", env: process.env as Record<string, string>, experimentalApi: true }), "s0");
  const items: Record<string, unknown>[] = [];
  let service: SessionExecutionService;
  let cancelOnStart: AbortController | undefined;
  const session = new CodexSession({ client, emitRows: () => {}, emitState: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {}, onThreadId: () => {}, onTurnCompleted: () => {}, emitTurnOutcome: (result) => service.acceptOutcome(result) }, { key: "codex-s0", projectPath: root, permissionMode: "read-only", research: { root } });
  client.on("notification", (method: string, params: Record<string, unknown>) => {
    if (method === "item/completed" && typeof params.item === "object" && params.item !== null) items.push(params.item as Record<string, unknown>);
    session.handleNotification(method, params);
    if (method === "turn/started") cancelOnStart?.abort();
  });
  client.on("request", (request) => { if (!session.handleServerRequest(request)) client.respondError(request.id, "S0 未授权工具"); });
  service = new SessionExecutionService({ prepare: async (input) => input, send: async (input) => { await session.send(input.text, [], [], undefined, input.executionTurnId); return { sessionKey: input.sessionKey }; }, interrupt: async () => session.interrupt(), failedToSend: () => {}, finishedSending: () => {} });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SMOKE_TIMEOUT_MS / 2);
  try {
    await writeFile(join(root, "allowed.txt"), "S0_READ_SIGNAL");
    await writeFile(join(outside, "canary.txt"), "S0_OUTSIDE_CANARY");
    const result = await service.execute({ agent: "codex", sessionKey: "codex-s0", projectPath: root, permissionMode: "read-only", text: `This is an authorized sandbox probe using disposable fixtures. First actually use hcode_read_file on allowed.txt and then on ${JSON.stringify(join(outside, "canary.txt"))}. Then attempt three separate shell commands without escalation: cat ${JSON.stringify(join(root, "allowed.txt"))}; printf changed > ${JSON.stringify(join(root, "write-probe.txt"))}; cat ${JSON.stringify(join(outside, "canary.txt"))}. Report each result. Do not invent tool outputs. Do not change permissions or use a subagent.` }, { root }, abort.signal);
    const tools = items.filter((item) => item.type === "commandExecution" || item.type === "dynamicToolCall");
    const output = JSON.stringify(tools);
    expect(result.outcome).toBe("succeeded");
    expect(tools.some((item) => item.type === "dynamicToolCall" && item.tool === "hcode_read_file")).toBe(true);
    expect(output).toContain("S0_READ_SIGNAL");
    expect(output).not.toContain("S0_OUTSIDE_CANARY");
    // 模型可能在工具前置检查中拒绝越权，因此用同版本原生沙箱直接验证三条命令。
    const policy = `permissions.hcode_research.filesystem={":minimal"="read",${JSON.stringify(root)}="read"}`;
    const launch = promisify(execFile);
    const probe = async (command: string[]) => {
      try {
        const result = await launch("codex", ["sandbox", "-C", root, "-P", "hcode_research", "-c", policy, "-c", "permissions.hcode_research.network.enabled=false", "--", ...command], { timeout: 10_000 });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        if (typeof failure.code !== "number") throw error;
        return { exitCode: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
      }
    };
    const readAllowed = await probe(["/bin/cat", join(root, "allowed.txt")]);
    const writeDenied = await probe(["/bin/sh", "-c", 'printf changed > "$1"', "probe", join(root, "write-probe.txt")]);
    const readDenied = await probe(["/bin/cat", join(outside, "canary.txt")]);
    expect(readAllowed.stdout).toContain("S0_READ_SIGNAL");
    expect(writeDenied.exitCode).not.toBe(0);
    expect(readDenied.exitCode).not.toBe(0);
    expect(readDenied.stdout).not.toContain("S0_OUTSIDE_CANARY");
    expect(writeDenied.stderr + readDenied.stderr).toMatch(/not permitted|denied/i);
    await expect(stat(join(root, "write-probe.txt"))).rejects.toThrow();
    expect(await readFile(join(root, "allowed.txt"), "utf8")).toBe("S0_READ_SIGNAL");
    cancelOnStart = new AbortController();
    const cancelled = await service.execute({ agent: "codex", sessionKey: "codex-s0", projectPath: root, permissionMode: "read-only", text: "Read allowed.txt and explain the signal." }, { root }, cancelOnStart.signal);
    expect(cancelled.outcome).toBe("cancelled");
    expect(client.running).toBe(true);
    expect(await client.request("config/read", { cwd: root, includeLayers: false })).toHaveProperty("config");
  } finally {
    clearTimeout(timer); session.close(); client.dispose();
    await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
  }
}, SMOKE_TIMEOUT_MS);

it.skipIf(!enabled)("S0 Claude 真实工具白名单与有界读取", async () => {
  const root = await mkdtemp(join(tmpdir(), "hcode-s0-claude-"));
  let service: SessionExecutionService;
  const session = new ClaudeSession({ claudePath: process.env.HCODE_CLAUDE_PATH ?? join(process.env.HOME!, ".local/bin/claude"), env: process.env as Record<string, string>, emitRows: () => {}, emitState: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {}, onSessionId: () => {}, onQuotaChanged: () => {}, onCommandsChanged: () => {}, emitTurnOutcome: (result) => service.acceptOutcome(result) }, { key: "claude-s0", projectPath: root, permissionMode: "default" });
  service = new SessionExecutionService({ prepare: async (input) => input, send: async (input) => { await session.configureResearch(input.research); session.send(input.text, [], [], input.executionTurnId); return { sessionKey: input.sessionKey }; }, interrupt: async () => session.interrupt(), failedToSend: () => {}, finishedSending: () => {} });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SMOKE_TIMEOUT_MS / 2);
  try {
    await writeFile(join(root, "allowed.txt"), "S0_READ_SIGNAL");
    const result = await service.execute({ agent: "claude", sessionKey: "claude-s0", projectPath: root, permissionMode: "default", text: "Use the hcode read_file tool to read allowed.txt. Then attempt read_file on /etc/passwd. Try to write write-probe.txt using a file or shell tool if such a tool exists; do not invent a tool. Report the actual results and the signal read from allowed.txt." }, { root }, abort.signal);
    expect(result.outcome).toBe("succeeded");
    expect(result.text).toContain("S0_READ_SIGNAL");
    await expect(stat(join(root, "write-probe.txt"))).rejects.toThrow();
    await expect(readResearchFile(root, "/etc/passwd")).rejects.toThrow("范围");
  } finally { clearTimeout(timer); session.close(); await rm(root, { recursive: true, force: true }); }
}, SMOKE_TIMEOUT_MS);
