// 从远程资源边界核对关联工作树，只能预览会话点名的页面和其中引用的资源。
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RemoteHtmlPreview, HTML_RESOURCE_PATH } from "../remoteHtmlPreview.js";
import { readMarkdownImage } from "../markdownImages.js";

it("允许实际 Git 工作树中的会话产物，拒绝其他仓库、未引用页面和链接逃逸", async () => {
  // 不放在系统临时目录内，避免临时产物授权掩盖跨工作树错误。
  const root = await mkdtemp(join(process.cwd(), ".preview-worktrees-"));
  const project = join(root, "project");
  const linked = join(root, "linked");
  const other = join(root, "other");
  try {
    await mkdir(project);
    await mkdir(other);
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    execFileSync("git", ["-C", project, "worktree", "add", "-q", "--orphan", "-b", "design", linked]);
    const entry = join(linked, "index.html");
    const picture = join(linked, "preview.png");
    await writeFile(entry, '<img src="preview.png">');
    await writeFile(picture, "published");
    await writeFile(join(linked, "private.js"), "unpublished");
    await writeFile(join(other, "preview.png"), "outside");
    await symlink(join(other, "preview.png"), join(linked, "escaped.png"));
    expect((await readMarkdownImage(picture, project)).body.toString()).toBe("published");
    await expect(readMarkdownImage(join(linked, "escaped.png"), project)).rejects.toThrow();
    await expect(readMarkdownImage(join(other, "preview.png"), project)).rejects.toThrow();
    const proof = { source: { ref: { agent: "codex", id: "native", projectPath: project } }, rowId: 1 };
    const service = new RemoteHtmlPreview(() => [project], async (_source, row, path) => row === 1 && path === entry);
    await expect(service.create([entry, project], "owner")).rejects.toThrow();
    await expect(service.create([entry, project, { ...proof, rowId: 2 }], "owner")).rejects.toThrow();
    const lease = await service.create([entry, project, proof], "owner");
    const page = lease.url.slice(HTML_RESOURCE_PATH.length);
    expect((await service.read(page, "GET", "owner", false)).status).toBe(200);
    const asset = page.replace("index.html", "preview.png");
    expect(service.assetSession(asset)).toBe("owner");
    expect((await service.read(asset, "GET", "owner", true)).status).toBe(200);
    expect((await service.read(page.replace("index.html", "private.js"), "GET", "owner", false)).status).toBe(403);
    service.release(lease.id, "owner");
    expect(service.assetSession(asset)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
