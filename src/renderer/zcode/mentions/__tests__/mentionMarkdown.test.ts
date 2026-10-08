import { expect, it } from "vitest";
import { buildFileMentionMarkdown, parseMentionMarkdown } from "../mentionMarkdown.js";

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

it("文件引用保留真实链接目标，显示名不会代替文件路径", () => {
  const mention = buildFileMentionMarkdown("src/My App.tsx", "入口文件");
  expect(parseMentionMarkdown(mention)).toEqual([{ type: "file", label: "入口文件", path: "./src/My App.tsx" }]);
  expect(parseMentionMarkdown("[源码](/Users/mino/app.ts:12)")).toEqual([{ type: "file", label: "源码", path: "/Users/mino/app.ts:12" }]);
});

it("目录引用保留真实目标路径", () => {
  expect(parseMentionMarkdown(buildFileMentionMarkdown("src", "源码目录", "directory"))).toEqual([{ type: "directory", label: "源码目录", path: "./src/" }]);
});
