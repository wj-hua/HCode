import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ChatStateEvent, RemoteControlSettings } from "../../../shared/types.js";
import { RemoteControlService } from "../remoteControlService.js";
import { RemoteSessionStore } from "../sessionStore.js";
import type { RemoteTokenStore } from "../tokenStore.js";

const FEED_TOKEN = "feed-token-for-tests";
let dataDir: string;
let config: RemoteControlSettings;
let feedToken: string;
let service: RemoteControlService;
let base: string;

const tokens = (value: () => string, regenerated: () => string) => ({
  matches: (candidate: string) => candidate === value(),
  regenerate: regenerated,
}) as unknown as RemoteTokenStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "hcode-feed-"));
  config = { enabled: true, localPort: 0, sshHost: "", remoteBind: "", notificationFeed: true };
  feedToken = FEED_TOKEN;
  service = new RemoteControlService({
    config: () => config,
    tokens: tokens(() => "login", () => "login2"),
    notificationTokens: tokens(() => feedToken, () => (feedToken = "rotated-feed-token")),
    sessions: new RemoteSessionStore(dataDir),
    policy: { projectPaths: () => [], attachmentsDir: join(dataDir, "attachments"), sessionState: () => undefined },
    invoke: async () => null,
    sessionTitle: async () => "通知链路联调",
    liveRows: () => undefined, hasSession: () => false, staticDir: dataDir, env: () => ({}), onStatus: () => {},
  });
  await service.apply();
  base = `http://127.0.0.1:${service.getStatus().port}`;
});

afterEach(async () => {
  service.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

const state = (sessionKey: string, value: ChatStateEvent["state"]): ChatStateEvent => ({
  sessionKey, agent: "codex", projectPath: "/p/GTools", state: value, permissionMode: "default",
});

function finishTurn(sessionKey: string) {
  service.publish("chat:state", state(sessionKey, "running"));
  service.publish("chat:state", state(sessionKey, "idle"));
}

/** 打开事件流并收集文本，直到出现 expected 次 event: notification 或连接关闭。 */
function open(headers: Record<string, string>, expected = 0): Promise<{ status: number; body: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/notifications/stream`, { headers }, (res) => {
      let body = "";
      const done = () => resolve({ status: res.statusCode ?? 0, body, close: () => req.destroy() });
      if (res.statusCode !== 200) { res.resume(); res.on("end", done); return; }
      if (expected === 0) return done();
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        if (body.split("event: notification").length - 1 >= expected) done();
      });
      res.on("end", done);
    });
    req.on("error", reject);
    req.end();
  });
}

const auth = (token = FEED_TOKEN) => ({ Authorization: `Bearer ${token}` });
const ids = (body: string) => [...body.matchAll(/^id: (.+)$/gm)].map((match) => match[1]);

it("订阅令牌正确时推送实时事件，内容只有摘要", async () => {
  const pending = open(auth(), 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(service.getStatus().notificationSubscribers).toBe(1);
  finishTurn("s1");
  const { body, close } = await pending;
  close();
  const data = JSON.parse(body.split("data: ").at(-1)!.split("\n")[0]!);
  expect(data).toMatchObject({ type: "done", sessionKey: "s1", agent: "codex", project: "GTools", title: "通知链路联调" });
});

it("断线重连带 Last-Event-ID 时补发错过的事件", async () => {
  const first = open(auth(), 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  finishTurn("s1");
  const seen = await first;
  seen.close();
  finishTurn("s2");
  finishTurn("s3");
  const replay = await open({ ...auth(), "Last-Event-ID": ids(seen.body)[0]! }, 2);
  replay.close();
  expect(replay.body).toContain('"sessionKey":"s2"');
  expect(replay.body).toContain('"sessionKey":"s3"');
  expect(replay.body).not.toContain('"sessionKey":"s1"');
});

it("令牌错误返回 401；登录 Cookie 不能代替订阅令牌", async () => {
  expect((await open(auth("wrong"))).status).toBe(401);
  expect((await open({})).status).toBe(401);
  expect((await open(auth("login"))).status).toBe(401);
});

it("经反向代理转发的请求一律拒绝，事件流只接受隧道直连", async () => {
  expect((await open({ ...auth(), "X-Forwarded-For": "203.0.113.9" })).status).toBe(404);
  expect((await open({ ...auth(), "X-Forwarded-Proto": "https" })).status).toBe(404);
});

it("关闭通知订阅后返回 404 并断开已有订阅", async () => {
  const live = open(auth(), 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  config = { ...config, notificationFeed: false };
  await service.apply();
  const ended = await live;
  expect(ended.body).not.toContain("event: notification");
  expect(service.getStatus().notificationSubscribers).toBe(0);
  expect((await open(auth())).status).toBe(404);
});

it("重新生成订阅令牌后旧令牌失效并断开已有订阅", async () => {
  const live = open(auth(), 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(service.regenerateNotificationToken()).toBe("rotated-feed-token");
  await live;
  expect(service.getStatus().notificationSubscribers).toBe(0);
  expect((await open(auth())).status).toBe(401);
});
