import { request } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ConversationRow, RemoteControlSettings } from "../../../shared/types.js";
import { RemoteControlService } from "../remoteControlService.js";
import { RemoteSessionStore } from "../sessionStore.js";
import type { RemoteTokenStore } from "../tokenStore.js";

const PASSWORD = "test-login";
const HEADERS = { "Content-Type": "application/json", "X-HCode-Remote": "1" };
const SCRIPT = `console.log(${JSON.stringify("x".repeat(20_000))});`;
const ROWS = Array.from({ length: 200 }, (_, index) => ({ id: `row-${index}`, kind: "assistant", text: "长对话内容 ".repeat(20) })) as unknown as ConversationRow[];

let staticDir: string;
let service: RemoteControlService;
let port: number;
let liveRows: ConversationRow[];
let projectPaths: string[];

beforeEach(async () => {
  liveRows = ROWS;
  projectPaths = ["/project"];
  staticDir = await mkdtemp(join(tmpdir(), "hcode-remote-static-"));
  await mkdir(join(staticDir, "assets"));
  await writeFile(join(staticDir, "assets", "index-AbCd1234.js"), SCRIPT);
  await writeFile(join(staticDir, "index.html"), `<!doctype html><script src="./assets/index-AbCd1234.js"></script>${" ".repeat(2000)}`);
  const config: RemoteControlSettings = { enabled: true, localPort: 0, sshHost: "", remoteBind: "", notificationFeed: false };
  service = new RemoteControlService({
    config: () => config,
    tokens: { matches: (value: string) => value === PASSWORD } as unknown as RemoteTokenStore,
    notificationTokens: { matches: () => false } as unknown as RemoteTokenStore,
    sessions: new RemoteSessionStore(staticDir),
    policy: { projectPaths: () => projectPaths, attachmentsDir: join(staticDir, "attachments"), sessionState: () => undefined },
    thumbnail: (image) => ({ ...image, body: Buffer.from("small-preview") }),
    invoke: async (channel) => channel === "sessions:load" ? { summary: null, rows: liveRows } : {},
    liveRows: (sessionKey) => sessionKey === "session" ? liveRows : undefined,
    hasSession: () => true, staticDir, env: () => ({}), onStatus: () => {},
  });
  await service.apply();
  port = service.getStatus().port!;
});

afterEach(async () => {
  service.dispose();
  await rm(staticDir, { recursive: true, force: true });
});

/** fetch 会自动解压并隐藏 Content-Encoding，这里用原始 http 请求检查线路上的真实字节。 */
function raw(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function login(): Promise<string> {
  const response = await raw("POST", "/api/login", HEADERS, JSON.stringify({ token: PASSWORD }));
  return String(response.headers["set-cookie"]).split(";")[0]!;
}

it("远程折叠工具只下发摘要，展开读取原文且签名和项目权限仍有效", async () => {
  const tool = { kind: "toolCall", rowId: 1, turnId: "turn", toolCallId: "tool", toolName: "mcp__cua_repl__js", status: "success", inputText: "private-input".repeat(1000), input: { script: "private-input" }, output: { text: "private-output".repeat(1000) } } as ConversationRow;
  liveRows = [tool];
  const cookie = await login();
  const invoke = async (channel: string, args: unknown[]) => JSON.parse((await raw("POST", "/api/invoke", { ...HEADERS, Cookie: cookie }, JSON.stringify({ channel, args }))).body.toString());
  const page = await invoke("sessions:page", [{ agent: "codex", id: "history", projectPath: "/project" }]);
  expect(JSON.stringify(page)).not.toContain("private-input");
  expect(JSON.stringify(page)).not.toContain("private-output");
  const reference = page.result.rows[0].remoteDetails.ref;
  expect((await invoke("tools:detail", [reference])).result).toEqual(tool);
  expect((await invoke("tools:detail", [reference + "x"])).ok).toBe(false);
  projectPaths = [];
  expect((await invoke("tools:detail", [reference])).ok).toBe(false);
});

it("正文里的本机产物图片映射为登录后可读的地址，不开放符号链接越界读取", async () => {
  const picture = join(staticDir, "proof.png");
  const body = Buffer.from("picture-bytes");
  await writeFile(picture, body);
  const escaped = join(staticDir, "escape.png");
  await symlink("/etc/hosts", escaped);
  liveRows = [{ kind: "assistantText", rowId: 1, turnId: "turn", state: "done", text: `![proof](${picture})\n\n![escape](${escaped})` }] as unknown as ConversationRow[];
  const cookie = await login();
  const response = await raw("POST", "/api/invoke", { ...HEADERS, Cookie: cookie }, JSON.stringify({ channel: "sessions:page", args: [{ agent: "codex", id: "history", projectPath: "/project" }] }));
  const text = JSON.parse(response.body.toString()).result.rows[0].text;
  const refs = [...text.matchAll(/\]\((api\/media\/[^)]+)\)/g)].map(match => match[1]);
  expect(refs).toHaveLength(2);
  expect((await raw("GET", `/${refs[0]}`, {})).status).toBe(401);
  expect((await raw("GET", `/${refs[0]}`, { Cookie: cookie })).body).toEqual(body);
  expect((await raw("GET", `/${refs[1]}`, { Cookie: cookie })).status).toBe(404);
});

