// 远程按需资源的实例内签名：引用不能跨重启伪造，也不能替代 HTTP 登录鉴权。
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
const MAX_REFERENCE_LENGTH = 8192;

export class RemoteReferenceNotFound extends Error {
  readonly status = 404;
  constructor(message = "内容不存在或已变化，请刷新会话后重试") { super(message); }
}

export class SignedReference {
  private readonly secret = randomBytes(32);
  encode<T>(value: T): string {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }
  decode<T>(reference: string): T {
    if (typeof reference !== "string" || reference.length > MAX_REFERENCE_LENGTH) throw new RemoteReferenceNotFound();
    const [payload, signature, extra] = reference.split(".");
    if (!payload || !signature || extra !== undefined) throw new RemoteReferenceNotFound();
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new RemoteReferenceNotFound();
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as T;
  }
  private sign(payload: string): string { return createHmac("sha256", this.secret).update(payload).digest("base64url"); }
}
