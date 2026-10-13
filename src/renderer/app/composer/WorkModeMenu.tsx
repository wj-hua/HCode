// 统一工作方式入口；选择方式只更新界面，同题对比的参与者与协作分工分开配置。
import { ChevronDownIcon } from "lucide-react";
import { AGENT_KINDS, AGENTS } from "@hcode/shared/agents";
import type { AgentKind, AgentStatus } from "@hcode/shared/types";
import { Button } from "@/components/ui/button.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuLabel, DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu.js";
import { WORK_MODES, type WorkMode } from "./workMode";

export function WorkModeMenu({ mode, onMode, agent, agents, statuses, onCompare, onClose }: {
  mode: WorkMode; onMode(mode: WorkMode): void; agent: AgentKind; agents: AgentKind[];
  statuses?: AgentStatus[]; onCompare(agent: AgentKind, checked: boolean): void; onClose(event: Event): void;
}) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="sm" aria-label={`工作方式：${WORK_MODES[mode].label}`} className="h-7 gap-1 rounded-lg px-2 text-ui-base focus-visible:ring-2 focus-visible:ring-ring active:brightness-90">{WORK_MODES[mode].label}<ChevronDownIcon className="size-3.5" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" className="w-80" onCloseAutoFocus={onClose}>
      <DropdownMenuLabel>工作方式</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={mode} onValueChange={value => onMode(value as WorkMode)}>
        {Object.entries(WORK_MODES).map(([value, entry]) => <DropdownMenuRadioItem key={value} value={value} className="items-start py-2"><span className="flex flex-col gap-1"><span>{entry.label}</span><span className="text-ui-sm text-foreground-subtle">{entry.description}</span></span></DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      {mode === "compare" ? <><DropdownMenuLabel>对比 AI（独立回答，不自动互审）</DropdownMenuLabel>{AGENT_KINDS.filter(kind => kind !== agent).map(kind => <DropdownMenuCheckboxItem key={kind} checked={agents.includes(kind)} disabled={statuses?.some(status => status.kind === kind && !status.found)} onSelect={event => event.preventDefault()} onCheckedChange={checked => onCompare(kind, checked === true)}>{AGENTS[kind].name}</DropdownMenuCheckboxItem>)}</> : null}
    </DropdownMenuContent>
  </DropdownMenu>;
}
