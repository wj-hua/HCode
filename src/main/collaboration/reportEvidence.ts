// 报告中的源码引用需与实际行内容匹配；固定 hash 让源文件变化显式失效。
import type { SourceEvidence } from "../../shared/collaboration.js";
import { readResearchFile } from "../sessions/researchRuntime.js";
import { reportSchema, parseModelJson } from "./contracts.js";

export async function validateReport(root: string, text: string) {
  const report = reportSchema.parse(parseModelJson(text));
  if (!report.findings.length) throw new Error("报告缺少可审查结论，需补上下文或证据");
  if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length) throw new Error("报告结论 id 重复");
  const evidence: SourceEvidence[] = [];
  for (const finding of report.findings) {
    if (!finding.evidence.length) throw new Error(`结论 ${finding.id} 缺少源码证据`);
    for (const entry of finding.evidence) {
      const file = await readResearchFile(root, entry.path);
      const lines = file.content.split(/\r?\n/);
      if (entry.endLine < entry.startLine || entry.endLine > lines.length) throw new Error(`证据行号无效：${entry.path}`);
      if (lines.slice(entry.startLine - 1, entry.endLine).join("\n").trim() !== entry.quote.trim()) throw new Error(`证据引用与源码不符：${entry.path}`);
      evidence.push({ ...entry, path: file.path, hash: file.hash });
    }
  }
  return { report, evidence };
}

export async function assertEvidenceCurrent(root: string, evidence: SourceEvidence[]) {
  for (const source of evidence) {
    if ((await readResearchFile(root, source.path)).hash !== source.hash) throw new Error(`源文件已变化，需要重新研究与审查：${source.path}`);
  }
}
