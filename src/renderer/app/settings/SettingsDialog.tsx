import { useEffect, useState } from "react";
import type { AgentKind, Settings } from "@hcode/shared/types";
import { AGENT_KINDS, AGENTS } from "@hcode/shared/agents";
import { AgentBadge } from "../AgentBadge";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useAppStore } from "../store/appStore";

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-3 py-1 text-ui-base transition-colors",
            option.value === value
              ? "bg-background text-foreground shadow-sm"
              : "text-foreground-subtle hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-ui-base text-foreground">{label}</span>
        {hint ? <span className="text-ui-sm text-foreground-subtle">{hint}</span> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function AgentSection({ kind }: { kind: AgentKind }) {
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const status = useAppStore((state) => state.agentStatuses?.find((item) => item.kind === kind));
  const models = useAppStore((state) => state.models[kind]) ?? AGENTS[kind].models;
  const loadModels = useAppStore((state) => state.loadModels);
  const open = useAppStore((state) => state.settingsOpen);
  const [path, setPath] = useState(settings.agentPaths[kind]);
  const agent = AGENTS[kind];

  useEffect(() => {
    if (open) {
      setPath(settings.agentPaths[kind]);
      void loadModels(kind);
    }
  }, [open, kind, settings.agentPaths, loadModels]);

  return (
    <div className="flex flex-col py-2">
      <div className="flex items-center gap-2 pt-2 text-ui-base font-medium text-foreground">
        <AgentBadge agent={kind} className={status?.found === false ? "opacity-40" : ""} />
        {agent.name}
        <span className="ml-auto text-ui-sm font-normal text-foreground-subtle">
          {!status ? "正在检测…" : status.found ? (status.version ? `版本 ${status.version}` : "未知版本") : "未安装"}
        </span>
      </div>
      <Row label="默认权限模式">
        <select
          value={settings.defaultPermissionModes[kind]}
          onChange={(event) =>
            void updateSettings({
              defaultPermissionModes: { ...settings.defaultPermissionModes, [kind]: event.target.value },
            })
          }
          className="h-8 rounded-lg border border-input-border bg-input px-2 text-ui-base text-foreground"
        >
          {agent.permissionModes.map((item) => (
            <option key={item.mode} value={item.mode}>
              {item.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="默认模型">
        <select
          value={settings.defaultModels[kind]}
          onChange={(event) =>
            void updateSettings({ defaultModels: { ...settings.defaultModels, [kind]: event.target.value } })
          }
          className="h-8 max-w-56 rounded-lg border border-input-border bg-input px-2 text-ui-base text-foreground"
        >
          {models.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </Row>
      <div className="flex flex-col gap-2 py-2">
        <span className="text-ui-sm text-foreground-subtle">
          {agent.command} 路径（留空自动查找）。当前：
          {status?.found ? status.path : "未找到"}
        </span>
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={`例如 /Users/you/.local/bin/${agent.command}`}
            className="h-8 min-w-0 flex-1 rounded-lg border border-input-border bg-input px-2.5 font-mono text-ui-sm text-foreground outline-none focus:border-input-border-focused"
          />
          <Button
            variant="outline"
            size="lg"
            onClick={() => void updateSettings({ agentPaths: { ...settings.agentPaths, [kind]: path.trim() } })}
          >
            保存并检测
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const open = useAppStore((state) => state.settingsOpen);
  const setOpen = useAppStore((state) => state.setSettingsOpen);
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);

  const update = (patch: Partial<Settings>) => void updateSettings(patch);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>HCode 的外观与各 CLI 的默认行为</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col divide-y divide-border/60">
          <Row label="主题">
            <Segmented
              value={settings.theme}
              options={[
                { value: "system", label: "跟随系统" },
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
              ]}
              onChange={(theme) => update({ theme })}
            />
          </Row>
          <Row label="界面语言" hint="影响卡片等内置文案">
            <Segmented
              value={settings.locale}
              options={[
                { value: "zh-CN", label: "中文" },
                { value: "en-US", label: "English" },
              ]}
              onChange={(locale) => update({ locale })}
            />
          </Row>
          <Row label="新会话默认 CLI">
            <Segmented
              value={settings.defaultAgent}
              options={AGENT_KINDS.map((kind) => ({ value: kind, label: AGENTS[kind].name }))}
              onChange={(defaultAgent) => update({ defaultAgent })}
            />
          </Row>
          {AGENT_KINDS.map((kind) => (
            <AgentSection key={kind} kind={kind} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
