import { request } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

beforeEach(async () => {
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
    policy: { projectPaths: () => [], attachmentsDir: join(staticDir, "attachments"), sessionState: () => undefined },
    invoke: async () => ({}),
    liveRows: (sessionKey) => sessionKey === "session" ? ROWS : undefined,
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
