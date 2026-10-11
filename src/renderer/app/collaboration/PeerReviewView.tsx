// 逐条显示指定版本的支持、分歧和证据不足；源码引用保留宿主校验 hash。
import type { PeerReview } from "@hcode/shared/experts";
const STATUS_LABELS = {
  queued: "排队",
  reviewing: "审查中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};
const ASSESSMENTS = {
  supported: "有证据支持",
  disputed: "存在分歧",
  insufficientEvidence: "证据不足",
};
export function PeerReviewView({
  review,
  reviewer,
  version,
}: {
  review: PeerReview;
  reviewer: string;
  version: number;
}) {
  return (
    <details
      className="mt-3"
      open={
        review.status === "failed" ||
        review.claims?.some((claim) => claim.assessment !== "supported")
      }
    >
      <summary className="cursor-pointer">
        {reviewer} 审查 v{version} · {STATUS_LABELS[review.status]}
      </summary>
      {review.assignment?<p className="text-ui-sm">{review.assignment==="domain"?"相关领域交叉核对":"通用证据审查，未完成领域专项验证"}</p>:null}
      <p className="mt-2 whitespace-pre-wrap">
        {review.summary ?? review.error}
      </p>
      {review.claims?.map((claim) => (
        <div key={claim.claimId} className="mt-2 border-l-2 border-border pl-3">
          <p className="font-medium">
            {claim.claimId} · {ASSESSMENTS[claim.assessment]}
          </p>
          <p className="whitespace-pre-wrap">{claim.reason}</p>
          {claim.evidence.map((evidence, index) => (
            <details key={index} className="mt-1">
              <summary className="cursor-pointer break-all">
                核对源码证据 · {evidence.path}:{evidence.startLine}–
                {evidence.endLine}
              </summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-surface p-2">
                {evidence.quote}
              </pre>
              <p className="break-all text-ui-sm text-foreground-subtle">
                源码 SHA-256：{evidence.hash}
              </p>
            </details>
          ))}
        </div>
      ))}
      {review.rawResults.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-ui-sm">
            互审产物原文（含格式修正，{review.rawResults.length} 份）
          </summary>
          {review.rawResults.map((raw, index) => (
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
  );
}
