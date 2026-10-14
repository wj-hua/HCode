// 每位专家的身份、状态和最新报告常驻可见；任务、版本互审和原始产物按需展开。
import type { ExpertParticipant, ExpertState } from "@hcode/shared/experts";
import { expertLabel } from "./expertPresentation";
import { ExpertProfileDetails } from "./ExpertProfileDetails";
import { PeerReviewView } from "./PeerReviewView";

import { Button } from "@/components/ui/button.js";
const STATUSES = {
  queued: "排队",
  researching: "独立研究中",
  reported: "报告已冻结",
  failed: "失败",
  interrupted: "已中断",
};
export function ExpertParticipantView({
  expert,
  state,
  reading,
  openReport,
}: {
  expert: ExpertParticipant;
  state: ExpertState;
  reading: boolean;
  openReport(versionId: string, name: string): Promise<void>;
}) {
  const label = (id: string) => expertLabel(state, id);
  const latest = expert.versions.at(-1);
  return (
    <article aria-label={label(expert.id)} className="p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1"><h3 className="font-medium">{label(expert.id)}</h3>
          <p className="mt-1 text-ui-sm text-foreground-subtle">{STATUSES[expert.status]} · {latest ? `最新报告 v${latest.version}` : '尚无冻结报告'}</p></div>
        {latest ? <Button variant="outline" size="sm" disabled={reading} aria-label={`查看${label(expert.id)}的报告 v${latest.version}`} onClick={() => void openReport(latest.id, `${label(expert.id)} · v${latest.version}`)}>查看报告 v{latest.version}</Button> : null}
      </header>
      {expert.error ? <p role="alert" className="mt-2 whitespace-pre-wrap text-ui-sm text-destructive">{expert.error}</p> : null}
      <details className="mt-2">
        <summary className="cursor-pointer py-1 text-ui-sm text-foreground-subtle">任务、报告版本与互审详情</summary>
      {expert.objective ? <p className="mt-2 whitespace-pre-wrap text-ui-sm">本次任务：{expert.objective}</p> : null}
      <p className="mt-1 break-all text-ui-sm text-foreground-subtle">
        模型：{expert.backend.model ?? "CLI 默认（未核对具体模型）"}
      </p>
      {expert.profile?<ExpertProfileDetails profile={expert.profile} loads={expert.profileLoads} reads={expert.resourceReads}/>:null}
      <div className="mt-2 flex flex-wrap gap-2">
        {expert.versions.map((version) => (
          <Button
            key={version.id}
            variant="outline"
            disabled={reading}
            onClick={() =>
              void openReport(
                version.id,
                `${label(expert.id)} · v${version.version}`,
              )
            }
          >
            查看独立报告 v{version.version}
          </Button>
        ))}
      </div>
      {state.reviews
        .filter((review) => review.targetId === expert.id)
        .map((review) => (
          <PeerReviewView
            key={review.id}
            review={review}
            reviewer={label(review.reviewerId)}
            version={
              expert.versions.find(
                (version) => version.id === review.versionId,
              )!.version
            }
          />
        ))}
      {expert.rawResults.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-ui-sm">
            模型产物原文（含格式修正，{expert.rawResults.length} 份）
          </summary>
          {expert.rawResults.map((raw, index) => (
            <pre
              key={index}
              className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface p-2 text-ui-sm"
            >
              {raw}
            </pre>
          ))}
        </details>
      ) : null}
      </details>
    </article>
  );
}
