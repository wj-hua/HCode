// 从实际消息渲染入口验证路径可点击，避免只测试正则而遗漏 Markdown 安全处理。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const workspacePath = "/Users/test/GTools";

function renderMessage(text: string, projectPath: string | null = workspacePath, streaming = false) {
  return renderToStaticMarkup(createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children:
    createElement(TooltipProvider, { children: createElement(MessageResponse, {
      workspacePath: projectPath ?? undefined,
      streaming,
      onOpenFileLink() {},
      children: text,
    }) }),
  }));
}

describe("消息中的普通文件路径", () => {
  it("将截图中的中文 Markdown 和 HTML 相对路径渲染为文件按钮", () => {
    const paths = ["docs/01-需求与整合方案.md", "docs/02-设计规范.md", "design/prototype.html"];
    const html = renderMessage(paths.map(path => `- ${path}`).join("\n"));
    for (const path of paths) expect(html).toContain(`title="${workspacePath}/${path}"`);
    expect(html.match(/<button\b/g)).toHaveLength(paths.length);
  });

  it("识别行内代码、独立文件名、绝对路径和行号，保留完整路径文字", () => {
    const html = renderMessage("查看 `src/main.ts:12:3`、README.md 和 /Users/test/report.md。");
    for (const path of ["src/main.ts", "README.md", "/Users/test/report.md"]) {
      const absolute = path.startsWith("/") ? path : `${workspacePath}/${path}`;
      expect(html).toContain(`title="${absolute}"`);
    }
    expect(html).toContain("src/main.ts:12:3");
  });

  it("保留已有链接且不重复转换链接标签", () => {
    const html = renderMessage("[docs/guide.md](./docs/guide.md)");
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toContain(`title="${workspacePath}/docs/guide.md"`);
  });

  it("不将网址、邮箱、版本、目录、命令和代码块中的示例变成文件按钮", () => {
    const html = renderMessage([
      "https://example.com/docs/guide.md www.example.com test@example.md v1.2.3 docs/",
      "`pnpm run docs/guide.md`",
      "```text\ndocs/guide.md\n```",
    ].join("\n\n"));
    expect(html).not.toContain(`title="${workspacePath}/`);
  });

  it("拒绝逃逸项目根目录和危险协议", () => {
    const html = renderMessage("../secret.md docs/../../secret.md javascript:docs/guide.md");
    expect(html).not.toContain("<button");
  });

  it("保留中文标点和带空格的完整行内路径", () => {
    const html = renderMessage("（docs/guide.md），`docs/My Guide.md`；**design/prototype.html**。");
    for (const path of ["docs/guide.md", "docs/My Guide.md", "design/prototype.html"]) {
      expect(html).toContain(`title="${workspacePath}/${path}"`);
    }
    expect(html).toContain("（");
    expect(html).toContain("），");
    expect(html).toContain("；");
    expect(html.match(/<button\b/g)).toHaveLength(3);
  });

  it("在当前会话目录解析相对路径，没有项目上下文时保持普通文本", () => {
    expect(renderMessage("docs/guide.md", "/Users/test/Other")).toContain('title="/Users/test/Other/docs/guide.md"');
    expect(renderMessage("docs/guide.md", null)).not.toContain("<button");
  });

  it("流式和完成态均显示可点击路径", () => {
    for (const streaming of [true, false]) {
      const html = renderMessage("- docs/01-需求与整合方案.md\n- design/prototype.html", workspacePath, streaming);
      expect(html.match(/<button\b/g)).toHaveLength(2);
    }
  });
});
