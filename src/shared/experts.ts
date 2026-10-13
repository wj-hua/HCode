// 专家研究的公开角色、启动配置与冻结产物关系；不包含模型执行细节。
import type {
  CollaborationBackend,
  CollaborationStartParams,
  ReportVersion,
} from "./collaboration.js";
import type {
  ExpertProfileSnapshot,
  ExpertResourceRead,
  ExpertProfileLoad,
} from "./expertProfiles.js";
export const EXPERT_ROLES = {
  ios: {
    name: "iOS 专家",
    responsibility: "核对 iOS 实现、生命周期、并发、接口、交互及设备验证缺口。",
  },
  android: {
    name: "安卓专家",
    responsibility: "核对安卓实现、生命周期、权限、弱网、状态恢复及设备差异。",
  },
  frontend: {
    name: "前端专家",
    responsibility: "核对组件、业务状态、接口、响应式、键盘路径及性能证据。",
  },
  java: {
    name: "Java 服务端专家",
    responsibility: "核对服务契约、业务分层、事务、幂等、鉴权及失败语义。",
  },
  requirements: {
    name: "需求调研专家",
    responsibility: "核对场景、需求证据、假设、范围、验收标准及待决策项。",
  },
  design: {
    name: "UI 设计专家",
    responsibility: "核对信息层级、平台惯例、用户路径、交互状态和无障碍。",
  },
  testing: {
    name: "测试专家",
    responsibility: "核对风险、验收、自动化路径、无障碍及未执行的验证。",
  },
  architecture: {
    name: "架构专家",
    responsibility: "检查模块职责、边界、耦合与方案取舍，区分现状和建议。",
  },
  implementation: {
    name: "实现专家",
    responsibility: "核对真实实现、数据流、语言语义、失败与边界行为。",
  },
  quality: {
    name: "验证专家",
    responsibility:
      "核对证据、测试覆盖、可复现方法和未执行的验证，不伪造测试结果。",
  },
} as const;
export type ExpertRole = keyof typeof EXPERT_ROLES;
export const EXPERT_LIMITS = {
  minParticipants: 2,
  maxParticipants: 7,
  maxTurns: 32,
  defaultProfileTurns: 24,
  maxFormatCorrections: 1,
  sourceTurns: 2,
  turnsPerParticipant: 2,
} as const;
/** 当前会话规划/汇总各一轮，每位专家研究和受审各一轮；不计可选格式修正。 */
export function expertMinimumTurns(participantCount: number) {
  return (
    EXPERT_LIMITS.sourceTurns +
    participantCount * EXPERT_LIMITS.turnsPerParticipant
  );
}
export interface ExpertSelection {
  role: ExpertRole;
  backend: CollaborationBackend;
  profileHash?: string;
  objective?: string;
}
export interface ExpertStartParams extends Pick<
  CollaborationStartParams,
  "initiator" | "objective"
> {
  mode: "experts";
  experts: ExpertSelection[];
  turnLimit?: number;
  acceptProfileLimitations?: boolean;
}
export interface ExpertParticipant extends ExpertSelection {
  id: string;
  sessionKey: string;
  status: "queued" | "researching" | "reported" | "failed" | "interrupted";
  versions: ReportVersion[];
  profile?: ExpertProfileSnapshot;
  profileLoads?: ExpertProfileLoad[];
  resourceReads?: ExpertResourceRead[];
  error?: string;
  rawResults: string[];
}
export interface PeerClaim {
  claimId: string;
  assessment: "supported" | "disputed" | "insufficientEvidence";
  reason: string;
  evidence: ReportVersion["evidence"][number][];
}
export interface PeerReview {
  id: string;
  targetId: string;
  versionId: string;
  versionHash: string;
  reviewerId: string;
  sessionKey: string;
  nativeSessionId?: string;
  status: "queued" | "reviewing" | "completed" | "failed" | "interrupted";
  summary?: string;
  claims?: PeerClaim[];
  limitations?: string[];
  error?: string;
  rawResults: string[];
  assignment?: "domain" | "evidence";
}
export interface ExpertClaimRef {
  expertId: string;
  versionId: string;
  claimId: string;
}
export interface ExpertConclusion {
  statement: string;
  sources: ExpertClaimRef[];
}
export interface ExpertSummary {
  summary: string;
  consensus: ExpertConclusion[];
  disagreements: ExpertConclusion[];
  unverified: ExpertConclusion[];
  limitations: string[];
  failedExperts: string[];
}
export interface ExpertState {
  participants: ExpertParticipant[];
  reviews: PeerReview[];
  contextHash?: string;
  activeIds: string[];
  partialAuthorized: boolean;
  summary?: ExpertSummary;
  rawSummaries: string[];
  turnLimit?: number;
}
export interface ExpertResumeParams {
  action: "research" | "review" | "continuePartial";
  expertId?: string;
}
