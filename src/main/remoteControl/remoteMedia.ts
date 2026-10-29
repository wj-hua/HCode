// 远程附件传输：会话只带签名地址，读取图片时重新核对来源和内容，不复制或持久化原图。
import { createHash } from "node:crypto";
import type { ConversationRow } from "../../shared/types.js";
import { REMOTE_MEDIA_PATH, type RemoteRowSource } from "../../shared/remoteControl.js";
import { RemoteReferenceNotFound, SignedReference } from "./signedReference.js";
import { mapMarkdownImages, readMarkdownImage } from "./markdownImages.js";

export type RemoteMediaSource = RemoteRowSource;
export interface RemoteImage { body: Buffer; type: string; cacheControl?: string }
type ImageReference = { source: RemoteMediaSource; rowId: number } & ({ index: number; digest: string } | { markdown: string });
const INLINE_IMAGE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/;
const IMAGE_CACHE = "private, max-age=31536000, immutable";

export class RemoteMediaNotFound extends RemoteReferenceNotFound {
  constructor() { super("图片不存在或来源已变化，请重新加载会话"); }
}

export class RemoteMedia {
  private readonly references = new SignedReference();

  constructor(private readonly readRows: (source: RemoteMediaSource) => Promise<readonly ConversationRow[]>) {}

  /** 只改远程响应的附件地址，主进程和桌面窗口继续使用原始图片。 */
  mapRows(rows: readonly ConversationRow[], source: RemoteMediaSource): ConversationRow[] {
    return rows.map(row => this.mapRow(row, source));
  }

  mapRow(row: ConversationRow, source: RemoteMediaSource): ConversationRow {
    if (row.kind === "assistantText") return { ...row, text: mapMarkdownImages(row.text, markdown => `${REMOTE_MEDIA_PATH}${this.references.encode<ImageReference>({ source, rowId: row.rowId, markdown })}`) };
    if (row.kind !== "userInput" || !row.attachments) return row;
    return { ...row, attachments: row.attachments.map((attachment, index) => {
      if (!INLINE_IMAGE.test(attachment.ref)) return attachment;
      return { ...attachment, ref: `${REMOTE_MEDIA_PATH}${this.references.encode<ImageReference>({ source, rowId: row.rowId, index, digest: digest(attachment.ref) })}` };
    }) };
  }

  /** 签名仅定位图片，不能代替 HTTP 登录；摘要防止旧地址命中新历史中的另一张附件。 */
  async read(token: string): Promise<RemoteImage> {
    const reference = this.references.decode<ImageReference>(token);
    const rows = await this.readRows(reference.source);
    const row = rows.find(candidate => candidate.rowId === reference.rowId);
    if ("markdown" in reference) {
      if (row?.kind !== "assistantText") throw new RemoteMediaNotFound();
      let referenced = false;
      mapMarkdownImages(row.text, path => { if (path === reference.markdown) referenced = true; return path; });
      if (!referenced) throw new RemoteMediaNotFound();
      return readMarkdownImage(reference.markdown, "ref" in reference.source ? reference.source.ref.projectPath : reference.source.projectPath);
    }
    const ref = row?.kind === "userInput" ? row.attachments?.[reference.index]?.ref : undefined;
    if (!ref || digest(ref) !== reference.digest) throw new RemoteMediaNotFound();
    const match = INLINE_IMAGE.exec(ref);
    if (!match) throw new RemoteMediaNotFound();
    return { body: Buffer.from(match[2]!, "base64"), type: match[1]! };
  }

}

export const REMOTE_IMAGE_HEADERS = { "Cache-Control": IMAGE_CACHE, "Content-Security-Policy": "default-src 'none'; sandbox" };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
