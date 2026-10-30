// 微信 iLink Bot 协议（移植自 ZCode providers/weixinProvider.ts 与 weixinRegistration.ts）：
// 扫码登录拿 bot_token；/getupdates 长轮询收消息；/sendmessage 发文本。回复必须带对方最近一条消息的 context_token。
import { randomInt, randomUUID } from "node:crypto";

const BASE_URL = "https://ilinkai.weixin.qq.com/ilink/bot";
const CHANNEL_VERSION = "2.0.0";
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const REQUEST_TIMEOUT_MS = 15_000;
/** 扫码状态接口会挂起等待手机确认，超时只表示还没扫。 */
const LOGIN_POLL_TIMEOUT_MS = 30_000;
/** 长轮询空闲窗口；服务端通常更早返回。 */
const GET_UPDATES_TIMEOUT_MS = 90_000;
const LOGIN_EXPIRE_SECONDS = 120;

export interface WeixinLoginQr {
  qrCode: string;
  /** 用微信扫描的内容（需要渲染成二维码）。 */
  qrUrl: string;
  expiresAt: number;
}

export type WeixinLoginResult =
  | { status: "pending" | "scanned" | "expired" }
  | { status: "success"; botToken: string; botId: string }
  | { status: "error"; message: string };

export interface WeixinInbound {
  fromUserId: string;
  contextToken?: string;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null;
const readString = (record: Json, key: string) => (typeof record[key] === "string" ? (record[key] as string) : "");
const readNumber = (record: Json, key: string) => (typeof record[key] === "number" ? (record[key] as number) : null);

/** 有的响应把字段包在 data 里。 */
function unwrap(payload: unknown): Json {
  if (!isRecord(payload)) return {};
  return isRecord(payload.data) ? { ...payload, ...payload.data } : payload;
}

function assertOk(path: string, payload: Json) {
  const ret = readNumber(payload, "ret");
  const errcode = readNumber(payload, "errcode");
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    throw new Error(`微信 ${path} 失败：${readString(payload, "errmsg") || `ret=${ret ?? ""} errcode=${errcode ?? ""}`}`);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

async function loginGet(path: string, timeoutMs: number): Promise<Json> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "iLink-App-ClientVersion": "1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`微信登录 ${path} 失败：HTTP ${response.status}`);
  const payload = unwrap(await response.json());
  assertOk(path, payload);
  return payload;
}

async function botPost(token: string, path: string, body: Json, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Json> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${token}`,
      "X-WECHAT-UIN": Buffer.from(String(randomInt(0, 0x1_0000_0000))).toString("base64"),
    },
    body: JSON.stringify({ base_info: { channel_version: CHANNEL_VERSION }, ...body }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`微信 ${path} 失败：HTTP ${response.status}`);
  const payload = unwrap(await response.json());
  assertOk(path, payload);
  return payload;
}

export async function beginWeixinLogin(): Promise<WeixinLoginQr> {
  const payload = await loginGet("/get_bot_qrcode?bot_type=3", REQUEST_TIMEOUT_MS);
  const qrCode = readString(payload, "qrcode") || readString(payload, "qr_code");
  const qrUrl = readString(payload, "qrcode_img_content") || readString(payload, "qrcode_url") || qrCode;
  if (!qrCode || !qrUrl) throw new Error("微信登录没有返回二维码");
  const expiresIn = readNumber(payload, "expires_in") ?? LOGIN_EXPIRE_SECONDS;
  return { qrCode, qrUrl, expiresAt: Date.now() + expiresIn * 1000 };
}

function loginStatus(value: unknown): "pending" | "scanned" | "success" | "expired" | "error" {
  if (typeof value === "number") {
    return value === 1 ? "scanned" : value === 2 ? "success" : value === 3 || value === 4 ? "expired" : "pending";
  }
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (["confirmed", "confirm", "authorized", "success", "ok"].includes(status)) return "success";
  if (["scaned", "scanned", "scan", "confirmed_wait"].includes(status)) return "scanned";
  if (["expired", "timeout", "cancel", "cancelled", "canceled"].includes(status)) return "expired";
  if (["error", "failed", "fail"].includes(status)) return "error";
  return "pending";
}

export async function pollWeixinLogin(qrCode: string): Promise<WeixinLoginResult> {
  let payload: Json;
  try {
    payload = await loginGet(`/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`, LOGIN_POLL_TIMEOUT_MS);
  } catch (error) {
    if (isTimeout(error)) return { status: "pending" };
    throw error;
  }
  const status = loginStatus(payload.status ?? payload.qrcode_status ?? payload.qr_status);
  if (status === "success") {
    const botToken = readString(payload, "bot_token") || readString(payload, "token");
    if (!botToken) return { status: "error", message: "微信登录成功但没有返回 bot_token" };
    return { status, botToken, botId: readString(payload, "ilink_bot_id") || readString(payload, "bot_id") };
  }
  if (status === "error") return { status, message: readString(payload, "errmsg") || "微信登录失败" };
  return { status };
}

/** 长轮询一次；空闲超时视为没有新消息。只取通知需要的发送人与 context_token，忽略机器人自己发出的消息。 */
export async function getWeixinUpdates(token: string, buf: string, signal: AbortSignal): Promise<{ messages: WeixinInbound[]; buf: string }> {
  let payload: Json;
  try {
    payload = await botPost(token, "/getupdates", { get_updates_buf: buf }, signal, GET_UPDATES_TIMEOUT_MS);
  } catch (error) {
    if (isTimeout(error) && !signal.aborted) return { messages: [], buf };
    throw error;
  }
  const raw = Array.isArray(payload.msgs) ? payload.msgs : Array.isArray(payload.messages) ? payload.messages : [];
  const messages = raw.filter(isRecord).flatMap((message): WeixinInbound[] => {
    if (readNumber(message, "message_type") === MESSAGE_TYPE_BOT) return [];
    const fromUserId = readString(message, "from_user_id").trim();
    if (!fromUserId) return [];
    const contextToken = readString(message, "context_token");
    return [{ fromUserId, ...(contextToken ? { contextToken } : {}) }];
  });
  return { messages, buf: readString(payload, "get_updates_buf") || buf };
}

export async function sendWeixinText(token: string, botId: string, toUserId: string, contextToken: string | undefined, text: string): Promise<void> {
  await botPost(token, "/sendmessage", {
    msg: {
      from_user_id: botId,
      to_user_id: toUserId,
      client_id: `hcode-weixin-${randomUUID()}`,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      ...(contextToken ? { context_token: contextToken } : {}),
      // 部分微信客户端不认 LF，统一成 CRLF 保证多行不被折叠。
      item_list: [{ type: 1, text_item: { text: text.replace(/\r\n|\r|\n/g, "\r\n") } }],
    },
  });
}