it("界面脚本按浏览器支持的编码压缩，并允许长期缓存", async () => {
  const response = await raw("GET", "/assets/index-AbCd1234.js", { "Accept-Encoding": "gzip, deflate, br" });
  expect(response.headers["content-encoding"]).toBe("br");
  expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(response.headers.vary).toBe("Accept-Encoding");
  expect(response.body.length).toBeLessThan(SCRIPT.length / 10);
  expect(brotliDecompressSync(response.body).toString()).toBe(SCRIPT);
});

it("不支持 br 的浏览器收到 gzip，不支持压缩的客户端收到原文", async () => {
  const gzipped = await raw("GET", "/assets/index-AbCd1234.js", { "Accept-Encoding": "gzip" });
  expect(gzipped.headers["content-encoding"]).toBe("gzip");
  expect(gunzipSync(gzipped.body).toString()).toBe(SCRIPT);
  const plain = await raw("GET", "/assets/index-AbCd1234.js", { "Accept-Encoding": "identity, br;q=0" });
  expect(plain.headers["content-encoding"]).toBeUndefined();
  expect(plain.body.toString()).toBe(SCRIPT);
});

it("入口页面压缩但不缓存，更新后手机能拿到新版本", async () => {
  const response = await raw("GET", "/", { "Accept-Encoding": "br" });
  expect(response.headers["content-encoding"]).toBe("br");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(brotliDecompressSync(response.body).toString()).toContain("index-AbCd1234.js");
});

it("会话快照压缩传输，内容与原始数据一致", async () => {
  const cookie = await login();
  const response = await raw("POST", "/api/invoke", { ...HEADERS, Cookie: cookie, "Accept-Encoding": "br" },
    JSON.stringify({ channel: "chat:snapshot", args: ["session"] }));
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe("br");
  const plain = JSON.stringify({ ok: true, result: { seq: 0, rows: ROWS, state: null, permissions: [] } });
  expect(response.body.length).toBeLessThan(Buffer.byteLength(plain) / 10);
  expect(JSON.parse(brotliDecompressSync(response.body).toString())).toEqual(JSON.parse(plain));
});

