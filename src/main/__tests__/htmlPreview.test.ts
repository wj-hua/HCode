// 从实际请求边界检查 HTML、相对资源及文件访问隔离。
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HtmlPreviewService } from "../htmlPreview.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hcode-html-preview-"));
  directories.push(root);
  const project = join(root, "project");
  await mkdir(join(project, "design"), { recursive: true });
  await writeFile(join(project, "design", "页面.html"), '<!doctype html><button onclick="this.textContent=\'已点击\'">测试</button><script src="../app.js"></script>');
  await writeFile(join(project, "app.js"), 'document.body.dataset.loaded = "true";');
  await writeFile(join(project, ".env"), "PRIVATE_VALUE=secret");
  await writeFile(join(root, "outside.js"), "secret");
  await symlink(join(root, "outside.js"), join(project, "escape.js"));
  return { root, project, path: join(project, "design", "页面.html"), service: new HtmlPreviewService() };
}

describe("隔离 HTML 预览", () => {
  it("提供真实页面及相对脚本，并使用独立 CSP 和不可访问宿主的沙箱", async () => {
    const data = await fixture();
    const lease = await data.service.create(data.path, data.project);
    const page = await data.service.respond(new Request(lease.url));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('onclick="this.textContent=');
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    const resource = await data.service.respond(new Request(new URL("../app.js", lease.url)));
    expect(resource.status).toBe(200);
    expect(await resource.text()).toContain("dataset.loaded");
  });

  it("拒绝目录穿越、项目外符号链接、私有配置及非读取请求", async () => {
    const data = await fixture();
    const lease = await data.service.create(data.path, data.project);
    const url = new URL(lease.url);
    const origin = `${url.protocol}//${url.host}`;
    for (const target of ["/%2e%2e%2foutside.js", "/escape.js", "/.env"]) {
      const response = await data.service.respond(new Request(`${origin}${target}`));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain("secret");
    }
    expect((await data.service.respond(new Request(lease.url, { method: "POST" }))).status).toBe(405);
  });

  it("刷新或关闭后撤销旧地址，拒绝非 HTML 和超限文件", async () => {
    const data = await fixture();
    const lease = await data.service.create(data.path, data.project);
    data.service.release(lease.id);
    expect((await data.service.respond(new Request(lease.url))).status).toBe(404);
    await expect(data.service.create(join(data.project, "app.js"), data.project)).rejects.toThrow();
    await writeFile(data.path, "x".repeat(256 * 1024 + 1));
    await expect(data.service.create(data.path, data.project)).rejects.toThrow();
  });
});
