// 新并行任务各自持有代码状态；历史单候选沿用 Run.code，无重复持久化别名。
import type { CollaborationSnapshot, DeliverySnapshot } from './collaboration.js';
import type { CodeDeliveryState, CodeVersion } from './codeDelivery.js';
export function deliveryCode(run: CollaborationSnapshot, delivery: DeliverySnapshot) {
  return delivery.code ?? run.code;
}
export function codeCandidates(run: CollaborationSnapshot): {deliveryId?:string;code:CodeDeliveryState}[] {
  if (run.code) return [{code:run.code}];
  return run.deliveries.flatMap(delivery=>delivery.code?[{deliveryId:delivery.id,code:delivery.code}]:[]);
}
/** 版本只能定位到一个本次交付；不能让前端或模型指定任意目录。 */
export function candidateForVersion(run: CollaborationSnapshot, versionId: string) {
  const target=codeCandidates(run).find(entry=>entry.code.versions.some(version=>version.id===versionId));
  if(!target)throw new Error('候选版本不属于本次协作');
  const version=target.code.versions.find(version=>version.id===versionId)!;
  return {...target,version};
}
/** 使用同一代码/报告对象构造采纳视图，采纳结果仍回写原任务状态。 */
export function candidateSnapshot(run: CollaborationSnapshot, target: {deliveryId?:string;code:CodeDeliveryState;version?:CodeVersion}) {
  if(!target.deliveryId)return run;
  return {...run,code:target.code,deliveries:run.deliveries.filter(delivery=>delivery.id===target.deliveryId)};
}
export function assertCandidateScope(code: CodeDeliveryState, version: CodeVersion) {
  const outside=code.allowedPaths?version.changes.filter(change=>!code.allowedPaths!.includes(change.path)):[];
  if(outside.length)throw new Error(`候选含授权范围外变更：${outside.map(change=>change.path).join('、')}`);
}
