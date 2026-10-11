// 专家模型输出仅允许一次有界格式/引用修正；原文保留，终态不成功则不解析产物。
import type { TurnOutcome } from "../../../shared/collaboration.js";
import { EXPERT_LIMITS } from "../../../shared/experts.js";
import { MAX_REPORT_BYTES, parseModelJson } from "../contracts.js";
const TRUNCATED_RAW_NOTICE = "\n[模型原文超过保存上限，已截断]";
export class ExpertNeedsInput extends Error {}
export async function expertTurn<T>(
  send: (correction?: string) => Promise<TurnOutcome>,
  validate: (input: unknown) => Promise<T>,
  raw: string[],
  changed: () => Promise<void>,
): Promise<T> {
  let correction: string | undefined;
  for (
    let attempt = 0;
    attempt <= EXPERT_LIMITS.maxFormatCorrections;
    attempt++
  ) {
    const result = await send(correction);
    raw.push(
      result.text.length > MAX_REPORT_BYTES
        ? result.text.slice(0, MAX_REPORT_BYTES) + TRUNCATED_RAW_NOTICE
        : result.text,
    );
    await changed();
    if (result.outcome !== "succeeded")
      throw new Error(result.error ?? `原生回合 ${result.outcome}`);
    try {
      return await validate(parseModelJson(result.text));
    } catch (error) {
      if (attempt === EXPERT_LIMITS.maxFormatCorrections) throw error;
      correction = `上次产物未通过宿主校验：${error instanceof Error ? error.message : String(error)}。仅修正格式、claim 覆盖或准确引用，不扩大任务/权限，不添加命令或写入。quote 必须在 JSON 解码后与实际源码行一致；不要用字面量反斜杠 n 代替换行。不确定时重新 read_file 核对，并优先引用完整单行。这是最后一次格式修正。`;
    }
  }
  throw new Error("专家格式校验没有产生结果");
}
