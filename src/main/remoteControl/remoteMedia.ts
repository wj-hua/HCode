// 远程附件传输：会话只带签名地址，读取图片时重新核对来源和内容，不复制或持久化原图。
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConversationRow, SessionRef } from "../../shared/types.js";
import { REMOTE_MEDIA_PATH } from "../../shared/remoteControl.js";

export type RemoteMediaSource = { sessionKey: string } | { ref: SessionRef };
export interface RemoteImage { body: Buffer; type: string }
interface ImageReference { source: RemoteMediaSource; rowId: number; index: number; digest: string }
const INLINE_IMAGE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/;
const TOKEN_MAX_LENGTH = 8192;
const IMAGE_CACHE = "private, max-age=31536000, immutable";

export class RemoteMediaNotFound extends Error {
  readonly status = 404;
  constructor() { super("图片不存在或来源已变化，请重新加载会话"); }
}

export class RemoteMedia {
  private readonly secret = randomBytes(32);

  constructor(private readonly readRows: (source: RemoteMediaSource) => Promise<readonly ConversationRow[]>) {}

  /** 只改远程响应的附件地址，主进程和桌面窗口继续使用原始图片。 */
  mapRows(rows: readonly ConversationRow[], source: RemoteMediaSource): ConversationRow[] {
    return rows.map(row => this.mapRow(row, source));
  }

  mapRow(row: ConversationRow, source: RemoteMediaSource): ConversationRow {
    if (row.kind !== "userInput" || !row.attachments) return row;
    return { ...row, attachments: row.attachments.map((attachment, index) => {
      if (!INLINE_IMAGE.test(attachment.ref)) return attachment;
      const payload = Buffer.from(JSON.stringify({ source, rowId: row.rowId, index, digest: digest(attachment.ref) } satisfies ImageReference)).toString("base64url");
      const signature = this.sign(payload);
      return { ...attachment, ref: `${REMOTE_MEDIA_PATH}${payload}.${signature}` };
    }) };
  }

  /** 签名仅定位图片，不能代替 HTTP 登录；摘要防止旧地址命中新历史中的另一张附件。 */
  async read(token: string): Promise<RemoteImage> {
    const reference = this.decode(token);
    const rows = await this.readRows(reference.source);
    const row = rows.find(candidate => candidate.rowId === reference.rowId);
    const ref = row?.kind === "userInput" ? row.attachments?.[reference.index]?.ref : undefined;
    if (!ref || digest(ref) !== reference.digest) throw new RemoteMediaNotFound();
    const match = INLINE_IMAGE.exec(ref);
    if (!match) throw new RemoteMediaNotFound();
    return { body: Buffer.from(match[2]!, "base64"), type: match[1]! };
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private decode(token: string): ImageReference {
    if (token.length > TOKEN_MAX_LENGTH) throw new RemoteMediaNotFound();
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) throw new RemoteMediaNotFound();
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new RemoteMediaNotFound();
    // 只有本实例签发且未被修改的 JSON 才能抵达这里，无外部任意路径读取入口。
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as ImageReference;
  }
}

export const REMOTE_IMAGE_HEADERS = { "Cache-Control": IMAGE_CACHE, "Content-Security-Policy": "default-src 'none'; sandbox" };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
