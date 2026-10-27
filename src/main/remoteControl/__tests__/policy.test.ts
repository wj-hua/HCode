import { describe, expect, it } from "vitest";
import { checkRemoteInvoke, type RemotePolicyContext } from "../policy.js";

const context: RemotePolicyContext = {
  projectPaths: () => ["/project"],
  attachmentsDir: "/attachments",
  sessionState: (key) => key === "session" ? { agent: "codex", permissionMode: "full-access" } : undefined,
};

describe("远程权限模式", () => {
  it("允许选择完全放行，也允许从完全放行切回其他模式", () => {
    expect(checkRemoteInvoke(context, "chat:setPermissionMode", ["session", "full-access"])).toBe(true);
    expect(checkRemoteInvoke(context, "chat:setPermissionMode", ["session", "read-only"])).toBe(true);
    expect(checkRemoteInvoke(context, "chat:send", [{ projectPath: "/project", sessionKey: "session", agent: "codex", permissionMode: "full-access" }])).toBe(true);
  });

  it("仍拒绝无效模式和未授权项目", () => {
    expect(() => checkRemoteInvoke(context, "chat:setPermissionMode", ["session", "bypassPermissions"])).toThrow("无效的权限模式");
    expect(() => checkRemoteInvoke(context, "chat:send", [{ projectPath: "/other", sessionKey: "session", agent: "codex", permissionMode: "full-access" }])).toThrow("远程只能访问已添加的项目");
  });
});
