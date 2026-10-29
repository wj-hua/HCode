// 图片链接转换保持代码原文，只替换实际正文中支持的本机图片。
import { expect, it } from "vitest";
import { mapMarkdownImages } from "../markdownImages.js";
it("正文图片可映射，代码围栏、行内代码和公网图片保持原文", () => {
  const text = '![proof](/tmp/proof.png) `![code](/tmp/code.png)` ![web](https://example.com/image.png)\n```md\n![fenced](/tmp/fenced.png)\n```';
  expect(mapMarkdownImages(text, () => "api/media/signed")).toBe('![proof](api/media/signed) `![code](/tmp/code.png)` ![web](https://example.com/image.png)\n```md\n![fenced](/tmp/fenced.png)\n```');
});
