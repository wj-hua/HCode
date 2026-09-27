import { expect, it } from "vitest";
import { parseMentionMarkdown } from "../mentionMarkdown.js";

it("把项目文件路径显示为文件引用，同时保留普通 @提及", () => {
  expect(parseMentionMarkdown('看 @src/Composer.tsx、@"src/My Composer.tsx" 和 @helper')).toEqual([
    { type: "text", text: "看 " },
    { type: "file", label: "src/Composer.tsx" },
    { type: "text", text: "、" },
    { type: "file", label: "src/My Composer.tsx" },
    { type: "text", text: " 和 " },
    { type: "subagent", label: "helper" },
  ]);
});
