// 从两份清单推导累计差异，冻结与采纳使用同一规则，拒绝伪造差异范围。
import type { CandidateChange } from "../../../shared/codeDelivery.js";
import type { FileManifest } from "./fileManifest.js";
export function candidateChanges(
  baseline: FileManifest,
  current: FileManifest,
): CandidateChange[] {
  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const after = new Map(current.entries.map((entry) => [entry.path, entry]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((path) => {
      const old = before.get(path),
        next = after.get(path);
      if (old?.hash === next?.hash && old?.mode === next?.mode) return [];
      return [
        {
          path,
          kind: !old
            ? ("added" as const)
            : !next
              ? ("deleted" as const)
              : ("modified" as const),
          binary: Boolean(
            old?.binary || next?.binary || old?.link || next?.link,
          ),
          ...(old ? { beforeHash: old.hash, beforeMode: old.mode } : {}),
          ...(next ? { afterHash: next.hash, afterMode: next.mode } : {}),
        },
      ];
    });
}
