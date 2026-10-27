// 远程访问口令：经 safeStorage（macOS 钥匙串）加密后单独存放，不进入 settings.json。
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";

export class RemoteTokenStore {
  private readonly path: string;
  private token: string | null = null;

  constructor(dataDir: string) {
    this.path = join(dataDir, "remote-control-token");
  }

  get(): string {
    if (this.token) return this.token;
    try {
      this.token = safeStorage.decryptString(readFileSync(this.path));
    } catch {
      return this.regenerate();
    }
    return this.token;
  }

  regenerate(): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密存储不可用，无法保存远程访问口令");
    const token = randomBytes(24).toString("base64url");
    writeFileSync(this.path, safeStorage.encryptString(token), { mode: 0o600 });
    this.token = token;
    return token;
  }

  matches(candidate: string): boolean {
    const expected = Buffer.from(this.get());
    const actual = Buffer.from(candidate);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
