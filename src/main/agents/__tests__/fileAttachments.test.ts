import { describe, expect, it } from "vitest";
import type { FileInput } from "../../../shared/types.js";
import { extractFileReferences, withFileReferences } from "../fileAttachments.js";

const files: FileInput[] = [
  { path: "/Users/me/demo.mp4", name: "demo.mp4", mimeType: "video/mp4", size: 1024 },
  { path: "/tmp/带空格 的文件.pdf", name: "带空格 的文件.pdf", mimeType: "application/pdf", size: 7 },
];

describe("withFileReferences / extractFileReferences", () => {
  it("没有附件时原样返回", () => {
    expect(withFileReferences("hello", [])).toBe("hello");
    expect(extractFileReferences("hello")).toEqual({ text: "hello", files: [] });
  });

  it("附件清单可以从 prompt 还原", () => {
    const prompt = withFileReferences("看看这两个文件", files);
    expect(prompt).toContain("/Users/me/demo.mp4");
    expect(extractFileReferences(prompt)).toEqual({ text: "看看这两个文件", files });
  });

  it("只有附件、没有文字时也能还原", () => {
    const prompt = withFileReferences("  ", files);
    expect(extractFileReferences(prompt)).toEqual({ text: "", files });
  });

  it("正文里恰好出现清单标题但不在末尾分段处时不误判", () => {
    const text = "引用：附件文件（本机绝对路径，请按需读取或分析）：\n- 不是 JSON";
    expect(extractFileReferences(text)).toEqual({ text, files: [] });
  });

  it("清单行不是合法 JSON 或缺字段时整体放弃还原", () => {
    const valid = withFileReferences("x", files.slice(0, 1));
    const broken = valid.replace('"size":1024', '"size":"1024"');
    expect(extractFileReferences(broken)).toEqual({ text: broken, files: [] });
    const notJson = `${valid}\n- {oops`;
    expect(extractFileReferences(notJson)).toEqual({ text: notJson, files: [] });
  });
});
