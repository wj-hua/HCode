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

describe("远程插话", () => {
  it("只允许插话到存在的会话，附件必须先上传", () => {
    expect(checkRemoteInvoke(context, "chat:steer", [{ sessionKey: "session", text: "改一下" }])).toBe(true);
    expect(checkRemoteInvoke(context, "chat:steer", [{ sessionKey: "session", text: "看图", files: [{ path: "/attachments/a.png", name: "a.png", mimeType: "image/png", size: 1 }] }])).toBe(true);
    expect(() => checkRemoteInvoke(context, "chat:steer", [{ sessionKey: "missing", text: "改一下" }])).toThrow("会话不存在或已关闭");
    expect(() => checkRemoteInvoke(context, "chat:steer", [{ sessionKey: "session", text: "读", files: [{ path: "/etc/passwd", name: "passwd", mimeType: "text/plain", size: 1 }] }])).toThrow("远程附件需要先上传");
  });
});

describe("远程项目和分支", () => {
  it("允许管理已添加项目的分支，拒绝其他路径", () => {
    for (const channel of ["git:branches", "git:graph", "git:switchBranch", "git:createBranch", "git:branchSwitchPreview", "git:commitAndSwitch"]) {
      expect(checkRemoteInvoke(context, channel, ["/project", "feature"])).toBe(true);
      expect(() => checkRemoteInvoke(context, channel, ["/other", "feature"])).toThrow("远程只能访问已添加的项目");
    }
    expect(checkRemoteInvoke(context, "projects:addPath", ["/project", false])).toBe(true);
    expect(checkRemoteInvoke(context, "projects:browseDirectories", [null, false])).toBe(true);
    expect(checkRemoteInvoke(context, "projects:add", [])).toBe(false);
    expect(checkRemoteInvoke(context, "fs:readText", ["/other/secret"])).toBe(false);
  });
});
