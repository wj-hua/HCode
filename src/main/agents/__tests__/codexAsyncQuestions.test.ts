// 通过真实实时投影和历史重建验证 Codex 异步问题的身份、可答状态和原生回复格式。
import { expect, it } from "vitest";
import { CodexRowProjector, projectCodexTurns, type CodexItem } from "../codex/codexProjector.js";
import { pendingAsyncQuestions, encodeAsyncReply } from "../../../shared/codexAsyncQuestions.js";

const item: CodexItem = { id: "call-1", type: "agentMessage", delivery: "async", text: "如何处理？",
  questions: [{ title: "提交吗？", options: ["提交", "保留"] }, { title: "补充说明", options: null }] };

it("提问在回合中可答，结束后仍可答，原生回复仅关闭对应问题", () => {
  const projector = new CodexRowProjector();
  projector.beginLocalTurn("开始", 1);
  projector.itemStarted(item, 2);
  projector.itemCompleted(item, 3);
  projector.finishTurn({ status: "completed" }, 4);
  const questions = pendingAsyncQuestions(projector.snapshot());
  expect(questions.map(question => question.title)).toEqual(["提交吗？", "补充说明"]);
  const text = encodeAsyncReply(questions[0]!, "保留");
  expect(text).toBe('<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call-1\\",0]","question":"提交吗？","answer":"保留"}]\n</send_user_message_question_reply>');
  const rows = projectCodexTurns([{ id: "turn", status: "completed", items: [item,
    { id: "reply", type: "userMessage", content: [{ type: "text", text }] },
  ] }]).snapshot();
  expect(pendingAsyncQuestions(rows).map(question => question.title)).toEqual(["补充说明"]);
});

it("普通列表、异步通知和无效题目不会生成可点击选项", () => {
  const projector = new CodexRowProjector();
  for (const message of [{ ...item, delivery: undefined }, { ...item, id: "notice", questions: [] },
    { ...item, id: "bad", questions: [{ title: "", options: [] }] }]) projector.itemCompleted(message, 1);
  expect(pendingAsyncQuestions(projector.snapshot())).toEqual([]);
});
