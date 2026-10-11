// 主持汇总保留共识、分歧与未验证项；每条引用打开其真实冻结报告。
import type {
  ExpertState,
  ExpertConclusion,
  ExpertClaimRef,
} from "@hcode/shared/experts";
import { expertLabel } from "./expertPresentation";

import { Button } from "@/components/ui/button.js";
export function ExpertSummaryView({
  state,
  reading,
  openReport,
}: {
  state: ExpertState;
  reading: boolean;
  openReport(versionId: string, name: string): Promise<void>;
}) {
  const summary = state.summary;
  if (!summary) return null;
  const label = (id: string) => expertLabel(state, id);
  const reference = (ref: ExpertClaimRef) =>
    `${label(ref.expertId)} · v${state.participants.find((expert) => expert.id === ref.expertId)!.versions.find((version) => version.id === ref.versionId)!.version} · ${ref.claimId}`;
  const conclusions = (title: string, entries: ExpertConclusion[]) => (
    <section className="mt-3">
      <p className="font-medium">{title}</p>
      {entries.length ? (
        entries.map((entry, index) => (
          <div key={index} className="mt-2 border-l-2 border-border pl-3">
            <p className="whitespace-pre-wrap">{entry.statement}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {entry.sources.map((ref, refIndex) => (
                <Button
                  key={refIndex}
                  variant="outline"
                  disabled={reading}
                  onClick={() => void openReport(ref.versionId, reference(ref))}
                >
                  {reference(ref)}
                </Button>
              ))}
            </div>
          </div>
        ))
      ) : (
        <p className="mt-1 text-foreground-subtle">无</p>
      )}
    </section>
  );
  return (
    <section className="rounded-lg border border-border p-3">
      <p className="font-medium">当前会话的汇总</p>
      <p className="mt-2 whitespace-pre-wrap">{summary.summary}</p>
      {conclusions("经互审支持的共识", summary.consensus)}
      {conclusions("未解决分歧", summary.disagreements)}
      {conclusions("证据不足与未验证事项", summary.unverified)}
      <p className="mt-3 font-medium">局限</p>
      <ul className="mt-2 list-disc pl-5">
        {summary.limitations.map((limit, index) => (
          <li key={index}>{limit}</li>
        ))}
      </ul>
      {summary.failedExperts.length ? (
        <p className="mt-2">
          未参与本轮互审：{summary.failedExperts.map(label).join("、")}
        </p>
      ) : null}
    </section>
  );
}
