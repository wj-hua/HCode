// 远程登录会话：持久化到 userData，HCode 重启或更新后已登录设备无需重新输入口令。
// 只保存会话标识的 SHA-256 摘要与过期时间，文件泄露也无法还原出可用的 Cookie。
// 重新生成口令、关闭远程操控与登出时由 RemoteControlService 清除。
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REMOTE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FILE_NAME = "remote-control-sessions.json";
const FILE_VERSION = 1;
/** 每次登录新增一条；超出时淘汰最早过期的会话，避免文件无限增长。 */
const MAX_SESSIONS = 50;

interface SessionFile {
  version: number;
  sessions: { digest: string; expiresAt: number }[];
}

export class RemoteSessionStore {
  private readonly path: string;
  /** 摘要 → 过期时间（毫秒）；首次使用时从文件读取。 */
  private sessions: Map<string, number> | null = null;

  constructor(dataDir: string) {
    this.path = join(dataDir, FILE_NAME);
  }

  /** 新建会话并立即落盘，返回只交给客户端 Cookie 的原始标识。 */
  create(now = Date.now()): string {
    const sid = randomBytes(32).toString("base64url");
    const sessions = this.load(now);
    sessions.set(digest(sid), now + REMOTE_SESSION_TTL_MS);
    const overflow = [...sessions].sort((a, b) => a[1] - b[1]).slice(0, Math.max(0, sessions.size - MAX_SESSIONS));
    for (const [key] of overflow) sessions.delete(key);
    this.save();
    return sid;
  }

  isValid(sid: string, now = Date.now()): boolean {
    const expiresAt = this.load(now).get(digest(sid));
    return expiresAt !== undefined && expiresAt > now;
  }

  revoke(sid: string) {
    if (this.load().delete(digest(sid))) this.save();
  }

  clear() {
    if (this.load().size === 0) return;
    this.sessions = new Map();
    this.save();
  }

  /**
   * 读取时丢弃已过期的会话。文件损坏或版本不符时按「没有已登录会话」处理：
   * 只会让设备重新登录，不会放行任何旧 Cookie；下次登录会覆盖坏文件。
   */
  private load(now = Date.now()): Map<string, number> {
    if (this.sessions) return this.sessions;
    this.sessions = new Map();
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.sessions;
      throw error;
    }
    try {
      const file = JSON.parse(raw) as SessionFile;
      if (file.version !== FILE_VERSION || !Array.isArray(file.sessions)) throw new Error(`不支持的版本 ${String(file.version)}`);
      for (const entry of file.sessions) {
        if (typeof entry.digest === "string" && typeof entry.expiresAt === "number" && entry.expiresAt > now) {
          this.sessions.set(entry.digest, entry.expiresAt);
        }
      }
    } catch (error) {
      console.warn(`[remote-control] 登录会话文件无效，已登录设备需要重新登录：${error instanceof Error ? error.message : String(error)}`);
    }
    return this.sessions;
  }

  /** 先写临时文件再改名，避免写到一半退出留下半截文件。 */
  private save() {
    const file: SessionFile = {
      version: FILE_VERSION,
      sessions: [...(this.sessions ?? [])].map(([key, expiresAt]) => ({ digest: key, expiresAt })),
    };
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

function digest(sid: string): string {
  return createHash("sha256").update(sid).digest("hex");
}
