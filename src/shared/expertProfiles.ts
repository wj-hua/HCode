// 本机专家组合与任务范围加载的可序列化契约；不携带源文件内容或执行权限。
export const EXPERT_PROFILE_LIMITS = {
  maxFileBytes: 256 * 1024,
  maxInstructionBytes: 128 * 1024,
  maxResourceBytes: 2 * 1024 * 1024,
  maxResources: 128,
} as const;
export interface ExpertFileRef {
  name: string;
  sourcePath: string;
  hash: string;
}
export interface ExpertResourceRef extends ExpertFileRef {
  skill: string;
}
export interface ExpertProfileSnapshot {
  role: string;
  hash: string;
  loading: "instruction";
  roles: ExpertFileRef[];
  skills: ExpertFileRef[];
  resources: ExpertResourceRef[];
  limitations: string[];
}
export interface ExpertProfilePreview extends ExpertProfileSnapshot {
  issues: string[];
}
export interface ExpertResourceRead {
  skill: string;
  path: string;
  hash: string;
  stage: "research" | "review";
  sessionKey: string;
}
export interface ExpertProfileLoad {
  hash: string;
  loading: "instruction";
  stage: "research" | "review";
  sessionKey: string;
}
export const BUSINESS_EXPERT_TYPES = [
  "ios",
  "android",
  "frontend",
  "java",
  "requirements",
  "design",
  "testing",
] as const;
export type BusinessExpertType = (typeof BUSINESS_EXPERT_TYPES)[number];
