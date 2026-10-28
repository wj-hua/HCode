import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { branchSwitchPreview, commitAndSwitch, commitGraph, listBranches, switchBranch } from "../../git.js";
import type { GitBranchSwitchPreview } from "../../../shared/types.js";
import { RemoteControlService } from "../remoteControlService.js";
import { RemoteSessionStore } from "../sessionStore.js";
import type { RemoteTokenStore } from "../tokenStore.js";

it("远程 Git 请求需要登录且限制为已添加的项目，并能预览冲突后提交切换", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-remote-git-"));
  const userData = await mkdtemp(join(tmpdir(), "hcode-remote-git-userdata-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const service = new RemoteControlService({
    config: () => ({ enabled: true, localPort: 0, sshHost: "", remoteBind: "" }),
    tokens: { matches: (value: string) => value === "test-login" } as unknown as RemoteTokenStore,
    sessions: new RemoteSessionStore(userData),
    policy: { projectPaths: () => [cwd], attachmentsDir: join(cwd, "attachments"), sessionState: () => undefined },
    invoke: async (channel, args) => {
      const [path, branch, message, preview] = args;
      switch (channel) {
        case "git:branches": return listBranches(path as string, env);
        case "git:graph": return commitGraph(path as string, env);
        case "git:switchBranch": return switchBranch(path as string, env, branch as string);
        case "git:branchSwitchPreview": return branchSwitchPreview(path as string, env);
        case "git:commitAndSwitch": return commitAndSwitch(path as string, env, branch as string, message as string, preview as GitBranchSwitchPreview);
        default: throw new Error("unexpected channel");
      }
    },
    liveRows: () => undefined, hasSession: () => false, staticDir: cwd, env: () => env, onStatus: () => {},
  });
  try {
    git("init", "-q"); git("config", "user.name", "HCode Test"); git("config", "user.email", "test@example.com");
    await writeFile(join(cwd, "file.txt"), "base\n"); git("add", "."); git("commit", "-qm", "initial");
    const original = git("branch", "--show-current");
    git("switch", "-qc", "other"); await writeFile(join(cwd, "file.txt"), "other\n"); git("commit", "-qam", "other");
    git("switch", "-q", original); await writeFile(join(cwd, "file.txt"), "local\n");
    await service.apply();
    const base = `http://127.0.0.1:${service.getStatus().port}`;
    const headers = { "Content-Type": "application/json", "X-HCode-Remote": "1" };
    expect((await fetch(`${base}/api/invoke`, { method: "POST", headers, body: JSON.stringify({ channel: "git:graph", args: [cwd] }) })).status).toBe(401);
    const login = await fetch(`${base}/api/login`, { method: "POST", headers, body: JSON.stringify({ token: "test-login" }) });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const invoke = async (channel: string, args: unknown[]) => (await fetch(`${base}/api/invoke`, {
      method: "POST", headers: { ...headers, Cookie: cookie! }, body: JSON.stringify({ channel, args }),
    })).json() as Promise<{ ok: boolean; result?: any; error?: string }>;
    expect((await invoke("git:branches", [cwd])).result.dirtyFileCount).toBe(1);
    expect((await invoke("git:graph", [cwd])).result.commits.map((commit: { subject: string }) => commit.subject)).toContain("initial");
    expect((await invoke("git:graph", [dirname(cwd)])).error).toContain("远程只能访问已添加的项目");
    expect((await invoke("git:switchBranch", [cwd, "other"])).result).toEqual({ ok: false, reason: "changes-would-be-overwritten" });
    const preview = (await invoke("git:branchSwitchPreview", [cwd])).result;
    expect(preview.files.map((file: { path: string }) => file.path)).toEqual(["file.txt"]);
    expect((await invoke("git:commitAndSwitch", [cwd, "other", "save local changes", preview])).result).toEqual({ switched: true });
    expect(git("branch", "--show-current")).toBe("other");
    expect(git("show", `${original}:file.txt`)).toBe("local");
  } finally { service.dispose(); await rm(cwd, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true }); }
});
