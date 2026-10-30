// 图片坐标说明属于 Claude 运行时上下文；通过公开投影入口验证气泡、附件和回合归属。
import { describe, expect, it } from "vitest";
import { ClaudeRowProjector, projectHistory, type ClaudeRecord } from "../claude/rowProjector.js";
import { ofKind, RowsMirror } from "./helpers.js";

const IMAGE_METADATA = "[Image: original 2932x1696, displayed at 2000x1157. Multiply coordinates by 1.47 to map to original image.]";
const SOURCE_IMAGE_METADATA = "[Image: source: /tmp/screen shot.png, original 1206x2622, displayed at 920x2000. Multiply coordinates by 1.31 to map to original image.]";
const IMAGE_BLOCK = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };

function user(content: unknown, uuid = "user"): ClaudeRecord {
  return { type: "user", uuid, message: { role: "user", content } };
}

describe("Claude 图片坐标提示", () => {
  it.each([IMAGE_METADATA, SOURCE_IMAGE_METADATA, ` \n${IMAGE_METADATA}\n `])("没有 meta 标记的独立提示不创建气泡或回合：%s", (text) => {
    expect(projectHistory([user(text)]).snapshot()).toEqual([]);
    expect(projectHistory([user([{ type: "text", text }])]).snapshot()).toEqual([]);
  });

  it("实时读图后的两条提示不截断回合，工具结果和后续回复仍归属原用户输入", () => {
    const projector = new ClaudeRowProjector();
    const mirror = new RowsMirror(projector);
    projector.consume(user("检查这两张截图", "original-turn"));
    projector.consume({ type: "assistant", message: { content: [
      { type: "tool_use", id: "read-first", name: "Read", input: { file_path: "/tmp/first.png" } },
      { type: "tool_use", id: "read-second", name: "Read", input: { file_path: "/tmp/second.png" } },
    ] } });
    mirror.flush();

    for (const toolId of ["read-first", "read-second"]) {
      projector.consume(user([{ type: "tool_result", tool_use_id: toolId, content: [IMAGE_BLOCK] }]));
      projector.consume(user(IMAGE_METADATA, `metadata-${toolId}`));
      mirror.flush();
    }
    projector.consume({ type: "assistant", message: { content: [{ type: "text", text: "截图已检查" }] } });
    projector.consume({ type: "result", subtype: "success" });
    const rows = mirror.flush();

    expect(ofKind(rows, "userInput").map(row => row.text)).toEqual(["检查这两张截图"]);
    expect(ofKind(rows, "turnHeader")).toHaveLength(1);
    expect(ofKind(rows, "toolCall").map(row => row.status)).toEqual(["success", "success"]);
    expect(ofKind(rows, "assistantText")[0]).toMatchObject({ text: "截图已检查", turnId: "original-turn" });
    expect(new Set(rows.map(row => row.turnId))).toEqual(new Set(["original-turn"]));
    expect(rows).toEqual(projector.snapshot());
  });

  it.each(["看这张图", ""])("过滤独立提示块时保留图片和用户正文：%s", (text) => {
    const rows = projectHistory([user([
      { type: "text", text: IMAGE_METADATA },
      IMAGE_BLOCK,
      { type: "text", text },
      { type: "text", text: SOURCE_IMAGE_METADATA },
    ])]).snapshot();
    expect(ofKind(rows, "userInput")).toHaveLength(1);
    expect(ofKind(rows, "userInput")[0]).toMatchObject({
      text,
      attachments: [{ ref: "data:image/png;base64,iVBORw0KGgo=", fileName: "图片", mime: "image/png", bytes: 9 }],
    });
  });

  it.each([
    "[Image: 这是用户写的图片说明]",
    `这段是什么意思：${IMAGE_METADATA}`,
    `${IMAGE_METADATA}\n请解释这段提示`,
  ])("保留普通图片说明和用户引用的提示：%s", (text) => {
    const rows = projectHistory([user(text)]).snapshot();
    expect(ofKind(rows, "userInput")[0]?.text).toBe(text);
  });
});