it("会话先返回图片地址，原图仍需登录且内容变化后不误取另一张图", async () => {
  const image = Buffer.from("private-image-content");
  const imageRow = { rowId: 501, turnId: "turn", kind: "userInput", attachments: [{ ref: `data:image/png;base64,${image.toString("base64")}`, mime: "image/png", fileName: "image.png", bytes: image.length }] } as ConversationRow;
  liveRows = [...ROWS, imageRow];
  const cookie = await login();
  const response = await raw("POST", "/api/invoke", { ...HEADERS, Cookie: cookie }, JSON.stringify({ channel: "chat:snapshot", args: ["session"] }));
  const result = JSON.parse(response.body.toString());
  const ref: string = result.result.rows.at(-1).attachments[0].ref;
  expect(ref).toMatch(/^api\/media\//);
  expect(response.body.toString()).not.toContain(image.toString("base64"));
  expect((await raw("GET", `/${ref}`, {})).status).toBe(401);
  const original = await raw("GET", `/${ref}`, { Cookie: cookie });
  expect(original.status).toBe(200);
  expect(original.body).toEqual(image);
  expect(original.headers["cache-control"]).toContain("private");
  const invalid = `${ref.slice(0, -1)}${ref.endsWith("a") ? "b" : "a"}`;
  expect((await raw("GET", `/${invalid}`, { Cookie: cookie })).status).toBe(404);
  liveRows = [];
  expect((await raw("GET", `/${ref}`, { Cookie: cookie })).status).toBe(404);
});

it("历史优先返回最近三个完整回合，向前翻页没有遗漏且不扩大项目访问权限", async () => {
  liveRows = Array.from({ length: 10 }, (_, turn) => [
    { rowId: turn * 3 + 1, turnId: `turn-${turn}`, kind: "turnHeader" },
    { rowId: turn * 3 + 2, turnId: `turn-${turn}`, kind: "userInput", text: "question" },
    { rowId: turn * 3 + 3, turnId: `turn-${turn}`, kind: "assistantText", text: "answer" },
  ]).flat() as ConversationRow[];
  const cookie = await login();
  const ref = { agent: "claude", id: "history", projectPath: "/project" };
  const page = async (before?: number, projectPath = ref.projectPath) => {
    const response = await raw("POST", "/api/invoke", { ...HEADERS, Cookie: cookie }, JSON.stringify({ channel: "sessions:page", args: [{ ...ref, projectPath }, before] }));
    return JSON.parse(response.body.toString());
  };
  let current = await page();
  expect(current.ok).toBe(true);
  expect(current.result.rows).toEqual(liveRows.slice(-9));
  service.publish("chat:state", { sessionKey: "session", sessionId: "history", state: "idle", agent: "claude", projectPath: "/project", permissionMode: "default" });
  const snapshot = await raw("POST", "/api/invoke", { ...HEADERS, Cookie: cookie }, JSON.stringify({ channel: "chat:snapshot", args: ["session"] }));
  expect(JSON.parse(snapshot.body.toString()).result.rows).toEqual(current.result.rows);
  expect((await page(-1)).ok).toBe(false);
  const loaded = [...current.result.rows];
  while (current.result.earlierRows) {
    current = await page(current.result.earlierRows.beforeRowId);
    loaded.unshift(...current.result.rows);
  }
  expect(loaded).toEqual(liveRows);
  expect((await page(undefined, "/not-authorized")).ok).toBe(false);
});

it("历史图片的预览独立传输，原图保留；移除项目后旧地址失效", async () => {
  const image = Buffer.from("original-image");
  liveRows = [{ rowId: 1, turnId: "turn", kind: "userInput", text: "image", attachments: [{ fileName: "shot.png", mime: "image/png", bytes: image.length, ref: `data:image/png;base64,${image.toString("base64")}` }] }] as ConversationRow[];
  const cookie = await login();
  const response = await raw("POST", "/api/invoke", { ...HEADERS, Cookie: cookie }, JSON.stringify({ channel: "sessions:page", args: [{ agent: "claude", id: "history", projectPath: "/project" }] }));
  const ref = JSON.parse(response.body.toString()).result.rows[0].attachments[0].ref;
  const thumbnail = await raw("GET", `/${ref}?thumbnail=1`, { Cookie: cookie });
  expect(thumbnail.status).toBe(200);
  expect(thumbnail.body.toString()).toBe("small-preview");
  expect((await raw("GET", `/${ref}`, { Cookie: cookie })).body).toEqual(image);
  projectPaths = [];
  expect((await raw("GET", `/${ref}`, { Cookie: cookie })).status).toBe(404);
});

it("手机只接收所查看会话的内容，仍接收其他会话的状态与审批", async () => {
  const cookie = await login();
  const response = await fetch(`http://127.0.0.1:${port}/api/events?clientId=phone&sessionKey=watched`, { headers: { Cookie: cookie } });
  const reader = response.body!.getReader();
  await reader.read();
  service.publish("chat:rows", { sessionKey: "other", ops: [{ op: "append", rowId: 1, field: "text", text: "unwatched-secret" }] });
  service.publish("chat:state", { sessionKey: "other", state: "running", agent: "claude", projectPath: "/project", permissionMode: "default" });
  service.publish("permission:requested", { sessionKey: "other", interactionId: "approval" } as never);
  service.publish("chat:rows", { sessionKey: "watched", ops: [{ op: "append", rowId: 1, field: "text", text: "watched-message" }] });
  let received = "";
  while (!received.includes("watched-message")) received += new TextDecoder().decode((await reader.read()).value);
  expect(received).not.toContain("unwatched-secret");
  expect(received).toContain("chat:state");
  expect(received).toContain("approval");
  await reader.cancel();
});

it("手动刷新保留已加载范围，运行中工具和完整导出仍包含原始输入", async () => {
  liveRows = [1, 2, 3, 4].map(rowId => ({ kind: "toolCall", rowId, turnId: `turn-${rowId}`, toolCallId: String(rowId), toolName: "Bash", status: rowId === 4 ? "pendingApproval" : "success", inputText: "command", input: { command: "echo command" } } as ConversationRow));
  const cookie = await login();
  const invoke = async (channel: string, args: unknown[]) => JSON.parse((await raw("POST", "/api/invoke", { ...HEADERS, Cookie: cookie }, JSON.stringify({ channel, args }))).body.toString());
  const ref = { agent: "codex", id: "history", projectPath: "/project" };
  const refreshed = await invoke("sessions:refresh", [ref, 2]);
  expect(refreshed.result.rows.map((row: ConversationRow) => row.rowId)).toEqual([2, 3, 4]);
  expect(refreshed.result.earlierRows.beforeRowId).toBe(2);
  expect(refreshed.result.rows[2].input.command).toBe("echo command");
  expect(refreshed.result.rows[2].remoteDetails).toBeUndefined();
  expect((await invoke("sessions:load", [ref])).result.rows).toEqual(liveRows);
  expect((await invoke("sessions:refresh", [ref, -1])).ok).toBe(false);
});
