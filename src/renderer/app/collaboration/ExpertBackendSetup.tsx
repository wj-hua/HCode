// 专家后端与模型选择；Gemini 必须来自实时账号列表，不复用其他后端的模型字段。
import type {
  CollaborationCapabilities,
  CollaborationWorkerAgent,
} from "@hcode/shared/collaboration";
import type { ExpertSelection } from "@hcode/shared/experts";
import { AGENTS } from "@hcode/shared/agents";
const SELECT_CLASS =
  "min-w-0 rounded-md border border-border bg-background p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function ExpertBackendSetup({
  expert,
  capabilities,
  onChange,
}: {
  expert: ExpertSelection;
  capabilities: CollaborationCapabilities[];
  onChange(backend: ExpertSelection["backend"]): void;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      <label className="flex items-center gap-2">
        执行 AI
        <select
          className={SELECT_CLASS}
          value={expert.backend.agent}
          onChange={(event) =>
            onChange({
              agent: event.target.value as CollaborationWorkerAgent,
            })
          }
        >
          {(["claude", "codex", "agy"] as const).map((agent) => (
            <option
              key={agent}
              value={agent}
              disabled={
                !capabilities.find((entry) => entry.agent === agent)?.canExecute
              }
            >
              {agent === "agy" ? "Antigravity / Gemini" : AGENTS[agent].name}
            </option>
          ))}
        </select>
      </label>
      <details className="w-full text-ui-sm"><summary className="cursor-pointer">模型设置</summary><label className="mt-2 flex min-w-0 items-center gap-2">
        模型
        {expert.backend.agent === "agy" ? (
          <select
            required
            className={SELECT_CLASS}
            value={expert.backend.model ?? ""}
            onChange={(event) =>
              onChange({
                agent: "agy",
                model: event.target.value,
              })
            }
          >
            <option value="">选择账号可用 Gemini 模型</option>
            {capabilities
              .find((entry) => entry.agent === "agy")
              ?.models?.map((model) => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
          </select>
        ) : (
          <input
            className={SELECT_CLASS}
            value={expert.backend.model ?? ""}
            onChange={(event) =>
              onChange({
                agent: expert.backend.agent,
                ...(event.target.value.trim()
                  ? { model: event.target.value.trim() }
                  : {}),
              })
            }
            placeholder="留空使用 CLI 默认模型"
          />
        )}
      </label></details>
    </div>
  );
}
