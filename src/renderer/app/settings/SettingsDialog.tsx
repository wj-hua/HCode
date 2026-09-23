import { useEffect, useState } from "react";
import type { Settings } from "@hcode/shared/types";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { MODEL_OPTIONS, PERMISSION_MODES } from "../composer/Composer";
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

export function SettingsDialog() {
  const open = useAppStore((state) => state.settingsOpen);
  const setOpen = useAppStore((state) => state.setSettingsOpen);
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const agentStatus = useAppStore((state) => state.agentStatus);
  const [claudePath, setClaudePath] = useState(settings.claudePath);

  useEffect(() => {
    if (open) setClaudePath(settings.claudePath);
  }, [open, settings.claudePath]);

  const update = (patch: Partial<Settings>) => void updateSettings(patch);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>HCode 的外观与 Claude Code 默认行为</DialogDescription>
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
          <Row label="默认权限模式" hint="新会话使用的权限模式">
            <select
              value={settings.defaultPermissionMode}
              onChange={(event) =>
                update({ defaultPermissionMode: event.target.value as Settings["defaultPermissionMode"] })
              }
              className="h-8 rounded-lg border border-input-border bg-input px-2 text-ui-base text-foreground"
            >
              {PERMISSION_MODES.map((item) => (
                <option key={item.mode} value={item.mode}>
                  {item.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="默认模型">
            <select
              value={settings.defaultModel}
              onChange={(event) => update({ defaultModel: event.target.value })}
              className="h-8 rounded-lg border border-input-border bg-input px-2 text-ui-base text-foreground"
            >
              {MODEL_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Row>
          <div className="flex flex-col gap-2 py-3">
            <div className="flex flex-col">
              <span className="text-ui-base text-foreground">Claude Code 路径</span>
              <span className="text-ui-sm text-foreground-subtle">
                留空则自动查找。当前：
                {agentStatus?.found ? `${agentStatus.path}（${agentStatus.version ?? "未知版本"}）` : "未找到"}
              </span>
            </div>
            <div className="flex gap-2">
              <input
                value={claudePath}
                onChange={(event) => setClaudePath(event.target.value)}
                placeholder="例如 /Users/you/.local/bin/claude"
                className="h-8 min-w-0 flex-1 rounded-lg border border-input-border bg-input px-2.5 font-mono text-ui-sm text-foreground outline-none focus:border-input-border-focused"
              />
              <Button variant="outline" size="lg" onClick={() => update({ claudePath: claudePath.trim() })}>
                保存并检测
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
