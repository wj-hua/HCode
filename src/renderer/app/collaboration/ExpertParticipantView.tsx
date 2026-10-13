// 单位专家的冻结报告和版本互审；原始模型产物保留供失败核对。
import type { ExpertParticipant, ExpertState } from "@hcode/shared/experts";
import { expertLabel } from "./expertPresentation";
import {ExpertProfileDetails} from "./ExpertProfileDetails";
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
  return (
    <article key={expert.id} className="rounded-lg border border-border p-3">
      <p className="font-medium">
        {label(expert.id)} · {STATUSES[expert.status]}
      </p>
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
      {expert.error ? (
        <p className="mt-2 whitespace-pre-wrap text-destructive">
          {expert.error}
        </p>
      ) : null}
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
    </article>
  );
}
