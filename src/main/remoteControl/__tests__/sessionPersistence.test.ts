import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RemoteControlSettings } from "../../../shared/types.js";
import { RemoteControlService } from "../remoteControlService.js";
import { RemoteSessionStore } from "../sessionStore.js";
import type { RemoteTokenStore } from "../tokenStore.js";

const PASSWORD = "test-login";
const HEADERS = { "Content-Type": "application/json", "X-HCode-Remote": "1" };

let dataDir: string;
let config: RemoteControlSettings;
const services: RemoteControlService[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "hcode-remote-session-"));
  config = { enabled: true, localPort: 0, sshHost: "", remoteBind: "", notificationFeed: false };
});

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

/** 每次调用相当于一次 HCode 启动：新的服务实例与会话存储，共用同一个 userData 目录。 */
async function launch() {
  const tokens = {
    matches: (value: string) => value === PASSWORD,
    regenerate: () => "regenerated",
  } as unknown as RemoteTokenStore;
  const service = new RemoteControlService({
    config: () => config,
    tokens,
    notificationTokens: { matches: () => false } as unknown as RemoteTokenStore,
    sessions: new RemoteSessionStore(dataDir),
    policy: { projectPaths: () => [], attachmentsDir: join(dataDir, "attachments"), sessionState: () => undefined },
    invoke: async () => ({ theme: "dark" }),
    liveRows: () => undefined, hasSession: () => false, staticDir: dataDir, env: () => ({}), onStatus: () => {},
  });
  services.push(service);
  await service.apply();
  return { service, base: `http://127.0.0.1:${service.getStatus().port}` };
}

async function login(base: string): Promise<string> {
  const response = await fetch(`${base}/api/login`, { method: "POST", headers: HEADERS, body: JSON.stringify({ token: PASSWORD }) });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

async function invokeStatus(base: string, cookie: string): Promise<number> {
  const response = await fetch(`${base}/api/invoke`, {
    method: "POST", headers: { ...HEADERS, Cookie: cookie }, body: JSON.stringify({ channel: "settings:get", args: [] }),
  });
  return response.status;
}

it("HCode 重启后，已登录设备无需重新输入口令", async () => {
  const first = await launch();
  const cookie = await login(first.base);
  first.service.dispose();

  const second = await launch();
  expect(await invokeStatus(second.base, cookie)).toBe(200);
});

it("会话文件只保存摘要，拿到文件也无法还原 Cookie", async () => {
  const { base } = await launch();
  const cookie = await login(base);
  const sid = cookie.split("=")[1];
  const files = await readdir(dataDir);
  const contents = await Promise.all(files.filter((name) => name.endsWith(".json")).map((name) => readFile(join(dataDir, name), "utf8")));
  expect(contents.length).toBeGreaterThan(0);
  expect(contents.join("")).not.toContain(sid);
});

it("重新生成口令后，重启前登录的设备也失效", async () => {
  const first = await launch();
  const cookie = await login(first.base);
  first.service.regenerateToken();
  first.service.dispose();

  const second = await launch();
  expect(await invokeStatus(second.base, cookie)).toBe(401);
});

it("关闭远程操控会清除已登录会话", async () => {
  const first = await launch();
  const cookie = await login(first.base);
  config = { ...config, enabled: false };
  await first.service.apply();
  config = { ...config, enabled: true };

  const second = await launch();
  expect(await invokeStatus(second.base, cookie)).toBe(401);
});

it("登出只让当前设备失效，重启后依然失效", async () => {
  const first = await launch();
  const loggedOut = await login(first.base);
  const other = await login(first.base);
  await fetch(`${first.base}/api/logout`, { method: "POST", headers: { ...HEADERS, Cookie: loggedOut } });
  first.service.dispose();

  const second = await launch();
  expect(await invokeStatus(second.base, loggedOut)).toBe(401);
  expect(await invokeStatus(second.base, other)).toBe(200);
});

it("过期会话不再放行", async () => {
  const store = new RemoteSessionStore(dataDir);
  const issuedAt = Date.now();
  const sid = store.create(issuedAt);
  expect(new RemoteSessionStore(dataDir).isValid(sid, issuedAt + 1000)).toBe(true);
  expect(new RemoteSessionStore(dataDir).isValid(sid, issuedAt + 8 * 24 * 60 * 60 * 1000)).toBe(false);
});

it("会话文件损坏时不放行任何旧 Cookie，并能重新登录", async () => {
  const first = await launch();
  const cookie = await login(first.base);
  first.service.dispose();
  const [file] = (await readdir(dataDir)).filter((name) => name.endsWith(".json")) as [string];
  await writeFile(join(dataDir, file), "{broken");

  const second = await launch();
  expect(await invokeStatus(second.base, cookie)).toBe(401);
  expect(await invokeStatus(second.base, await login(second.base))).toBe(200);
});
