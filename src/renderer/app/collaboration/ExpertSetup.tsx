// 专家角色和后端由用户配置；重复模型明确提示，Gemini 仅接受实时账号列表中的选择。
import type { CollaborationCapabilities } from "@hcode/shared/collaboration";
import {
  EXPERT_ROLES,
  expertMinimumTurns,
  type ExpertSelection,
  type ExpertRole,
} from "@hcode/shared/experts";
import {
  BUSINESS_EXPERT_TYPES,
  type ExpertProfilePreview,
} from "@hcode/shared/expertProfiles";
import { EXPERT_LIMITS } from "@hcode/shared/experts";
import { ExpertBackendSetup } from "./ExpertBackendSetup";
import { ExpertProfileDetails } from "./ExpertProfileDetails";
import { hasRepeatedExpertBackend } from "./expertPresentation";
export const DEFAULT_EXPERTS: ExpertSelection[] = [
  { role: "frontend", backend: { agent: "claude" } },
  { role: "java", backend: { agent: "codex" } },
  { role: "testing", backend: { agent: "agy" } },
];
const SELECT_CLASS =
  "min-w-0 rounded-md border border-border bg-background p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function ExpertSetup({
  experts,
  onChange,
  capabilities,
  profiles,
  turnLimit,
  onTurnLimit,
}: {
  experts: ExpertSelection[];
  onChange(value: ExpertSelection[]): void;
  capabilities: CollaborationCapabilities[];
  profiles?: ExpertProfilePreview[];
  turnLimit: number;
  onTurnLimit(value: number): void;
}) {
  const changeBackend = (
    role: ExpertRole,
    backend: ExpertSelection["backend"],
  ) =>
    onChange(
      experts.map((expert) =>
        expert.role === role ? { ...expert, backend } : expert,
      ),
    );
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 font-medium">专家配置 · 选择 2–7 位</legend>
      {BUSINESS_EXPERT_TYPES.map((type) => {
        const defaultExpert = DEFAULT_EXPERTS.find(
          (expert) => expert.role === type,
        ) ?? { role: type, backend: { agent: "claude" as const } };
        const profile = profiles?.find((entry) => entry.role === type);
        const expert = experts.find(
            (entry) => entry.role === defaultExpert.role,
          ),
          role = EXPERT_ROLES[defaultExpert.role];
        return (
          <div
            key={defaultExpert.role}
            className="rounded-lg border border-border p-3"
          >
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={Boolean(expert)}
                disabled={!expert && (!profile || profile.issues.length > 0)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...experts, defaultExpert]
                      : experts.filter(
                          (entry) => entry.role !== defaultExpert.role,
                        ),
                  )
                }
              />
              {role.name}
            </label>
            <p className="my-2 text-ui-sm text-foreground-subtle">
              {role.responsibility}
            </p>
            {profile ? (
              <ExpertProfileDetails profile={profile} />
            ) : (
              <p role="status">正在发现本机组合…</p>
            )}
            {profile?.issues.length ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {profile.issues.join("；")}
              </p>
            ) : null}
            {expert ? (
              <ExpertBackendSetup
                expert={expert}
                capabilities={capabilities}
                onChange={(backend) => changeBackend(expert.role, backend)}
              />
            ) : null}
          </div>
        );
      })}
      {hasRepeatedExpertBackend(experts) ? (
        <p role="status" className="text-ui-sm">
          部分专家使用相同后端和模型；这是不同角色视角，不能算独立模型证据。
        </p>
      ) : null}
      <label className="flex items-center gap-3">
        本次专家回合上限
        <input
          type="number"
          min={expertMinimumTurns(experts.length)}
          max={EXPERT_LIMITS.maxTurns}
          value={turnLimit}
          onChange={(event) => onTurnLimit(Number(event.target.value))}
          className={SELECT_CLASS}
        />
      </label>
      <p className="text-ui-sm text-foreground-subtle">
        独立研究 → 相关角色交叉审查 → 当前原会话汇总。基础需要{" "}
        {expertMinimumTurns(experts.length)} 回合，格式修正计入 {turnLimit}{" "}
        回合上限。只读源码，不联网、不运行测试。
      </p>
    </fieldset>
  );
}
