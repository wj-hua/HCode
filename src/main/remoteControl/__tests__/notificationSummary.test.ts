import { expect, it } from "vitest";
import type { ConversationRow } from "../../../shared/types.js";
import { replySummary, SUMMARY_MAX_LENGTH } from "../notificationSummary.js";

let rowId = 0;
const base = () => ({ rowId: ++rowId, turnId: "t", createdAt: 1, createdAtSeq: rowId });
const user = (text: string) => ({ ...base(), kind: "userInput", text }) as ConversationRow;
const reply = (text: string) => ({ ...base(), kind: "assistantText", text, state: "complete" }) as ConversationRow;
const tool = () => ({ ...base(), kind: "toolCall" }) as unknown as ConversationRow;

it("取本轮最后一条回复，去掉 Markdown 标记、代码块和表格", () => {
  const text = [
    "## 结论", "", "已定位：**隧道带宽**受限于 [服务器](https://example.com) 出口。", "",
    "```ts", "const secret = 1;", "```", "| 项 | 值 |", "|---|---|", "- 改为按需加载 `rows`",
  ].join("\n");
  expect(replySummary([user("旧问题"), reply("上一轮回复"), user("查查看"), reply("先看看"), tool(), reply(text)]))
    .toBe("结论 已定位：隧道带宽受限于 服务器 出口。 改为按需加载 rows");
});

it("超长回复按句子截取开头几句；第一句就超长时截断并补省略号", () => {
  const sentence = "这是一句二十个字左右的完成说明文字。";
  const summary = replySummary([user("q"), reply(sentence.repeat(20))])!;
  expect(Array.from(summary).length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH);
  expect(summary.endsWith("。")).toBe(true);
  const long = replySummary([user("q"), reply("长".repeat(300))])!;
  expect(Array.from(long)).toHaveLength(SUMMARY_MAX_LENGTH);
  expect(long.endsWith("…")).toBe(true);
});

it("本轮没有回复时不拿上一轮内容冒充", () => {
  expect(replySummary([user("q1"), reply("上一轮"), user("q2"), tool()])).toBeUndefined();
  expect(replySummary([user("q"), reply("```\nonly code\n```")])).toBeUndefined();
  expect(replySummary([])).toBeUndefined();
});
